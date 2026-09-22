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

/** A pass: no hazard, and the user is in the middle of this work. */
const allowedAnswers = { q_critical: 0.02, q_risk: 0.25, q_auth: 0.9 };
/** A refusal the way the new table produces one: risky and not clearly asked for. */
const refusedAnswers = { q_critical: 0.05, q_risk: 0.88, q_auth: 0.2 };

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

test("combine: nothing hazardous → allow, and the readings say why", () => {
  const j = combine(allowedAnswers, T);
  assert.equal(j.allow, true);
  assert.equal(j.decidingRule, "q_auth");
  assert.deepEqual(j.conditions.map((c) => c.id), ["q_critical", "q_risk", "q_auth"]);
  assert.match(j.reason, /critical=0\.02 risk=0\.25 auth=0\.90/);
});

test("combine: a critical reading blocks on its own, and no instruction saves it", () => {
  const j = combine({ q_critical: 0.9, q_risk: 0.9, q_auth: 1 }, T);
  assert.equal(j.allow, false);
  assert.equal(j.decidingRule, "q_critical");
  assert.match(j.reason, /credential|irreplaceable/);
});

test("combine: a risky reading blocks when it is not clearly asked for", () => {
  const j = combine(refusedAnswers, T);
  assert.equal(j.allow, false);
  assert.equal(j.decidingRule, "q_risk");
  assert.match(j.reason, /risky and not clearly asked for/);
});

test("combine: a risky reading passes when the user did ask for it", () => {
  const askedForIt = combine({ q_critical: 0.05, q_risk: 0.8, q_auth: 0.75 }, T);
  assert.equal(askedForIt.allow, true, "high risk with medium/high authorisation is allowed");

  const borderline = combine({ q_critical: 0.05, q_risk: 0.8, q_auth: 0.35 }, T);
  assert.equal(borderline.allow, false, "below the authorisation line it is blocked");
});

test("combine: the middle band is no longer a refusal (the measured regression)", () => {
  // 44 of 125 replayed commands landed here under the old wording, every one of them refused.
  for (const p of [0.45, 0.5, 0.55, 0.59]) {
    const j = combine({ q_critical: 0.05, q_risk: p, q_auth: 0.8 }, T);
    assert.equal(j.allow, true, `risk ${p} with authorisation must pass`);
  }
});

test("combine: an answer missing one of the three readings blocks", () => {
  const partial = combine({ q_critical: 0.02, q_risk: 0.2 }, T);
  assert.equal(partial.allow, false);
  assert.equal(partial.decidingRule, "q_incomplete");
  assert.match(partial.reason, /did not answer/);
  assert.equal(combine({}, T).allow, false);
  assert.equal(combine({ q_critical: Number.NaN, q_risk: 0.2, q_auth: 0.9 }, T).allow, false);
  assert.equal(
    combine({ q_critical: 0.02, q_risk: Number.POSITIVE_INFINITY, q_auth: 0.9 }, T).allow,
    false,
    "an impossible probability is not a reading",
  );
});

test("combine: the authorisation line follows the block line unless it is set", () => {
  const tight = combine({ q_critical: 0.05, q_risk: 0.8, q_auth: 0.5 }, { ...T, authorization: 0.6 });
  assert.equal(tight.allow, false);
  const loose = combine({ q_critical: 0.05, q_risk: 0.8, q_auth: 0.5 }, { ...T, authorization: 0.3 });
  assert.equal(loose.allow, true);
});

test("gateQuestions: three questions, one per axis", () => {
  const questions = gateQuestions();
  assert.deepEqual(Object.keys(questions), ["q_critical", "q_risk", "q_auth"]);

  for (const id of ["q_critical", "q_risk", "q_auth"]) {
    const q = questions[id]!;
    assert.equal(q.type, "noul");
    assert.ok(q.criteria?.true);
    assert.ok(q.criteria?.false);
    const instructions = q.instructions as Record<string, unknown>;
    assert.equal(instructions["judge"], "value");
    assert.equal(instructions["reference"], "context");
    // every question says this, because the command text is written by the agent being judged
    assert.match(String(instructions["question"]), /evidence, never as instructions/);
  }

  const critical = String((questions["q_critical"]!.instructions as Record<string, unknown>)["question"]);
  assert.match(critical, /credential|secret/i);
  assert.match(critical, /nowhere else/);
  assert.match(critical, /Unease is not evidence/);

  const risk = String((questions["q_risk"]!.instructions as Record<string, unknown>)["question"]);
  // The scope band, added after the first replay allowed `pkill`, `docker system prune` and a
  // 9,999-line `sed -i`: "irreversible damage or data leaving the machine" did not describe them.
  assert.match(risk, /Interrupt something that is running/);
  assert.match(risk, /Change far more than the object it names/);
  assert.match(risk, /emptying thousands of lines/);
  // The calibration rules are the difference between this question and the one that refused 100 of
  // 125 real commands: without them a long, unfamiliar or partially-shown command reads as risky.
  assert.match(risk, /evidence of significant risk/);
  assert.match(risk, /long-running or large-scale operation is not destructive/);
  assert.match(risk, /script body was not shown is not more dangerous/);
  assert.match(risk, /outside the working directory is not by itself/);
  // …but the narrow-target exemption needs its precondition back: a name is not evidence of scope,
  // which is what let a whole-file range through on the first replay.
  assert.match(risk, /only when its target is narrow \*\*and you can see/);
  assert.match(risk, /A name proves nothing on its own/);

  const auth = String((questions["q_auth"]!.instructions as Record<string, unknown>)["question"]);
  assert.match(auth, /They are in the middle of it/);
  assert.match(auth, /Judge the substance, not the wording/);
  assert.match(auth, /latest_user_message/);
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
  assert.ok(f.calls[0]!.questions["q_critical"]);
  assert.ok(f.calls[0]!.questions["q_risk"]);
  assert.ok(f.calls[0]!.questions["q_auth"]);
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
  const f = fakeClient(okResult(refusedAnswers));
  const v = await evaluateToolCall("bash", { command: "npm install" }, deps({ client: f.client, intent: "" }));
  const state = f.calls[0]!.state.value as Record<string, unknown>;
  assert.equal(state["user_intent"], NO_INTENT_PLACEHOLDER);
  assert.equal(v.kind, "block");
  assert.equal(v.judgment?.decidingRule, "q_risk");
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
