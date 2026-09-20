/**
 * The gate: condition combination, breaker, intent extraction, protected paths, end-to-end
 * decisions — all with a fake client, no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, type Thresholds } from "../src/config.ts";
import {
  Breaker,
  type GateDeps,
  NO_INTENT_PLACEHOLDER,
  combine,
  evaluateToolCall,
  extractRecentIntent,
  gateQuestions,
  messageText,
  resolveWriteTarget,
} from "../src/gate.ts";
import { type AskRequest, type AskResult, type JevClient, EMPTY_USAGE } from "../src/jev.ts";
import { type BashPolicy, protectedPathReason, redact } from "../src/policy.ts";

const T: Thresholds = DEFAULT_CONFIG.thresholds;

const POLICY: BashPolicy = { allow: [], deny: [], extraReadOnly: [], transparentWrappers: ["rtk"] };

function fakeClient(result: AskResult): { client: JevClient; calls: AskRequest[] } {
  const calls: AskRequest[] = [];
  const client: JevClient = {
    transport: "test-transport",
    usage: () => EMPTY_USAGE("2026-09-20"),
    ask: async (request: AskRequest) => {
      calls.push(request);
      return result;
    },
  };
  return { client, calls };
}

const allowedAnswers = { allow: 0.9 };

function okResult(answers: Record<string, number> = allowedAnswers): AskResult {
  return { ok: true, answers, model: "test", inputTokens: 10, outputTokens: 1, usd: 0, latencyMs: 7 };
}

function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    cwd: "/repo",
    policy: POLICY,
    protectedPaths: [],
    thresholds: T,
    client: null,
    breaker: new Breaker({ breakerAfter: 3, cooldownMs: 60_000 }),
    intent: "Update the commands in the README",
    isGitRepository: true,
    ...over,
  };
}

// ---------------------------------------------------------------- combine

test("combine: clearly allowed (p >= threshold) → allow", () => {
  const j = combine({ allow: 0.9 }, T);
  assert.equal(j.allow, true);
  assert.equal(j.decidingRule, "allow");
  assert.equal(j.conditions.length, 1, "there is only one condition now");
});

test("combine: threshold boundary — exactly at it allows, just below does not", () => {
  assert.equal(combine({ allow: T.allow }, T).allow, true);
  assert.equal(combine({ allow: T.allow - 0.01 }, T).allow, false);
});

test("combine: fail-closed — unclear means block", () => {
  const muddled = combine({ allow: 0.5 }, T);
  assert.equal(muddled.allow, false);
  assert.match(muddled.reason, /not clearly allowed/);

  // the model did not answer this key
  const missing = combine({}, T);
  assert.equal(missing.allow, false);
  assert.match(missing.reason, /did not answer/);

  // non-finite values are also blocked
  assert.equal(combine({ allow: Number.NaN }, T).allow, false);
  assert.equal(combine({ allow: Number.POSITIVE_INFINITY }, T).allow, false);
});

test("gateQuestions: exactly one question, with all three considerations folded into it", () => {
  const questions = gateQuestions();
  assert.deepEqual(Object.keys(questions), ["allow"]);

  const q = questions["allow"]!;
  assert.equal(q.type, "noul");
  assert.ok(q.criteria?.true);
  assert.ok(q.criteria?.false);
  const instructions = q.instructions as Record<string, unknown>;
  assert.equal(instructions["judge"], "value");
  assert.equal(instructions["reference"], "context");

  // the reasoning is folded into that one question — miss any consideration and the compound
  // judgement goes blind in one corner
  const text = String(instructions["question"]);
  assert.match(text, /user_intent/, "must be within the user's current task");
  assert.match(text, /secret|credential/i, "must not leak credentials");
  assert.match(text, /undo|destroy/i, "must not cause irreversible damage");
  // the considerations are ranked now, not merely conjoined: authorisation is decisive,
  // credentials are un-overridable, and irreversibility weighs rather than vetoes
  assert.match(text, /decisive/, "a direct instruction is decisive");
  assert.match(text, /not a veto/, "irreversibility weighs, it does not veto");
  assert.match(text, /only a human pausing/, "credentials stay un-overridable");
});

// ---------------------------------------------------------------- Breaker

test("breaker: consecutive failures reach the threshold → degraded; re-probe after the cooldown", () => {
  let nowMs = 1_000_000;
  const breaker = new Breaker({ breakerAfter: 3, cooldownMs: 60_000, now: () => nowMs });
  assert.equal(breaker.state(), "ok");
  breaker.recordFailure("unreachable");
  breaker.recordFailure("unreachable");
  assert.equal(breaker.state(), "ok", "two is not enough");
  breaker.recordFailure("unreachable");
  assert.equal(breaker.state(), "degraded");
  assert.equal(breaker.lastReason, "unreachable");

  nowMs += 60_001;
  assert.equal(breaker.state(), "ok", "after the cooldown, allow once as a probe");
  breaker.recordSuccess();
  assert.equal(breaker.failures, 0);
});

test("breaker: a success resets the consecutive-failure count", () => {
  const breaker = new Breaker({ breakerAfter: 2, cooldownMs: 1000, now: () => 0 });
  breaker.recordFailure("x");
  breaker.recordSuccess();
  breaker.recordFailure("x");
  assert.equal(breaker.state(), "ok", "a success in between breaks the streak");
});

test("breaker: pause and auto-resume", () => {
  let nowMs = 0;
  // cooldown 60 min > pause 30 min: after the pause expires it should return to degraded, not straight to ok
  const breaker = new Breaker({ breakerAfter: 3, cooldownMs: 60 * 60_000, now: () => nowMs });
  breaker.recordFailure("x");
  breaker.recordFailure("x");
  breaker.recordFailure("x");
  breaker.pause(30 * 60_000);
  assert.equal(breaker.state(), "paused", "pause wins over degraded");
  assert.equal(breaker.pauseRemainingMs(), 30 * 60_000);
  nowMs += 30 * 60_001;
  assert.equal(breaker.state(), "degraded", "after the pause expires, back to the real state");
  breaker.resume();
  assert.equal(breaker.state(), "degraded");
});

// ---------------------------------------------------------------- Intent

test("intent: only user messages, skipping extension-injected and assistant", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "first request" } },
    { type: "message", message: { role: "assistant", content: "I don't count" } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "second request" }] } },
    { type: "message", message: { role: "user", content: "extension-injected", customType: "plan-mode" } },
    { type: "tool_result", content: "tool output doesn't count" },
  ];
  assert.equal(extractRecentIntent(branch), "first request\n\nsecond request");
  assert.equal(extractRecentIntent([]), "");
});

test("messageText: string / parts / other types", () => {
  assert.equal(messageText("abc"), "abc");
  assert.equal(messageText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(messageText(42), "");
  assert.equal(messageText(undefined), "");
});

// ---------------------------------------------------------------- Protected paths

test("protected paths: credentials, repo metadata, agent instruction files", () => {
  for (const path of [
    "/Users/xd/.ssh/id_rsa",
    "/repo/.git/config",
    "/Users/xd/.pi/agent/settings.json",
    "/repo/.env",
    "/repo/.env.local",
    "/repo/AGENTS.md",
    "/Users/xd/.aws/credentials",
    "/repo/.github/workflows/ci.yml",
    "/repo/npm-debug.pem",
  ]) {
    assert.notEqual(protectedPathReason(path), null, path);
  }
  for (const path of ["/repo/src/policy.ts", "/repo/README.md", "/repo/.env.example", "/repo/src/config.ts"]) {
    assert.equal(protectedPathReason(path), null, path);
  }
});

test("protected paths: an exempt prefix always passes (otherwise you can't even edit your own config)", () => {
  const config = "/Users/xd/.pi/agent/pi-jev-permit.json";
  assert.notEqual(protectedPathReason(config), null, "the .pi segment is protected by default");
  assert.equal(protectedPathReason(config, [], ["/Users/xd/.pi/agent/pi-jev-permit"]), null);
});

test("protected paths: extra config patterns (substring or glob)", () => {
  assert.notEqual(protectedPathReason("/opt/company/secrets/x.txt", ["/opt/company/"]), null);
  assert.notEqual(protectedPathReason("/repo/docs/private.md", ["**/private.md"]), null);
  assert.equal(protectedPathReason("/repo/docs/public.md", ["**/private.md"]), null);
});

// ---------------------------------------------------------------- Redaction

test("redaction: common credential shapes are scrubbed", () => {
  const samples = [
    "ghp_abcdefghijklmnopqrstuvwxyz01",
    "AKIAIOSFODNN7EXAMPLE",
    "sk-abcdefghijklmnopqrstuvwx",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk",
    "Authorization: Bearer abcdefghijklmnopqrstuvwx",
    "api_key = 'abcdefghijklmnop'",
  ];
  for (const sample of samples) {
    const out = redact(`curl -H "${sample}" https://x.dev`);
    assert.ok(!out.includes(sample), `not scrubbed: ${sample} → ${out}`);
    assert.ok(out.includes("<redacted>"));
  }
});

// ---------------------------------------------------------------- Write target

test("write target: relative vs absolute path", () => {
  assert.deepEqual(resolveWriteTarget({ path: "src/a.ts" }, "/repo"), {
    absolutePath: "/repo/src/a.ts",
    relativePath: "src/a.ts",
    outsideCwd: false,
  });
  assert.equal(resolveWriteTarget({ path: "/tmp/a.ts" }, "/repo")?.outsideCwd, true);
  assert.equal(resolveWriteTarget({ file_path: "/tmp/a.ts" }, "/repo")?.absolutePath, "/tmp/a.ts");
  assert.equal(resolveWriteTarget({}, "/repo"), null);
});

// ---------------------------------------------------------------- End to end

test("end-to-end: tools outside the gate's scope pass through", async () => {
  const v = await evaluateToolCall("read", {}, deps());
  assert.equal(v.kind, "allow");
  assert.equal(v.layer, "config");
});

test("end-to-end: read-only commands take layer ②, no Jev call", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall("bash", { command: "ls -la" }, deps({ client: f.client }));
  assert.equal(v.kind, "allow");
  assert.equal(v.layer, "readonly");
  assert.equal(f.calls.length, 0, "the fast path must not hit the network");
});

test("end-to-end: rtk wrapping + lazy assignment also skips Jev", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall(
    "bash",
    { command: "export RTK_DB_PATH='/tmp/h.db'; rtk ls -l /tmp" },
    deps({ client: f.client }),
  );
  assert.equal(v.kind, "allow");
  assert.equal(f.calls.length, 0);
});

test("end-to-end: hard deny runs before Jev and no probability can override it", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall("bash", { command: "rm -rf /" }, deps({ client: f.client }));
  assert.equal(v.kind, "block");
  assert.equal(v.layer, "harddeny");
  assert.equal(f.calls.length, 0);
});

test("end-to-end: a deny-rule hit also skips Jev", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall(
    "bash",
    { command: "sudo ls" },
    deps({ client: f.client, policy: { ...POLICY, deny: ["sudo *"] } }),
  );
  assert.equal(v.kind, "block");
  assert.equal(v.layer, "config");
  assert.equal(f.calls.length, 0);
});

test("end-to-end: a judged command carries intent, reasons, and the redacted command", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall(
    "bash",
    { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwx' https://x.dev" },
    deps({ client: f.client }),
  );
  assert.equal(v.kind, "allow");
  assert.equal(v.layer, "jev");
  assert.equal(f.calls.length, 1);

  const state = f.calls[0]!.state.value as Record<string, unknown>;
  assert.equal(state["tool"], "bash");
  assert.ok(String(state["operation"]).includes("<redacted>"), "a credential in the command must be scrubbed");
  assert.equal(state["user_intent"], "Update the commands in the README");
  // Wording is policy.ts's business: assert that a reason was carried, not what it says.
  const reasons = state["matched_policy_reasons"] as string[];
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /curl/);
  assert.ok(f.calls[0]!.questions["allow"]);
});

test("end-to-end: no key blocks layer ③ while layers ①② still work", async () => {
  const blocked = await evaluateToolCall("bash", { command: "npm install" }, deps({ client: null }));
  assert.equal(blocked.kind, "block");
  assert.equal(blocked.layer, "unavailable");

  const allowed = await evaluateToolCall("bash", { command: "ls -la" }, deps({ client: null }));
  assert.equal(allowed.kind, "allow", "read-only commands don't depend on Jev");
  assert.equal(allowed.layer, "readonly");
});

test("end-to-end: a failed judgement feeds the breaker and degrades later calls", async () => {
  const failing: JevClient = {
    transport: "test",
    usage: () => EMPTY_USAGE("2026-09-20"),
    ask: async () => ({ ok: false, reason: "network", detail: "unreachable", latencyMs: 3 }),
  };
  const breaker = new Breaker({ breakerAfter: 1, cooldownMs: 60_000, now: () => 0 });
  const d = deps({ client: failing, breaker });

  const first = await evaluateToolCall("bash", { command: "npm install" }, d);
  assert.equal(first.kind, "block");
  assert.equal(first.layer, "unavailable");
  assert.match(first.reason, /unreachable/);

  const second = await evaluateToolCall("bash", { command: "npm install" }, d);
  assert.equal(second.layer, "degraded", "already degraded, no more network calls");
  assert.match(second.reason, /now degraded/);

  // degradation does not affect layers ①②
  assert.equal((await evaluateToolCall("bash", { command: "git status" }, d)).kind, "allow");
});

test("end-to-end: everything passes while paused", async () => {
  const breaker = new Breaker({ breakerAfter: 1, cooldownMs: 60_000, now: () => 0 });
  breaker.pause(60_000);
  const v = await evaluateToolCall("bash", { command: "npm install" }, deps({ breaker }));
  assert.equal(v.kind, "allow");
  assert.equal(v.layer, "paused");
});

test("end-to-end: an empty intent uses the placeholder (must not read as 'asked for nothing, so anything goes')", async () => {
  const f = fakeClient(okResult({ allow: 0.1 }));
  const v = await evaluateToolCall("bash", { command: "npm install" }, deps({ client: f.client, intent: "" }));
  const state = f.calls[0]!.state.value as Record<string, unknown>;
  assert.equal(state["user_intent"], NO_INTENT_PLACEHOLDER);
  assert.equal(v.kind, "block");
  assert.equal(v.judgment?.decidingRule, "allow");
});

test("end-to-end: an ordinary in-project write is not judged, and its content is not read", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall(
    "write",
    { path: "src/a.ts", content: "export const secret = 'x'" },
    deps({ client: f.client }),
  );
  assert.equal(v.kind, "allow");
  assert.equal(v.layer, "config");
  assert.equal(f.calls.length, 0);
});

test("end-to-end: writing a protected path is judged, and the state carries no file content", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall(
    "write",
    { path: "/Users/xd/.ssh/authorized_keys", content: "ssh-rsa AAAA" },
    deps({ client: f.client }),
  );
  assert.equal(v.kind, "allow");
  assert.equal(v.layer, "jev");
  const state = f.calls[0]!.state.value as Record<string, unknown>;
  assert.equal(state["operation"], "/Users/xd/.ssh/authorized_keys");
  assert.equal(state["outside_working_directory"], true);
  assert.ok(!Object.keys(state).includes("content"), "never send file contents");
  assert.ok(
    (state["matched_policy_reasons"] as string[]).length > 0,
    "carries the protected-path reason",
  );
});

test("end-to-end: writing outside the working directory, even if not protected, is judged", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall("edit", { path: "/tmp/notes.md", edits: [{}, {}] }, deps({ client: f.client }));
  assert.equal(v.layer, "jev");
  const state = f.calls[0]!.state.value as Record<string, unknown>;
  assert.equal(state["outside_working_directory"], true);
  assert.equal(state["edit_count"], 2);
});

test("end-to-end: this package's own config is writable (exempt)", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall(
    "write",
    { path: "/Users/xd/.pi/agent/pi-jev-permit.json", content: "{}" },
    deps({ client: f.client, exemptPaths: ["/Users/xd/.pi/agent/pi-jev-permit"] }),
  );
  assert.equal(v.kind, "allow");
  assert.equal(f.calls.length, 0);
});
