/**
 * pi-jev-suite / jev.ts —— core：**唯一**发起网络请求的地方。
 *
 * 两种接入方式共用一套解析器（响应体同形）：
 *   - `systemone` → `POST {baseUrl}/v1/systemone`（官方 TypeSafe）
 *   - `decisions` → `POST {baseUrl}/api/alpha/decisions`（OpenRouter 契约；公司网关走这条）
 *
 * 这一层同时负责记账（请求数 / token / 估算花费）与判定日志。
 * 消费方（门禁 / jev_evaluate / 顾问）都只通过 createJevClient().ask() 说话。
 *
 * 三条硬约束（照抄上游做对的部分 + 今天的教训）：
 *   1. **答不出来 ≠ 同意**：问过的 key 少一个就是失败，不默认通过。
 *   2. 只发 state 与问题，**绝不发文件内容 / diff**（由调用方保证，这里不额外放宽）。
 *   3. 调用方取消是控制流（rethrow），超时/网络/HTTP/形状不符都是失败。
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODEL_BY_PROTOCOL, type Protocol, protocolPath } from "./config.ts";

// ---------------------------------------------------------------- JSON 边界

export type JevJson = string | number | boolean | null | JevJson[] | JevJsonObject;

export interface JevJsonObject {
  [key: string]: JevJson;
}

function isJsonRecord(value: unknown): value is JevJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- 请求 / 结果

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

/** `budget_exceeded` 是本包自己的码：配额用完不是"Jev 挂了"，状态栏要说清楚 */
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
 * 默认 criteria。**比看上去重要**：noul 没有 confidence 字段，唯一的信号就是概率。
 * 中间留白（"说不清就是既非清楚成立也非清楚不成立"）才能让"不确定"作为一个真实答案存在；
 * 如果逼模型给极端值，"不确定"就消失，判定层只能瞎猜。
 */
export const DEFAULT_CRITERIA: { readonly true: JevEntry; readonly false: JevEntry } = {
  true: "The condition clearly holds for the item under validation.",
  false:
    "The condition clearly does not hold for the item under validation. " +
    "An item the state says nothing about, or that is too ambiguous to decide, is neither clearly true nor clearly false.",
};

// ---------------------------------------------------------------- 解析

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
 * 按**实际问过的 key**校验响应。
 *
 * 问过而没答的 key 是失败，不是默认值 —— 门禁的全部意义就是"没答案"和"是"必须不同。
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

/** 失败要说人话：上游把网关 key 的问题报成 "Could not reach the TypeSafe API"，指向完全错误的方向 */
export function describeStatus(status: number): string {
  if (status === 401) return "key 无效或被拒（401）";
  if (status === 403) return "key 无权使用该模型（403）——网关通常只认预设里那个模型名";
  if (status === 404) return "端点不存在（404）——接入方式与 baseUrl 可能不匹配";
  if (status === 429) return "限流（429）";
  if (status >= 500) return `服务端错误（${status}）`;
  if (status >= 400) return `请求被拒（${status}）`;
  return `意外状态码（${status}）`;
}

export function describeReason(reason: AskFailureReason): string {
  switch (reason) {
    case "timeout":
      return "请求超时";
    case "network":
      return "连不上";
    case "malformed_response":
      return "返回格式不认识（问过的 key 没答全，或不满足 noul 的形状）";
    case "state_too_large":
      return "要发的状态太大";
    case "cancelled":
      return "调用方取消了";
    case "budget_exceeded":
      return "当日配额用完";
    case "http":
      return "HTTP 错误";
    default:
      return "未知错误";
  }
}

/** 状态栏用：让"这笔判定算在谁头上"在 pi 里看得见 */
export function describeTransport(protocol: Protocol, baseUrl: string): string {
  return `${protocol} at ${baseUrl.replace(/\/+$/, "")}${protocolPath(protocol)}`;
}

// ---------------------------------------------------------------- 凭据

export const SECRET_DIRECTORY_MODE = 0o700;
export const SECRET_FILE_MODE = 0o600;

/** **按协议分槽**：官方 key 与网关 key 互不覆盖（今天差点把网关 key 发到官方端点） */
export function credentialPath(agentDir: string, protocol: Protocol): string {
  return join(agentDir, "secrets", `pi-jev-suite-${protocol}-api-key`);
}

/**
 * 环境变量 `PI_JEV_SUITE_API_KEY` 覆盖当前协议的 key。
 * **故意不复用 `TYPESAFE_API_KEY`** —— 别的包也在读它。
 */
export function resolveApiKey(
  agentDir: string,
  protocol: Protocol,
  env: Record<string, string | undefined> = process.env,
): { key: string; source: "env" | "stored" } | null {
  const fromEnv = env.PI_JEV_SUITE_API_KEY;
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
  // writeFile 的 mode 只在创建时生效，显式再 chmod 一次
  chmodSync(file, SECRET_FILE_MODE);
}

// ---------------------------------------------------------------- 记账

/** 官方定价：$0.042 / 1M 输入 token，输出不计费 */
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
  return join(agentDir, "pi-jev-suite-usage.json");
}

/** 计数器按 **UTC 日期**归零（简单、可预测；本地时区的日界线会随旅行跳变） */
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

/** 记账失败绝不影响判定本身，所以静默吞掉（最坏情况只是当日计数不准） */
export function saveUsage(agentDir: string, usage: UsageRecord): void {
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(usagePath(agentDir), `${JSON.stringify(usage, null, 2)}\n`);
  } catch {
    /* 记账是尽力而为 */
  }
}

// ---------------------------------------------------------------- 日志

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

/** 同一个 jsonl 文件里两种记录：core 记每次提问，门禁记每次判定 */
export type LogRecord = AskLogRecord | DecisionLogRecord;

export function logPath(agentDir: string): string {
  return join(agentDir, "pi-jev-suite-log.jsonl");
}

/** 写日志失败也不能影响判定 */
export function appendLog(agentDir: string, record: LogRecord): void {
  try {
    mkdirSync(agentDir, { recursive: true });
    appendFileSync(logPath(agentDir), `${JSON.stringify(record)}\n`);
  } catch {
    /* 日志是尽力而为 */
  }
}

// ---------------------------------------------------------------- 读回日志

/**
 * 读回日志（**容忍坏行**：文件可能被旧版本写过、也可能被手工改过）。
 * `limit` 取的是**尾部**条数，最近的排在最后。返回原始 JSON 对象而不做类型断言 ——
 * 读的一方自己用 typeof 逐个字段确认。
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
      /* 坏行跳过 */
    }
  }
  return out;
}

// ---------------------------------------------------------------- 客户端

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
  /** 探测 / key 验证用：不读也不写用量与日志，不占当日配额 */
  readonly ephemeral?: boolean;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

export interface JevClient {
  /** 一次批量提问（Jev 并行回答所有问题，所以永远合成一个请求） */
  ask(request: AskRequest): Promise<AskResult>;
  /** 当前 UTC 日的用量 */
  usage(): UsageRecord;
  readonly transport: string;
}

export const DEFAULT_TIMEOUT_MS = 4000;
export const DEFAULT_MAX_RETRIES = 1;
/** 上游同值：超过就不发，直接算 state_too_large */
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

  // 失败路径的日志：只记结构，不记 state（state 里可能有命令文本）。写日志失败也不能影响判定。
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
        return failure("unknown", "没有问任何问题", elapsed());
      }

      const payload = JSON.stringify({
        model: request.model ?? options.model,
        state: request.state,
        questions: request.questions,
      });
      if (payload.length > maxStateCharacters) {
        return failure("state_too_large", `${payload.length} > ${maxStateCharacters} 字符`, elapsed());
      }

      // 配额先看再用：超了就不发请求，也不记账
      const before =
        options.ephemeral === true ? EMPTY_USAGE(utcDate(started)) : loadUsage(options.agentDir, started);
      if (before.requests >= budget.requestsPerDay) {
        return failure("budget_exceeded", `今日请求数 ${before.requests} 已达上限 ${budget.requestsPerDay}`, elapsed());
      }
      if (before.usd >= budget.usdPerDay) {
        return failure(
          "budget_exceeded",
          `今日估算花费 $${before.usd.toFixed(4)} 已达上限 $${budget.usdPerDay}`,
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
          // 调用方取消是控制流，不是判定
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
          // 上游 SDK 会重试瞬时状态码；这里自己来
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

// ---------------------------------------------------------------- key 验证

export type KeyVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid" | "unreachable"; readonly detail: string };

/**
 * 验证 key：**发一个丢弃用的真实问题**，而不是列举模型。
 *
 * 列举模型在网关上是错的：代理用 OpenAI 形状的 `{data:[…]}` 回答 `/v1/models`，
 * 而 SDK 的 models 调用会因形状不符抛非 APIError → 被判成 unreachable →
 * **一个完全正确的网关 key 根本存不下来**（今天卡在这上面）。
 * 打真实端点既更严格，也正好走一遍判定要走的路径。两种协议都这么做 → 一套代码。
 *
 * 只有 401/403 是在说 key 的问题；其它状态、超时、连不上、身体读不出来都只说"没问到"。
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
    maxRetries: 0, // 验 key 不重试被拒的凭据
    ephemeral: true, // 探测不占配额、不写日志
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
