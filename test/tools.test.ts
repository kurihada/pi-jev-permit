/**
 * Consumers 2+3 (tools.ts) plus the entry point's pure helpers (index.ts).
 * A fake pi captures the registered tools and a fake client executes them — no network, no pi.
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

test("buildEvaluateQuestions: key is the answer key, missing criteria falls back to defaults", () => {
  const questions = buildEvaluateQuestions([
    { key: "a", question: "condition A" },
    { key: "b", question: "condition B", criteria: { true: "yes", false: "no" } },
  ]);
  assert.deepEqual(Object.keys(questions).sort(), ["a", "b"]);
  assert.equal(questions["a"]!.type, "noul");
  assert.equal(questions["a"]!.instructions, "condition A");
  assert.ok(questions["a"]!.criteria?.false, "no criteria means the default (the middle band must exist)");
  assert.equal(questions["b"]!.criteria?.true, "yes");
});

test("buildEvaluateQuestions: entries past the cap are dropped", () => {
  const many = Array.from({ length: MAX_EVALUATE_QUESTIONS + 5 }, (_v, i) => ({ key: `k${i}`, question: "q" }));
  assert.equal(Object.keys(buildEvaluateQuestions(many)).length, MAX_EVALUATE_QUESTIONS);
});

test("formatEvaluateResult: numbers on success, and 'this is not no objection' on failure", () => {
  const good = formatEvaluateResult(okAnswers({ safe: 0.93 }));
  assert.match(good, /safe = 0\.930/);
  assert.match(good, /not authorization/);

  const bad = formatEvaluateResult({ ok: false, reason: "network", detail: "unreachable", latencyMs: 3 });
  assert.match(bad, /unreachable/);
  assert.match(bad, /no objection/);
});

test("buildToolState: passes state through but redacted, falls back to context when absent", () => {
  const passed = buildToolState({ state: { value: { note: "api_key = 'abcdefghijklmnop'" } } });
  assert.ok(JSON.stringify(passed).includes("<redacted>"), "a passed-through state is redacted too");

  const fallback = buildToolState({ context: "background" });
  assert.deepEqual(fallback, { value: { context: "background" } });

  assert.deepEqual(buildToolState({}), { value: { context: "" } });
});

// ---------------------------------------------------------------- ask_advisor

test("ask_advisor question set: all three are 'trouble' directions, high p = trouble", () => {
  const questions = buildAdvisorQuestions();
  assert.deepEqual(Object.keys(questions).sort(), ["blind_spot", "misread_request", "should_stop_and_ask"]);
  for (const q of Object.values(questions)) {
    assert.equal(q.type, "noul");
    assert.ok(q.criteria?.false);
  }
});

test("summarizeAdvice: no signal says carry on, a signal names which one", () => {
  const calm = summarizeAdvice({ blind_spot: 0.2, misread_request: 0.3, should_stop_and_ask: 0.4 });
  assert.match(calm, /No clear signal/);
  assert.match(calm, /not authorization/);

  const loud = summarizeAdvice({ blind_spot: 0.81, misread_request: 0.2, should_stop_and_ask: 0.65 });
  assert.match(loud, /Signal raised/);
  assert.match(loud, /the plan has a real defect/);
  assert.match(loud, /better to stop and ask first/);

  // boundary: exactly at the threshold counts as an alert
  assert.match(summarizeAdvice({ blind_spot: ADVISOR_ALERT_THRESHOLD }), /Signal raised/);
  // missing fields are skipped, no crash
  assert.match(summarizeAdvice({}), /No clear signal/);
});

// ---------------------------------------------------------------- tool wiring

test("registerTools: registers two tools, both descriptions say 'not authorization'", () => {
  const { pi, specs } = fakePi();
  const f = fakeClient(okAnswers({ safe: 0.9 }));
  registerTools(pi, { makeClient: () => f.client });

  assert.deepEqual(specs.map((s) => s.name).sort(), ["ask_advisor", "jev_evaluate"]);
  for (const spec of specs) {
    assert.match(spec.description, /not authorization/);
    assert.ok(spec.parameters, "must have a parameter schema");
    assert.ok(spec.label.length > 0);
  }
});

test("jev_evaluate.execute: sends the questions out and gives the model the probabilities", async () => {
  const { pi, specs } = fakePi();
  const f = fakeClient(okAnswers({ ready: 0.88 }));
  registerTools(pi, { makeClient: () => f.client });
  const spec = specs.find((s) => s.name === "jev_evaluate")!;

  const result = await spec.execute("call-1", { questions: [{ key: "ready", question: "is it ready?" }] });
  assert.match(result.content[0]!.text, /ready = 0\.880/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(f.calls[0]!.questions), ["ready"]);
});

test("jev_evaluate.execute: no key / no questions gives a readable hint without touching the network", async () => {
  const { pi, specs } = fakePi();
  const f = fakeClient(okAnswers({}));
  registerTools(pi, { makeClient: () => null });
  const spec = specs.find((s) => s.name === "jev_evaluate")!;

  assert.match((await spec.execute("c", { questions: [{ key: "a", question: "b" }] })).content[0]!.text, /login/);

  registerTools(pi, { makeClient: () => f.client });
  const withClient = specs.filter((spec) => spec.name === "jev_evaluate").at(-1)!;
  assert.match((await withClient.execute("c", { questions: [] })).content[0]!.text, /At least one question/);
  assert.equal(f.calls.length, 0);
});

test("ask_advisor.execute: puts plan and user_request into the state", async () => {
  const { pi, specs } = fakePi();
  const f = fakeClient(okAnswers({ blind_spot: 0.7, misread_request: 0.1, should_stop_and_ask: 0.2 }));
  registerTools(pi, { makeClient: () => f.client });
  const spec = specs.find((s) => s.name === "ask_advisor")!;

  const result = await spec.execute("c", { plan: "rewrite the whole module", context: "the user wants one typo fixed" });
  const state = f.calls[0]!.state.value as Record<string, unknown>;
  assert.equal(state["plan"], "rewrite the whole module");
  assert.equal(state["user_request"], "the user wants one typo fixed");
  assert.match(result.content[0]!.text, /the plan has a real defect/);

  const empty = await spec.execute("c", { plan: "  " });
  assert.match(empty.content[0]!.text, /plan must not be empty/);
});

// ---------------------------------------------------------------- entry helpers

test("parseDurationMs: 30m / 2h / 45 / unparseable", () => {
  assert.equal(parseDurationMs("30m"), 30 * 60_000);
  assert.equal(parseDurationMs("2h"), 2 * 3_600_000);
  assert.equal(parseDurationMs("45"), 45 * 60_000);
  assert.equal(parseDurationMs("90s"), 90_000);
  assert.equal(parseDurationMs(""), 30 * 60_000, "empty string falls back");
  assert.equal(parseDurationMs("abc"), 30 * 60_000);
  assert.equal(parseDurationMs("0"), 1_000, "one-second floor");
});

test("exemptPaths: this package's own config and logs are writable, the credentials dir is not", () => {
  const paths = exemptPaths("/agent");
  assert.deepEqual(paths, ["/agent/pi-jev-suite"]);
  assert.ok(!paths[0]!.includes("secrets"), "credentials are written by the login command, not exempted for tools");
});

test("formatStats: per-layer counts + condition readings + the 'unclear' hint", () => {
  const log: JevJsonObject[] = [
    { kind: "decision", layer: "readonly", status: "allowed", tool: "bash" },
    {
      kind: "decision",
      layer: "jev",
      status: "blocked",
      tool: "bash",
      latencyMs: 1200,
      reason: "not clearly covered by the user request",
      conditions: [
        { id: "intent_coverage", p: 0.35, threshold: 0.6, verdict: "unclear" },
        { id: "no_secret_egress", p: 0.95, threshold: 0.97, verdict: "satisfied" },
        { id: "no_irreversible_damage", p: 0.95, threshold: 0.8, verdict: "satisfied" },
      ],
    },
    { kind: "ask", ok: true, keys: ["q1"] },
  ];
  const text = formatStats(log, { date: "2026-09-20", requests: 3, inputTokens: 900, outputTokens: 40, usd: 0.0000378 });

  assert.match(text, /requests 3/);
  assert.match(text, /2 decisions in the log/, "an ask record is not a decision");
  assert.match(text, /readonly: 1 \(allowed 1 \/ blocked 0\)/);
  assert.match(text, /jev: 1 \(allowed 0 \/ blocked 1\)/);
  assert.match(text, /intent_coverage: satisfied 0 \/ rejected 0 \/ unclear 1\s+avg p=0\.35/);
  assert.match(text, /barely decides anything/);
});

test("formatStats / formatRecentDecisions: empty logs do not crash", () => {
  const empty = formatStats([], { date: "2026-09-20", requests: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
  assert.match(empty, /no decisions recorded yet/);
  assert.equal(formatRecentDecisions([]), "No decisions recorded yet.");
});

test("formatRecentDecisions: gives status, layer, latency and per-condition readings", () => {
  const log: JevJsonObject[] = [
    {
      kind: "decision",
      ts: "2026-09-20T06:00:00.000Z",
      tool: "bash",
      layer: "jev",
      status: "allowed",
      reason: "all conditions passed",
      latencyMs: 1104,
      conditions: [{ id: "intent_coverage", p: 0.91, threshold: 0.6, verdict: "satisfied" }],
    },
  ];
  const text = formatRecentDecisions(log);
  assert.match(text, /allowed · bash · jev/);
  assert.match(text, /1104ms/);
  assert.match(text, /intent_coverage 0\.91\/0\.6 satisfied/);
});
