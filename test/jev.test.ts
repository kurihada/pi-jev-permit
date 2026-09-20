/**
 * core（src/jev.ts）：两种接入方式、严格解析、失败分类、记账、凭据、key 验证。
 * 全部用假 fetch —— 不打网络。
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

// ---------------------------------------------------------------- 脚手架

function tempAgent(): string {
  return mkdtempSync(join(tmpdir(), "pi-jev-suite-core-"));
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

/** 把解析出来的请求体当成 JSON 对象来断言，避免到处写 unknown 转换 */
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

// ---------------------------------------------------------------- 两种接入方式

test("两种协议只有 URL 不同，请求体同形", async () => {
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
  assert.deepEqual(bodyGateway["questions"], bodyOfficial["questions"], "问题集不因协议而变");

  const q = rec(rec(bodyGateway["questions"])["q1"]);
  assert.equal(q["type"], "noul");
  assert.equal(rec(q["criteria"])["true"], DEFAULT_CRITERIA.true);
  assert.equal(rec(rec(bodyGateway["state"])["value"])["cmd"], "ls -la");
  assert.equal(
    (gateway.calls[0]!.init?.headers as Record<string, string>)["Authorization"],
    "Bearer test-key",
  );
});

test("baseUrl 尾斜杠不会拼出双斜杠", async () => {
  const f = fakeFetch(() => json(ANSWER));
  await createJevClient(options({ baseUrl: "https://gateway.test///", fetch: f.fn })).ask(request());
  assert.equal(f.calls[0]!.url, "https://gateway.test/api/alpha/decisions");
});

// ---------------------------------------------------------------- 成功路径

test("成功：概率、记账、一行日志", async () => {
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
  assert.ok(Math.abs(r.usd - 361 * (0.042 / 1_000_000)) < 1e-12, "按输入 token 计费");

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

// ---------------------------------------------------------------- 严格解析

test("严格解析：问过的 key 没答全就是失败，不默认通过", () => {
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

test("严格解析：model 与 token 缺失时给安全默认值", () => {
  const r = parseAnswers({ answers: { q1: { noul: 1 } } }, ["q1"]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.parsed.model, "unknown");
  assert.equal(r.parsed.inputTokens, 0);
  assert.equal(r.parsed.outputTokens, 0);
});

test("响应体不是 JSON → malformed_response", async () => {
  const f = fakeFetch(() => new Response("not json", { status: 200 }));
  const r = await createJevClient(options({ fetch: f.fn })).ask(request());
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "malformed_response");
});

// ---------------------------------------------------------------- 失败分类

test("状态码给的是能定位问题的说明，不是笼统一句", () => {
  assert.match(describeStatus(401), /key 无效/);
  assert.match(describeStatus(403), /模型/);
  assert.match(describeStatus(404), /端点/);
  assert.match(describeStatus(503), /服务端/);
  assert.equal(
    describeTransport("decisions", "https://g.test"),
    "decisions at https://g.test/api/alpha/decisions",
  );
});

test("429 与 5xx 重试，4xx 不重试", async () => {
  const flaky = fakeFetch((_call, n) => (n === 1 ? json({}, 503) : json(ANSWER)));
  const r1 = await createJevClient(options({ fetch: flaky.fn, maxRetries: 1 })).ask(request());
  assert.equal(r1.ok, true);
  assert.equal(flaky.calls.length, 2);

  const rejected = fakeFetch(() => json({}, 400));
  const r2 = await createJevClient(options({ fetch: rejected.fn, maxRetries: 3 })).ask(request());
  assert.equal(r2.ok, false);
  assert.equal(rejected.calls.length, 1, "400 重试没有意义");
  if (!r2.ok) {
    assert.equal(r2.reason, "http");
    assert.equal(r2.status, 400);
  }

  const down = fakeFetch(() => json({}, 500));
  const r3 = await createJevClient(options({ fetch: down.fn, maxRetries: 1 })).ask(request());
  assert.equal(r3.ok, false);
  assert.equal(down.calls.length, 2, "用尽重试后才是失败");
});

test("超时与连不上分开报", async () => {
  const timedOut = fakeFetch(() => {
    throw Object.assign(new Error("t"), { name: "TimeoutError" });
  });
  const r1 = await createJevClient(options({ fetch: timedOut.fn, maxRetries: 0 })).ask(request());
  assert.equal(r1.ok, false);
  if (!r1.ok) {
    assert.equal(r1.reason, "timeout");
    assert.match(r1.detail, /超时/);
  }

  const broken = fakeFetch(() => {
    throw new Error("boom");
  });
  const r2 = await createJevClient(options({ fetch: broken.fn, maxRetries: 0 })).ask(request());
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, "network");
});

test("调用方取消是控制流：直接抛，不变成判定", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fakeFetch(() => {
    throw new Error("aborted");
  });
  const client = createJevClient(options({ fetch: f.fn, maxRetries: 0 }));
  await assert.rejects(() => client.ask({ ...request(), signal: controller.signal }));
});

// ---------------------------------------------------------------- 配额

test("状态太大就不发请求", async () => {
  const f = fakeFetch(() => json(ANSWER));
  const r = await createJevClient(options({ fetch: f.fn, maxStateCharacters: 10 })).ask(request());
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "state_too_large");
  assert.equal(f.calls.length, 0);
});

test("配额：超了不发请求也不记账", async () => {
  const f = fakeFetch(() => json(ANSWER));
  const client = createJevClient(options({ fetch: f.fn, budget: { requestsPerDay: 1, usdPerDay: 1 } }));
  assert.equal((await client.ask(request())).ok, true);
  const second = await client.ask(request());
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "budget_exceeded");
  assert.equal(f.calls.length, 1);
  assert.equal(client.usage().requests, 1);
});

test("配额：花费上限同样生效", async () => {
  const f = fakeFetch(() => json(ANSWER));
  const client = createJevClient(
    options({ fetch: f.fn, budget: { requestsPerDay: 100, usdPerDay: 0.000001 } }),
  );
  assert.equal((await client.ask(request())).ok, true);
  const second = await client.ask(request());
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "budget_exceeded");
});

test("ephemeral：探测不占配额也不写日志", async () => {
  const f = fakeFetch(() => json(ANSWER));
  const o = options({ fetch: f.fn, ephemeral: true });
  const client = createJevClient(o);
  assert.equal((await client.ask(request())).ok, true);
  assert.equal(client.usage().requests, 0);
  assert.equal(existsSync(logPath(o.agentDir)), false);
});

test("用量按 UTC 日期归零", async () => {
  const f = fakeFetch(() => json(ANSWER));
  let nowMs = Date.UTC(2026, 8, 20, 10, 0, 0);
  const client = createJevClient(options({ fetch: f.fn, now: () => nowMs }));
  await client.ask(request());
  assert.equal(client.usage().requests, 1);
  nowMs += 86_400_000;
  assert.equal(client.usage().requests, 0);
});

// ---------------------------------------------------------------- 凭据

test("key 按协议分槽，env 覆盖当前协议，不读别家的变量", () => {
  const dir = tempAgent();
  writeStoredApiKey(dir, "systemone", "official-key");
  writeStoredApiKey(dir, "decisions", "gateway-key");

  assert.notEqual(credentialPath(dir, "systemone"), credentialPath(dir, "decisions"));
  assert.equal(readStoredApiKey(dir, "systemone")?.key, "official-key");
  assert.equal(readStoredApiKey(dir, "decisions")?.key, "gateway-key");

  assert.deepEqual(resolveApiKey(dir, "systemone", {}), { key: "official-key", source: "stored" });
  assert.deepEqual(resolveApiKey(dir, "systemone", { PI_JEV_SUITE_API_KEY: "env-key" }), {
    key: "env-key",
    source: "env",
  });
  assert.equal(
    resolveApiKey(dir, "systemone", { TYPESAFE_API_KEY: "wrong-package" })?.key,
    "official-key",
    "不复用 TYPESAFE_API_KEY（别的包也在读）",
  );
  assert.equal(resolveApiKey(tempAgent(), "systemone", {}), null);
});

// ---------------------------------------------------------------- key 验证

test("verifyKey：用真实提问验，只有 401/403 怪 key", async () => {
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
  assert.equal(good.calls.length, 1, "只问一次");
  const body = rec(JSON.parse(good.calls[0]!.body));
  assert.equal(body["model"], "typesafe/jev-1.13", "decisions 默认模型名要带 vendor 前缀");
  assert.equal(rec(rec(body["questions"])["reachable"])["type"], "noul");

  for (const status of [401, 403]) {
    const f = probe(status);
    const r = await verifyKey({ protocol: "decisions", baseUrl: "https://g.test", apiKey: "k", fetch: f.fn });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "invalid", `status ${status}`);
    assert.equal(f.calls.length, 1, "被拒的凭据不重试");
  }

  for (const status of [404, 429, 500]) {
    const f = probe(status);
    const r = await verifyKey({ protocol: "decisions", baseUrl: "https://g.test", apiKey: "k", fetch: f.fn });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "unreachable", `status ${status} 不该怪 key`);
  }

  const dead = probe("throw");
  const r = await verifyKey({ protocol: "decisions", baseUrl: "https://g.test", apiKey: "k", fetch: dead.fn });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "unreachable");
});

test("loadUsage 在没有文件时返回当日空记录", () => {
  const usage = loadUsage(tempAgent(), Date.UTC(2026, 8, 20));
  assert.deepEqual(usage, { date: "2026-09-20", requests: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
});
