/**
 * core (src/jev.ts): the two access methods, strict parsing, failure classification, metering,
 * credentials, and key verification. All using a fake fetch — no network.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type AskRequest,
  type ClientOptions,
  DEFAULT_CRITERIA,
  type FetchLike,
  type JevJsonObject,
  credentialPath,
  createJevClient,
  describeStatus,
  describeTransport,
  loadUsage,
  logPath,
  parseAnswers,
  readStoredApiKey,
  resolveApiKey,
  verifyKey,
  writeStoredApiKey,
} from "../src/jev.ts";

// ---------------------------------------------------------------- Scaffolding

function tempAgent(): string {
  return mkdtempSync(join(tmpdir(), "pi-jev-permit-core-"));
}

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
  readonly body: string;
}

function fakeFetch(handler: (call: Call, n: number) => Response | Promise<Response>): {
  fn: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    const call: Call = { url, init, body: typeof init?.body === "string" ? init.body : "" };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { fn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Assert on a parsed request body as a JSON object, avoiding `unknown` casts everywhere */
function rec(value: unknown): JevJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JevJsonObject) : {};
}

const ANSWER = {
  model: "typesafe/jev-1.13",
  answers: { q1: { noul: 0.9 } },
  usage: { input_tokens: 361, output_tokens: 52 },
};

function options(over: Partial<ClientOptions> = {}): ClientOptions {
  return {
    agentDir: tempAgent(),
    protocol: "decisions",
    baseUrl: "https://gateway.test",
    model: "typesafe/jev-1.13",
    apiKey: "test-key",
    ...over,
  };
}

function request(cmd = "ls -la"): AskRequest {
  return {
    state: { value: { cmd } },
    questions: { q1: { type: "noul", instructions: "Is this safe?", criteria: DEFAULT_CRITERIA } },
  };
}

// ---------------------------------------------------------------- Two access methods

test("the two protocols differ only in URL; the request bodies have the same shape", async () => {
  const gateway = fakeFetch(() => json(ANSWER));
  await createJevClient(options({ fetch: gateway.fn })).ask(request());
  assert.equal(gateway.calls[0]!.url, "https://gateway.test/api/alpha/decisions");

  const official = fakeFetch(() => json(ANSWER));
  await createJevClient(
    options({ protocol: "systemone", baseUrl: "https://api.typesafe.ai", fetch: official.fn }),
  ).ask(request());
  assert.equal(official.calls[0]!.url, "https://api.typesafe.ai/v1/systemone");

  const bodyGateway = rec(JSON.parse(gateway.calls[0]!.body));
  const bodyOfficial = rec(JSON.parse(official.calls[0]!.body));
  assert.deepEqual(Object.keys(bodyGateway).sort(), ["model", "questions", "state"]);
  assert.deepEqual(Object.keys(bodyOfficial).sort(), ["model", "questions", "state"]);
  assert.deepEqual(bodyGateway["questions"], bodyOfficial["questions"], "the question set does not change with the protocol");

  const q = rec(rec(bodyGateway["questions"])["q1"]);
  assert.equal(q["type"], "noul");
  assert.equal(rec(q["criteria"])["true"], DEFAULT_CRITERIA.true);
  assert.equal(rec(rec(bodyGateway["state"])["value"])["cmd"], "ls -la");
  assert.equal(
    (gateway.calls[0]!.init?.headers as Record<string, string>)["Authorization"],
    "Bearer test-key",
  );
});

test("a trailing slash on baseUrl does not produce a double slash", async () => {
  const f = fakeFetch(() => json(ANSWER));
  await createJevClient(options({ baseUrl: "https://gateway.test///", fetch: f.fn })).ask(request());
  assert.equal(f.calls[0]!.url, "https://gateway.test/api/alpha/decisions");
});

// ---------------------------------------------------------------- Success path

test("success: probabilities, metering, one log line", async () => {
  const f = fakeFetch(() => json(ANSWER));
  const o = options({ fetch: f.fn });
  const client = createJevClient(o);
  const r = await client.ask(request());

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.answers, { q1: 0.9 });
  assert.equal(r.model, "typesafe/jev-1.13");
  assert.equal(r.inputTokens, 361);
  assert.equal(r.outputTokens, 52);
  assert.ok(Math.abs(r.usd - 361 * (0.042 / 1_000_000)) < 1e-12, "billed by input tokens");

  const usage = client.usage();
  assert.equal(usage.requests, 1);
  assert.equal(usage.inputTokens, 361);

  const lines = readFileSync(logPath(o.agentDir), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(record["kind"], "ask");
  assert.equal(record["ok"], true);
  assert.equal(record["protocol"], "decisions");
  assert.deepEqual(record["answers"], { q1: 0.9 });
});

// ---------------------------------------------------------------- Strict parsing

test("strict parsing: a question key left unanswered is a failure, not a default", () => {
  const bad: unknown[] = [
    { answers: {} },
    { answers: { q1: {} } },
    { answers: { q1: { noul: "0.9" } } },
    { answers: { q1: { noul: 1.5 } } },
    { answers: { q1: { noul: Number.NaN } } },
    { answers: { q1: { noul: -0.1 } } },
    { answers: { q1: { nou: 0.9 } } },
    { answers: [] },
    "nope",
    null,
  ];
  for (const body of bad) {
    const r = parseAnswers(body, ["q1"]);
    assert.equal(r.ok, false, JSON.stringify(body));
    if (!r.ok) assert.equal(r.reason, "malformed_response");
  }
  assert.equal(parseAnswers(ANSWER, ["q1"]).ok, true);
});

test("strict parsing: missing model and tokens fall back to safe defaults", () => {
  const r = parseAnswers({ answers: { q1: { noul: 1 } } }, ["q1"]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.parsed.model, "unknown");
  assert.equal(r.parsed.inputTokens, 0);
  assert.equal(r.parsed.outputTokens, 0);
});

test("a non-JSON response body → malformed_response", async () => {
  const f = fakeFetch(() => new Response("not json", { status: 200 }));
  const r = await createJevClient(options({ fetch: f.fn })).ask(request());
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "malformed_response");
});

// ---------------------------------------------------------------- Failure classification

test("status codes give an explanation that points at the problem, not a vague one-liner", () => {
  assert.match(describeStatus(401), /key is invalid/);
  assert.match(describeStatus(403), /model/);
  assert.match(describeStatus(404), /endpoint/);
  assert.match(describeStatus(503), /server/);
  assert.equal(
    describeTransport("decisions", "https://g.test"),
    "decisions at https://g.test/api/alpha/decisions",
  );
});

test("429 and 5xx are retried, 4xx is not", async () => {
  const flaky = fakeFetch((_call, n) => (n === 1 ? json({}, 503) : json(ANSWER)));
  const r1 = await createJevClient(options({ fetch: flaky.fn, maxRetries: 1 })).ask(request());
  assert.equal(r1.ok, true);
  assert.equal(flaky.calls.length, 2);

  const rejected = fakeFetch(() => json({}, 400));
  const r2 = await createJevClient(options({ fetch: rejected.fn, maxRetries: 3 })).ask(request());
  assert.equal(r2.ok, false);
  assert.equal(rejected.calls.length, 1, "retrying a 400 is pointless");
  if (!r2.ok) {
    assert.equal(r2.reason, "http");
    assert.equal(r2.status, 400);
  }

  const down = fakeFetch(() => json({}, 500));
  const r3 = await createJevClient(options({ fetch: down.fn, maxRetries: 1 })).ask(request());
  assert.equal(r3.ok, false);
  assert.equal(down.calls.length, 2, "only a failure after the retries are exhausted");
});

test("timeout and connectivity are reported separately", async () => {
  const timedOut = fakeFetch(() => {
    throw Object.assign(new Error("t"), { name: "TimeoutError" });
  });
  const r1 = await createJevClient(options({ fetch: timedOut.fn, maxRetries: 0 })).ask(request());
  assert.equal(r1.ok, false);
  if (!r1.ok) {
    assert.equal(r1.reason, "timeout");
    assert.match(r1.detail, /timed out/);
  }

  const broken = fakeFetch(() => {
    throw new Error("boom");
  });
  const r2 = await createJevClient(options({ fetch: broken.fn, maxRetries: 0 })).ask(request());
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, "network");
});

test("caller cancellation is control flow: it throws, it does not become a verdict", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fakeFetch(() => {
    throw new Error("aborted");
  });
  const client = createJevClient(options({ fetch: f.fn, maxRetries: 0 }));
  await assert.rejects(() => client.ask({ ...request(), signal: controller.signal }));
});

// ---------------------------------------------------------------- Quota

test("an over-large state is not sent", async () => {
  const f = fakeFetch(() => json(ANSWER));
  const r = await createJevClient(options({ fetch: f.fn, maxStateCharacters: 10 })).ask(request());
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "state_too_large");
  assert.equal(f.calls.length, 0);
});

test("no quota: repeated asks in one UTC day are never refused for volume, and still metered", async () => {
  const f = fakeFetch(() => json(ANSWER));
  const client = createJevClient(options({ fetch: f.fn }));
  assert.equal((await client.ask(request())).ok, true);
  assert.equal((await client.ask(request())).ok, true);
  assert.equal(f.calls.length, 2);
  assert.equal(client.usage().requests, 2);
});

test("ephemeral: a probe neither writes usage nor logs", async () => {
  const f = fakeFetch(() => json(ANSWER));
  const o = options({ fetch: f.fn, ephemeral: true });
  const client = createJevClient(o);
  assert.equal((await client.ask(request())).ok, true);
  assert.equal(client.usage().requests, 0);
  assert.equal(existsSync(logPath(o.agentDir)), false);
});

test("usage resets by UTC date", async () => {
  const f = fakeFetch(() => json(ANSWER));
  let nowMs = Date.UTC(2026, 8, 20, 10, 0, 0);
  const client = createJevClient(options({ fetch: f.fn, now: () => nowMs }));
  await client.ask(request());
  assert.equal(client.usage().requests, 1);
  nowMs += 86_400_000;
  assert.equal(client.usage().requests, 0);
});

// ---------------------------------------------------------------- Credentials

test("keys are slotted per protocol, env overrides the current protocol, other packages' variables are not read", () => {
  const dir = tempAgent();
  writeStoredApiKey(dir, "systemone", "official-key");
  writeStoredApiKey(dir, "decisions", "gateway-key");

  assert.notEqual(credentialPath(dir, "systemone"), credentialPath(dir, "decisions"));
  assert.equal(readStoredApiKey(dir, "systemone")?.key, "official-key");
  assert.equal(readStoredApiKey(dir, "decisions")?.key, "gateway-key");

  assert.deepEqual(resolveApiKey(dir, "systemone", {}), { key: "official-key", source: "stored" });
  assert.deepEqual(resolveApiKey(dir, "systemone", { PI_JEV_PERMIT_API_KEY: "env-key" }), {
    key: "env-key",
    source: "env",
  });
  assert.equal(
    resolveApiKey(dir, "systemone", { TYPESAFE_API_KEY: "wrong-package" })?.key,
    "official-key",
    "does not reuse TYPESAFE_API_KEY (other packages read it)",
  );
  assert.equal(resolveApiKey(tempAgent(), "systemone", {}), null);
});

// ---------------------------------------------------------------- Key verification

test("verifyKey: verifies with a real question, only 401/403 blame the key", async () => {
  const probe = (status: number | "throw") =>
    fakeFetch(() => {
      if (status === "throw") throw new Error("socket");
      return status === 200 ? json({ answers: { reachable: { noul: 1 } }, model: "m" }) : json({}, status);
    });

  const good = probe(200);
  assert.deepEqual(
    await verifyKey({ protocol: "decisions", baseUrl: "https://g.test", apiKey: "k", fetch: good.fn }),
    { ok: true },
  );
  assert.equal(good.calls.length, 1, "asked exactly once");
  const body = rec(JSON.parse(good.calls[0]!.body));
  assert.equal(body["model"], "typesafe/jev-1.13", "the default decisions model name must carry the vendor prefix");
  assert.equal(rec(rec(body["questions"])["reachable"])["type"], "noul");

  for (const status of [401, 403]) {
    const f = probe(status);
    const r = await verifyKey({ protocol: "decisions", baseUrl: "https://g.test", apiKey: "k", fetch: f.fn });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "invalid", `status ${status}`);
    assert.equal(f.calls.length, 1, "a rejected credential is not retried");
  }

  for (const status of [404, 429, 500]) {
    const f = probe(status);
    const r = await verifyKey({ protocol: "decisions", baseUrl: "https://g.test", apiKey: "k", fetch: f.fn });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "unreachable", `status ${status} should not blame the key`);
  }

  const dead = probe("throw");
  const r = await verifyKey({ protocol: "decisions", baseUrl: "https://g.test", apiKey: "k", fetch: dead.fn });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "unreachable");
});

test("loadUsage returns the day's empty record when no file exists", () => {
  const usage = loadUsage(tempAgent(), Date.UTC(2026, 8, 20));
  assert.deepEqual(usage, { date: "2026-09-20", requests: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
});
