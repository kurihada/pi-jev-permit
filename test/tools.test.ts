/**
 * 消费方 2+3（tools.ts）与入口的纯 helper（index.ts）。
 * 假 pi 捕获注册的工具，假 client 执行 —— 不联网、不起 pi。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { exemptPaths, formatRecentDecisions, formatStats, parseDurationMs } from "../index.ts";
import { type AskRequest, type AskResult, EMPTY_USAGE, type JevClient, type JevJsonObject } from "../src/jev.ts";
import {
  ADVISOR_ALERT_THRESHOLD,
  MAX_EVALUATE_QUESTIONS,
  type ToolSpecLike,
  buildAdvisorQuestions,
  buildEvaluateQuestions,
  buildToolState,
  formatEvaluateResult,
  registerTools,
  summarizeAdvice,
} from "../src/tools.ts";

function fakeClient(result: AskResult): { client: JevClient; calls: AskRequest[] } {
  const calls: AskRequest[] = [];
  return {
    calls,
    client: {
      transport: "test",
      usage: () => EMPTY_USAGE("2026-09-20"),
      ask: async (request: AskRequest) => {
        calls.push(request);
        return result;
      },
    },
  };
}

function okAnswers(answers: Record<string, number>): AskResult {
  return { ok: true, answers, model: "jev-1.13.0", inputTokens: 200, outputTokens: 20, usd: 0, latencyMs: 900 };
}

function fakePi(): { specs: ToolSpecLike[]; pi: { registerTool(spec: ToolSpecLike): void } } {
  const specs: ToolSpecLike[] = [];
  return { specs, pi: { registerTool: (spec: ToolSpecLike) => specs.push(spec) } };
}

// ---------------------------------------------------------------- jev_evaluate

test("buildEvaluateQuestions：key 即答案键，criteria 缺省用默认值", () => {
  const questions = buildEvaluateQuestions([
    { key: "a", question: "条件 A" },
    { key: "b", question: "条件 B", criteria: { true: "是", false: "否" } },
  ]);
  assert.deepEqual(Object.keys(questions).sort(), ["a", "b"]);
  assert.equal(questions["a"]!.type, "noul");
  assert.equal(questions["a"]!.instructions, "条件 A");
  assert.ok(questions["a"]!.criteria?.false, "不给 criteria 就用默认的（中间地带必须存在）");
  assert.equal(questions["b"]!.criteria?.true, "是");
});

test("buildEvaluateQuestions：超过上限的部分被丢掉", () => {
  const many = Array.from({ length: MAX_EVALUATE_QUESTIONS + 5 }, (_v, i) => ({ key: `k${i}`, question: "q" }));
  assert.equal(Object.keys(buildEvaluateQuestions(many)).length, MAX_EVALUATE_QUESTIONS);
});

test("formatEvaluateResult：成功给数字，失败明确说「不是没问题」", () => {
  const good = formatEvaluateResult(okAnswers({ safe: 0.93 }));
  assert.match(good, /safe = 0\.930/);
  assert.match(good, /不构成任何授权/);

  const bad = formatEvaluateResult({ ok: false, reason: "network", detail: "连不上", latencyMs: 3 });
  assert.match(bad, /连不上/);
  assert.match(bad, /不是「没问题」/);
});

test("buildToolState：state 原样透传但过脱敏，没 state 就用 context", () => {
  const passed = buildToolState({ state: { value: { note: "api_key = 'abcdefghijklmnop'" } } });
  assert.ok(JSON.stringify(passed).includes("<redacted>"), "透传的 state 也要脱敏");

  const fallback = buildToolState({ context: "背景" });
  assert.deepEqual(fallback, { value: { context: "背景" } });

  assert.deepEqual(buildToolState({}), { value: { context: "" } });
});

// ---------------------------------------------------------------- ask_advisor

test("ask_advisor 的问题集：三个都是「有麻烦」方向，p 高 = 麻烦在", () => {
  const questions = buildAdvisorQuestions();
  assert.deepEqual(Object.keys(questions).sort(), ["blind_spot", "misread_request", "should_stop_and_ask"]);
  for (const q of Object.values(questions)) {
    assert.equal(q.type, "noul");
    assert.ok(q.criteria?.false);
  }
});

test("summarizeAdvice：没信号说可以继续，有信号点出是哪条", () => {
  const calm = summarizeAdvice({ blind_spot: 0.2, misread_request: 0.3, should_stop_and_ask: 0.4 });
  assert.match(calm, /没有明显信号/);
  assert.match(calm, /不构成授权/);

  const loud = summarizeAdvice({ blind_spot: 0.81, misread_request: 0.2, should_stop_and_ask: 0.65 });
  assert.match(loud, /有信号/);
  assert.match(loud, /方案有明显缺陷/);
  assert.match(loud, /应该先停下来问一句/);

  // 边界：正好等于阈值算报警
  assert.match(summarizeAdvice({ blind_spot: ADVISOR_ALERT_THRESHOLD }), /有信号/);
  // 缺字段跳过，不崩
  assert.match(summarizeAdvice({}), /没有明显信号/);
});

// ---------------------------------------------------------------- 工具接线

test("registerTools：注册两个工具，描述里都写明「不是授权」", () => {
  const { pi, specs } = fakePi();
  const f = fakeClient(okAnswers({ safe: 0.9 }));
  registerTools(pi, { makeClient: () => f.client });

  assert.deepEqual(specs.map((s) => s.name).sort(), ["ask_advisor", "jev_evaluate"]);
  for (const spec of specs) {
    assert.match(spec.description, /not authorization/);
    assert.ok(spec.parameters, "必须有参数 schema");
    assert.ok(spec.label.length > 0);
  }
});

test("jev_evaluate.execute：把问题发出去并把概率给模型", async () => {
  const { pi, specs } = fakePi();
  const f = fakeClient(okAnswers({ ready: 0.88 }));
  registerTools(pi, { makeClient: () => f.client });
  const spec = specs.find((s) => s.name === "jev_evaluate")!;

  const result = await spec.execute("call-1", { questions: [{ key: "ready", question: "准备好了吗" }] });
  assert.match(result.content[0]!.text, /ready = 0\.880/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(f.calls[0]!.questions), ["ready"]);
});

test("jev_evaluate.execute：没有 key / 没有问题时给可读提示，不打网络", async () => {
  const { pi, specs } = fakePi();
  const f = fakeClient(okAnswers({}));
  registerTools(pi, { makeClient: () => null });
  const spec = specs.find((s) => s.name === "jev_evaluate")!;

  assert.match((await spec.execute("c", { questions: [{ key: "a", question: "b" }] })).content[0]!.text, /login/);

  registerTools(pi, { makeClient: () => f.client });
  const withClient = specs.filter((spec) => spec.name === "jev_evaluate").at(-1)!;
  assert.match((await withClient.execute("c", { questions: [] })).content[0]!.text, /至少要问一个/);
  assert.equal(f.calls.length, 0);
});

test("ask_advisor.execute：把 plan 与 user_request 放进状态", async () => {
  const { pi, specs } = fakePi();
  const f = fakeClient(okAnswers({ blind_spot: 0.7, misread_request: 0.1, should_stop_and_ask: 0.2 }));
  registerTools(pi, { makeClient: () => f.client });
  const spec = specs.find((s) => s.name === "ask_advisor")!;

  const result = await spec.execute("c", { plan: "重写整个模块", context: "用户想改个错字" });
  const state = f.calls[0]!.state.value as Record<string, unknown>;
  assert.equal(state["plan"], "重写整个模块");
  assert.equal(state["user_request"], "用户想改个错字");
  assert.match(result.content[0]!.text, /方案有明显缺陷/);

  const empty = await spec.execute("c", { plan: "  " });
  assert.match(empty.content[0]!.text, /plan 不能为空/);
});

// ---------------------------------------------------------------- 入口 helper

test("parseDurationMs：30m / 2h / 45 / 认不出来", () => {
  assert.equal(parseDurationMs("30m"), 30 * 60_000);
  assert.equal(parseDurationMs("2h"), 2 * 3_600_000);
  assert.equal(parseDurationMs("45"), 45 * 60_000);
  assert.equal(parseDurationMs("90s"), 90_000);
  assert.equal(parseDurationMs(""), 30 * 60_000, "空字符串用兜底");
  assert.equal(parseDurationMs("abc"), 30 * 60_000);
  assert.equal(parseDurationMs("0"), 1_000, "下限一秒");
});

test("exemptPaths：本包自己的配置与日志可写，凭据目录不含在内", () => {
  const paths = exemptPaths("/agent");
  assert.deepEqual(paths, ["/agent/pi-jev-suite"]);
  assert.ok(!paths[0]!.includes("secrets"), "凭据由 login 命令写，不该被工具豁免");
});

test("formatStats：分层计数 + 条件读数 + 「未明确」提示", () => {
  const log: JevJsonObject[] = [
    { kind: "decision", layer: "readonly", status: "allowed", tool: "bash" },
    {
      kind: "decision",
      layer: "jev",
      status: "blocked",
      tool: "bash",
      latencyMs: 1200,
      reason: "没有明确覆盖用户请求",
      conditions: [
        { id: "intent_coverage", p: 0.35, threshold: 0.6, verdict: "unclear" },
        { id: "no_secret_egress", p: 0.95, threshold: 0.97, verdict: "satisfied" },
        { id: "no_irreversible_damage", p: 0.95, threshold: 0.8, verdict: "satisfied" },
      ],
    },
    { kind: "ask", ok: true, keys: ["q1"] },
  ];
  const text = formatStats(log, { date: "2026-09-20", requests: 3, inputTokens: 900, outputTokens: 40, usd: 0.0000378 });

  assert.match(text, /请求 3/);
  assert.match(text, /日志里 2 条 decision/, "ask 记录不算 decision");
  assert.match(text, /readonly：1（放行 1 \/ 拦下 0）/);
  assert.match(text, /jev：1（放行 0 \/ 拦下 1）/);
  assert.match(text, /intent_coverage：满足 0 \/ 否定 0 \/ 未明确 1\s+平均 p=0\.35/);
  assert.match(text, /「未明确」占比高/);
});

test("formatStats / formatRecentDecisions：空日志也不崩", () => {
  const empty = formatStats([], { date: "2026-09-20", requests: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
  assert.match(empty, /还没有判定记录/);
  assert.equal(formatRecentDecisions([]), "还没有判定记录。");
});

test("formatRecentDecisions：给出状态、层、耗时与逐条件读数", () => {
  const log: JevJsonObject[] = [
    {
      kind: "decision",
      ts: "2026-09-20T06:00:00.000Z",
      tool: "bash",
      layer: "jev",
      status: "allowed",
      reason: "条件都通过",
      latencyMs: 1104,
      conditions: [{ id: "intent_coverage", p: 0.91, threshold: 0.6, verdict: "satisfied" }],
    },
  ];
  const text = formatRecentDecisions(log);
  assert.match(text, /放行 · bash · jev 层/);
  assert.match(text, /1104ms/);
  assert.match(text, /intent_coverage 0\.91\/0\.6 satisfied/);
});
