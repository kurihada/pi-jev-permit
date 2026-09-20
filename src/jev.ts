/**
 * pi-jev-permit / jev.ts — core: the **single** place that makes network requests.
 *
 * Both access methods share one parser (the response bodies have the same shape):
 *   - `systemone`  -> `POST {baseUrl}/v1/systemone` (official TypeSafe)
 *   - `decisions`  -> `POST {baseUrl}/api/alpha/decisions` (the OpenRouter contract; the company gateway uses this one)
 *
 * This layer also does the metering (request count / tokens / estimated spend) and the decision
 * log. Consumers (the gate / jev_evaluate / the advisor) only talk through createJevClient().ask().
 *
 * Three hard constraints (the parts upstream got right, plus lessons from today):
 *   1. **No answer is not a "yes"**: a question key that was asked but not answered is a failure,
 *      never a default.
 *   2. Only state and questions are sent; **file contents / diffs are never sent** (guaranteed by
 *      the caller; this layer does not relax it).
 *   3. Caller cancellation is control flow (rethrow); timeout / network / HTTP / bad shape are all failures.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODEL_BY_PROTOCOL, type Protocol, protocolPath } from "./config.ts";

// ---------------------------------------------------------------- JSON boundary

export type JevJson = string | number | boolean | null | JevJson[] | JevJsonObject;

export interface JevJsonObject {
  [key: string]: JevJson;
}

function isJsonRecord(value: unknown): value is JevJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- Requests / results

export type JevEntry = string | JevJsonObject | JevJson[] | null;

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions?: JevEntry;
  readonly criteria?: { readonly true?: JevEntry; readonly false?: JevEntry } | null;
}

export interface JevState {
  readonly value: JevJson;
  readonly context?: JevJson;
}

export interface AskRequest {
  readonly state: JevState;
  readonly questions: Record<string, NoulQuestion>;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export type UnavailableReason =
  | "timeout"
  | "network"
  | "http"
  | "malformed_response"
  | "state_too_large"
  | "cancelled"
  | "unknown";

/** `budget_exceeded` is this package's own code: an exhausted quota is not "Jev is down", so the status bar must say which one it is */
export type AskFailureReason = UnavailableReason | "budget_exceeded";

export interface AskSuccess {
  readonly ok: true;
  readonly answers: Record<string, number>;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
  readonly latencyMs: number;
}

export interface AskFailure {
  readonly ok: false;
  readonly reason: AskFailureReason;
  readonly detail: string;
  readonly status?: number;
  readonly latencyMs: number;
}

export type AskResult = AskSuccess | AskFailure;

/**
 * The default criteria. **More important than it looks**: a noul has no confidence field, so the
 * probability is the only signal. Leaving the middle open ("can't tell" is neither clearly true
 * nor clearly false) is what lets "uncertain" exist as a real answer; force the model to pick an
 * extreme and "uncertain" disappears, and the decision layer can only guess.
 */
export const DEFAULT_CRITERIA: { readonly true: JevEntry; readonly false: JevEntry } = {
  true: "The condition clearly holds for the item under validation.",
  false:
    "The condition clearly does not hold for the item under validation. " +
    "An item the state says nothing about, or that is too ambiguous to decide, is neither clearly true nor clearly false.",
};

// ---------------------------------------------------------------- Parsing

export interface ParsedAnswers {
  readonly answers: Record<string, number>;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ParseResult =
  | { readonly ok: true; readonly parsed: ParsedAnswers }
  | { readonly ok: false; readonly reason: UnavailableReason };

function readTokenCount(value: JevJson | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/**
 * Validate a response against the question keys that were actually asked.
 *
 * A key that was asked but not answered is a failure, not a default — the whole point of a gate
 * is that "no answer" and "yes" must be different.
 */
export function parseAnswers(response: unknown, questionKeys: readonly string[]): ParseResult {
  if (!isJsonRecord(response)) return { ok: false, reason: "malformed_response" };
  const answersRaw = response.answers;
  if (!isJsonRecord(answersRaw)) return { ok: false, reason: "malformed_response" };

  const answers: Record<string, number> = {};
  for (const key of questionKeys) {
    const answer = answersRaw[key];
    if (!isJsonRecord(answer)) return { ok: false, reason: "malformed_response" };
    const probability = answer.noul;
    if (typeof probability !== "number" || !Number.isFinite(probability)) {
      return { ok: false, reason: "malformed_response" };
    }
    if (probability < 0 || probability > 1) return { ok: false, reason: "malformed_response" };
    answers[key] = probability;
  }

  const usage = isJsonRecord(response.usage) ? response.usage : {};
  return {
    ok: true,
    parsed: {
      answers,
      model: typeof response.model === "string" && response.model.length > 0 ? response.model : "unknown",
      inputTokens: readTokenCount(usage.input_tokens),
      outputTokens: readTokenCount(usage.output_tokens),
    },
  };
}

/** Failures must say what actually happened: upstream reports a gateway key problem as "Could not reach the TypeSafe API", which points at the wrong thing entirely */
export function describeStatus(status: number): string {
  if (status === 401) return "key is invalid or rejected (401)";
  if (status === 403) return "key has no access to this model (403) — the gateway usually only accepts the model name from its preset";
  if (status === 404) return "endpoint not found (404) — the access method and baseUrl probably do not match";
  if (status === 429) return "rate limited (429)";
  if (status >= 500) return `server error (${status})`;
  if (status >= 400) return `request rejected (${status})`;
  return `unexpected status code (${status})`;
}

export function describeReason(reason: AskFailureReason): string {
  switch (reason) {
    case "timeout":
      return "request timed out";
    case "network":
      return "could not connect";
    case "malformed_response":
      return "unrecognised response shape (a question key was left unanswered, or it does not match the noul shape)";
    case "state_too_large":
      return "the state to send is too large";
    case "cancelled":
      return "cancelled by the caller";
    case "budget_exceeded":
      return "daily quota exhausted";
    case "http":
      return "HTTP error";
    default:
      return "unknown error";
  }
}

/** For the status bar: makes "whose account this judgment is billed to" visible inside pi */
export function describeTransport(protocol: Protocol, baseUrl: string): string {
  return `${protocol} at ${baseUrl.replace(/\/+$/, "")}${protocolPath(protocol)}`;
}

// ---------------------------------------------------------------- Credentials

export const SECRET_DIRECTORY_MODE = 0o700;
export const SECRET_FILE_MODE = 0o600;

/** **One slot per protocol**: the official key and the gateway key never overwrite each other (today the gateway key was almost sent to the official endpoint) */
export function credentialPath(agentDir: string, protocol: Protocol): string {
  return join(agentDir, "secrets", `pi-jev-permit-${protocol}-api-key`);
}

/**
 * The `PI_JEV_PERMIT_API_KEY` environment variable overrides the key for the current protocol.
 * **Deliberately not reusing `TYPESAFE_API_KEY`** — other packages read it too.
 */
export function resolveApiKey(
  agentDir: string,
  protocol: Protocol,
  env: Record<string, string | undefined> = process.env,
): { key: string; source: "env" | "stored" } | null {
  const fromEnv = env.PI_JEV_PERMIT_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return { key: fromEnv.trim(), source: "env" };
  }
  return readStoredApiKey(agentDir, protocol);
}

export function readStoredApiKey(
  agentDir: string,
  protocol: Protocol,
): { key: string; source: "stored" } | null {
  try {
    const key = readFileSync(credentialPath(agentDir, protocol), "utf8").trim();
    return key.length > 0 ? { key, source: "stored" } : null;
  } catch {
    return null;
  }
}

export function writeStoredApiKey(agentDir: string, protocol: Protocol, key: string): void {
  const dir = join(agentDir, "secrets");
  mkdirSync(dir, { recursive: true, mode: SECRET_DIRECTORY_MODE });
  const file = credentialPath(agentDir, protocol);
  writeFileSync(file, `${key.trim()}\n`, { mode: SECRET_FILE_MODE });
  // writeFile's mode only applies on creation, so chmod again explicitly
  chmodSync(file, SECRET_FILE_MODE);
}

// ---------------------------------------------------------------- Metering

/** Official pricing: $0.042 per 1M input tokens; output is not billed */
export const INPUT_USD_PER_TOKEN = 0.042 / 1_000_000;

export interface UsageRecord {
  readonly date: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
}

export const EMPTY_USAGE = (date: string): UsageRecord => ({
  date,
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  usd: 0,
});

export function usagePath(agentDir: string): string {
  return join(agentDir, "pi-jev-permit-usage.json");
}

/** The counter resets by **UTC date** (simple and predictable; a local-timezone day boundary shifts as you travel) */
export function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function loadUsage(agentDir: string, nowMs: number): UsageRecord {
  const today = utcDate(nowMs);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(usagePath(agentDir), "utf8"));
  } catch {
    return EMPTY_USAGE(today);
  }
  if (!isJsonRecord(raw) || raw.date !== today) return EMPTY_USAGE(today);
  const num = (v: JevJson | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    date: today,
    requests: num(raw.requests),
    inputTokens: num(raw.inputTokens),
    outputTokens: num(raw.outputTokens),
    usd: num(raw.usd),
  };
}

/** A metering failure must never affect the judgment itself, so it is swallowed silently (worst case the day's count is slightly off) */
export function saveUsage(agentDir: string, usage: UsageRecord): void {
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(usagePath(agentDir), `${JSON.stringify(usage, null, 2)}\n`);
  } catch {
    /* metering is best-effort */
  }
}

// ---------------------------------------------------------------- Logging

export interface AskLogRecord {
  readonly kind: "ask";
  readonly ts: string;
  readonly protocol: Protocol;
  readonly transport: string;
  readonly model: string;
  readonly keys: readonly string[];
  readonly answers?: Record<string, number>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
  readonly latencyMs: number;
  readonly ok: boolean;
  readonly reason?: AskFailureReason;
  readonly detail?: string;
}

export interface DecisionLogRecord {
  readonly kind: "decision";
  readonly ts: string;
  readonly tool: string;
  readonly layer: string;
  readonly status: "allowed" | "blocked";
  readonly reason: string;
  /** A redacted command/path snippet — the log must be able to explain a judgment, otherwise incidents cannot be traced */
  readonly summary?: string;
  /** The reason a layer was reached (i.e. the matched_policy_reasons sent to Jev) */
  readonly policyReasons?: readonly string[];
  readonly decidingRule?: string;
  readonly conditions?: readonly {
    readonly id: string;
    readonly p: number;
    readonly threshold: number;
    readonly verdict: string;
  }[];
  readonly latencyMs?: number;
  readonly transport: string;
}

/** Two record kinds in one jsonl file: the core logs each ask, the gate logs each decision */
export type LogRecord = AskLogRecord | DecisionLogRecord;

export function logPath(agentDir: string): string {
  return join(agentDir, "pi-jev-permit-log.jsonl");
}

/** A log write failure must not affect the judgment */
export function appendLog(agentDir: string, record: LogRecord): void {
  try {
    mkdirSync(agentDir, { recursive: true });
    appendFileSync(logPath(agentDir), `${JSON.stringify(record)}\n`);
  } catch {
    /* logging is best-effort */
  }
}

// ---------------------------------------------------------------- Reading the log back

/**
 * Read the log back (**tolerates bad lines**: the file may have been written by an older version
 * or edited by hand). `limit` takes the **tail** of the records, most recent last. Returns raw
 * JSON objects without asserting types — the reader confirms each field with typeof.
 */
export function readLogRecords(agentDir: string, limit = 5000): JevJsonObject[] {
  let text: string;
  try {
    text = readFileSync(logPath(agentDir), "utf8");
  } catch {
    return [];
  }

  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const out: JevJsonObject[] = [];
  for (const line of lines.slice(-Math.max(0, limit))) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isJsonRecord(parsed)) out.push(parsed);
    } catch {
      /* skip bad lines */
    }
  }
  return out;
}

// ---------------------------------------------------------------- Client

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  readonly agentDir: string;
  readonly protocol: Protocol;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly maxStateCharacters?: number;
  readonly budget?: { readonly requestsPerDay: number; readonly usdPerDay: number };
  /** For probes / key verification: neither reads nor writes usage or logs, and does not count against the daily quota */
  readonly ephemeral?: boolean;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

export interface JevClient {
  /** One batched ask (Jev answers all questions in parallel, so it is always a single request) */
  ask(request: AskRequest): Promise<AskResult>;
  /** Usage for the current UTC day */
  usage(): UsageRecord;
  readonly transport: string;
}

export const DEFAULT_TIMEOUT_MS = 4000;
export const DEFAULT_MAX_RETRIES = 1;
/** Same value as upstream: anything larger is not sent and is reported as state_too_large */
export const DEFAULT_MAX_STATE_CHARACTERS = 120_000;

function isTimeoutError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
}

export function createJevClient(options: ClientOptions): JevClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const maxStateCharacters = options.maxStateCharacters ?? DEFAULT_MAX_STATE_CHARACTERS;
  const budget = options.budget ?? { requestsPerDay: Number.POSITIVE_INFINITY, usdPerDay: Number.POSITIVE_INFINITY };
  const now = options.now ?? (() => Date.now());
  const url = `${options.baseUrl.replace(/\/+$/, "")}${protocolPath(options.protocol)}`;
  const transport = describeTransport(options.protocol, options.baseUrl);

  const failure = (reason: AskFailureReason, detail: string, latencyMs: number, status?: number): AskFailure => ({
    ok: false,
    reason,
    detail,
    latencyMs,
    ...(status === undefined ? {} : { status }),
  });

  // Logging on the failure path: only the structure, never the state (the state may contain command text). A log write failure must not affect the judgment.
  const logFailure = (
    request: AskRequest,
    keys: readonly string[],
    outcome: { reason: AskFailureReason; detail: string },
    latencyMs: number,
  ): void => {
    if (options.ephemeral === true) return;
    appendLog(options.agentDir, {
      kind: "ask",
      ts: new Date(now()).toISOString(),
      protocol: options.protocol,
      transport,
      model: request.model ?? options.model,
      keys,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      latencyMs,
      ok: false,
      reason: outcome.reason,
      detail: outcome.detail,
    });
  };

  return {
    transport,

    usage(): UsageRecord {
      return loadUsage(options.agentDir, now());
    },

    async ask(request: AskRequest): Promise<AskResult> {
      const started = now();
      const keys = Object.keys(request.questions);
      const elapsed = (): number => Math.max(0, now() - started);

      if (keys.length === 0) {
        return failure("unknown", "no questions were asked", elapsed());
      }

      const payload = JSON.stringify({
        model: request.model ?? options.model,
        state: request.state,
        questions: request.questions,
      });
      if (payload.length > maxStateCharacters) {
        return failure("state_too_large", `${payload.length} > ${maxStateCharacters} chars`, elapsed());
      }

      // Check the quota before using it: when exceeded, neither send the request nor meter it
      const before =
        options.ephemeral === true ? EMPTY_USAGE(utcDate(started)) : loadUsage(options.agentDir, started);
      if (before.requests >= budget.requestsPerDay) {
        return failure("budget_exceeded", `daily request count ${before.requests} has reached the limit ${budget.requestsPerDay}`, elapsed());
      }
      if (before.usd >= budget.usdPerDay) {
        return failure(
          "budget_exceeded",
          `estimated daily spend $${before.usd.toFixed(4)} has reached the limit $${budget.usdPerDay}`,
          elapsed(),
        );
      }

      for (let attempt = 0; ; attempt += 1) {
        const lastAttempt = attempt >= maxRetries;
        const deadline = AbortSignal.timeout(timeoutMs);
        const signal = request.signal === undefined ? deadline : AbortSignal.any([request.signal, deadline]);

        let response: Response;
        try {
          response = await doFetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
            body: payload,
            signal,
          });
        } catch (error) {
          // caller cancellation is control flow, not a verdict
          if (request.signal?.aborted === true) throw error;
          const reason: AskFailureReason = isTimeoutError(error) ? "timeout" : "network";
          if (lastAttempt) {
            const detail = describeReason(reason);
            logFailure(request, keys, { reason, detail }, elapsed());
            return failure(reason, detail, elapsed());
          }
          continue;
        }

        if (!response.ok) {
          // the upstream SDK retries transient statuses; this transport does it itself
          if (!lastAttempt && (response.status === 429 || response.status >= 500)) continue;
          const detail = describeStatus(response.status);
          logFailure(request, keys, { reason: "http", detail }, elapsed());
          return failure("http", detail, elapsed(), response.status);
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          const detail = describeReason("malformed_response");
          logFailure(request, keys, { reason: "malformed_response", detail }, elapsed());
          return failure("malformed_response", detail, elapsed());
        }

        const parsed = parseAnswers(body, keys);
        if (!parsed.ok) {
          const detail = describeReason(parsed.reason);
          logFailure(request, keys, { reason: parsed.reason, detail }, elapsed());
          return failure(parsed.reason, detail, elapsed());
        }

        const usd = parsed.parsed.inputTokens * INPUT_USD_PER_TOKEN;
        if (options.ephemeral !== true) {
          const usage = loadUsage(options.agentDir, started);
          saveUsage(options.agentDir, {
            date: usage.date,
            requests: usage.requests + 1,
            inputTokens: usage.inputTokens + parsed.parsed.inputTokens,
            outputTokens: usage.outputTokens + parsed.parsed.outputTokens,
            usd: usage.usd + usd,
          });
        }

        const record: AskLogRecord = {
          kind: "ask",
          ts: new Date(started).toISOString(),
          protocol: options.protocol,
          transport,
          model: parsed.parsed.model,
          keys,
          answers: parsed.parsed.answers,
          inputTokens: parsed.parsed.inputTokens,
          outputTokens: parsed.parsed.outputTokens,
          usd,
          latencyMs: elapsed(),
          ok: true,
        };
        if (options.ephemeral !== true) appendLog(options.agentDir, record);

        return {
          ok: true,
          answers: parsed.parsed.answers,
          model: parsed.parsed.model,
          inputTokens: parsed.parsed.inputTokens,
          outputTokens: parsed.parsed.outputTokens,
          usd,
          latencyMs: record.latencyMs,
        };
      }
    },
  };
}

// ---------------------------------------------------------------- Key verification

export type KeyVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid" | "unreachable"; readonly detail: string };

/**
 * Verify a key by **asking one throwaway real question**, not by listing models.
 *
 * Listing models is wrong on a gateway: a proxy answers `/v1/models` with the OpenAI shape
 * `{data:[…]}`, and the SDK's models call rejects that with a non-APIError -> reported as
 * unreachable -> **a perfectly valid gateway key could never be stored** (this is what was
 * blocking us today). Hitting the real endpoint is both stricter and exercises the exact path a
 * judgment will take. Both protocols do this, so it is one code path.
 *
 * Only 401/403 say anything about the key; any other status, a timeout, a dead socket, or an
 * unreadable body only means "we could not reach it".
 */
export async function verifyKey(options: {
  readonly protocol: Protocol;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}): Promise<KeyVerification> {
  const client = createJevClient({
    agentDir: "",
    protocol: options.protocol,
    baseUrl: options.baseUrl,
    model: options.model ?? DEFAULT_MODEL_BY_PROTOCOL[options.protocol],
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxRetries: 0, // key verification never retries a rejected credential
    ephemeral: true, // a probe neither counts against the quota nor writes logs
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  const result = await client.ask({
    state: { value: { probe: "key verification" } },
    questions: {
      reachable: { type: "noul", instructions: "Is this a key verification probe?" },
    },
  });

  if (result.ok) return { ok: true };
  if (result.reason === "http") {
    const status = result.status;
    return {
      ok: false,
      reason: status === 401 || status === 403 ? "invalid" : "unreachable",
      detail: result.detail,
    };
  }
  return { ok: false, reason: "unreachable", detail: result.detail };
}
