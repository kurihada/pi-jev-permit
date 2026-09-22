/**
 * The circuit breaker: when the model refuses this turn's last three calls, stop asking it.
 *
 * The numbers are Codex Auto-review's (three refusals in a row, or ten of the last fifty reviews)
 * because OpenAI's implementation and its Pi port have both been running them in production; see
 * the README. What this file pins is not the numbers but the two boundaries the feature has to
 * keep: a tripped breaker covers **this turn only**, and it never covers a hard deny, one of the
 * user's own deny rules, or anything that touches a credential.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, type Thresholds } from "../src/config.ts";
import { Breaker, type GateDeps, evaluateToolCall, statusLines, userTurnCount } from "../src/gate.ts";
import { type AskResult, EMPTY_USAGE, type JevClient } from "../src/jev.ts";
import { type BashPolicy, mentionsCredentialPath } from "../src/policy.ts";

const T: Thresholds = DEFAULT_CONFIG.thresholds;
const POLICY: BashPolicy = { allow: [], deny: [], extraReadOnly: [], transparentWrappers: ["rtk"] };

interface Counter {
  calls: number;
}

/**
 * A client that answers `true`/`false` per **judgment** (not per request): one refusal costs two
 * requests, because a block asks the follow-up question about why.
 */
function sequenced(sequence: readonly boolean[], counter: Counter): JevClient {
  let judgement = 0;
  return {
    transport: "test",
    usage: () => EMPTY_USAGE("2026-09-21"),
    ask: async (payload): Promise<AskResult> => {
      counter.calls += 1;
      if (!Object.hasOwn(payload.questions, "q_critical")) {
        return { ok: true, answers: { because_outside_task: 0.9 }, model: "test", inputTokens: 1, outputTokens: 0, usd: 0, latencyMs: 1 };
      }
      const allowed = sequence[judgement] ?? sequence[sequence.length - 1] ?? true;
      judgement += 1;
      return {
        ok: true,
        answers: allowed
          ? { q_critical: 0.02, q_risk: 0.2, q_auth: 0.9 }
          : { q_critical: 0.05, q_risk: 0.88, q_auth: 0.2 },
        model: "test",
        inputTokens: 10,
        outputTokens: 1,
        usd: 0,
        latencyMs: 5,
      };
    },
  };
}

function setup(sequence: readonly boolean[] = [false], over: Partial<GateDeps> = {}) {
  const counter: Counter = { calls: 0 };
  const client = sequenced(sequence, counter);
  const breaker = new Breaker({ breakerAfter: 3, cooldownMs: 60_000 });
  const deps = (extra: Partial<GateDeps> = {}): GateDeps => ({
    cwd: "/repo",
    policy: POLICY,
    protectedPaths: [],
    thresholds: T,
    client,
    breaker,
    intent: "clean up the build artefacts",
    latestUserMessage: "clean up the build artefacts",
    isGitRepository: true,
    turnKey: "1",
    ...over,
    ...extra,
  });
  return { counter, breaker, deps };
}

async function refuse(breakerDeps: GateDeps, command: string, times = 3) {
  const verdicts = [];
  for (let index = 0; index < times; index += 1) {
    verdicts.push(await evaluateToolCall("bash", { command }, breakerDeps));
  }
  return verdicts;
}

test("three refusals trip it, and the next call is not sent to the model at all", async () => {
  const { counter, breaker, deps } = setup();

  const refusals = await refuse(deps(), "mkdir -p /tmp/one");
  assert.deepEqual(
    refusals.map((v) => [v.kind, v.layer]),
    [["block", "jev"], ["block", "jev"], ["block", "jev"]],
  );
  assert.equal(breaker.tripped(), true);
  // Each refusal spends two requests (the verdict and its explanation)
  assert.equal(counter.calls, 6);

  const next = await evaluateToolCall("bash", { command: "mkdir -p /tmp/two" }, deps());
  assert.equal(next.kind, "allow");
  assert.equal(next.layer, "breaker");
  assert.equal(counter.calls, 6, "a tripped breaker must not spend another request");
});

test("the trip lasts one turn: the next user message puts the model back in charge", async () => {
  const { counter, deps } = setup();
  await refuse(deps(), "mkdir -p /tmp/one");

  const sameTurn = await evaluateToolCall("bash", { command: "mkdir -p /tmp/two" }, deps());
  assert.equal(sameTurn.layer, "breaker");

  const nextTurn = await evaluateToolCall("bash", { command: "mkdir -p /tmp/three" }, deps({ turnKey: "2" }));
  assert.equal(nextTurn.kind, "block");
  assert.equal(nextTurn.layer, "jev");
  assert.equal(counter.calls, 8, "the new turn is judged again");
});

test("one allow resets the count, so three scattered refusals do not trip it", async () => {
  const { breaker, deps } = setup([false, false, true, false, false]);
  await refuse(deps(), "mkdir -p /tmp/one", 2);
  await evaluateToolCall("bash", { command: "mkdir -p /tmp/ok" }, deps());
  await refuse(deps(), "mkdir -p /tmp/two", 2);

  assert.equal(breaker.tripped(), false);
  assert.equal(breaker.refusals, 2);
});

test("a hard deny is still a hard deny while it is tripped", async () => {
  const { counter, breaker, deps } = setup();
  await refuse(deps(), "mkdir -p /tmp/one");
  assert.equal(breaker.tripped(), true);

  const wiped = await evaluateToolCall("bash", { command: "rm -rf /" }, deps());
  assert.equal(wiped.kind, "block");
  assert.equal(wiped.layer, "harddeny");
  assert.equal(counter.calls, 6, "layer 0 is decided before anything reaches the model");
});

test("the user's own deny rules still fire while it is tripped", async () => {
  const { deps } = setup();
  const withDeny = deps({ policy: { ...POLICY, deny: ["sudo *"] } });
  await refuse(withDeny, "mkdir -p /tmp/one");

  const denied = await evaluateToolCall("bash", { command: "sudo rm -rf build" }, withDeny);
  assert.equal(denied.kind, "block");
  assert.equal(denied.layer, "config");
});

test("a credential read is still judged while it is tripped, not waved through", async () => {
  const { counter, breaker, deps } = setup();
  await refuse(deps(), "mkdir -p /tmp/one");
  assert.equal(breaker.tripped(), true);

  const secret = await evaluateToolCall("bash", { command: "cat /Users/xd/.ssh/id_rsa" }, deps());
  assert.equal(secret.kind, "block");
  assert.equal(secret.layer, "jev");
  assert.equal(counter.calls, 8, "the credential call was still sent to the model");
});

test("a credential path is exempt even when the command is not a known reader", async () => {
  assert.equal(mentionsCredentialPath("rm /Users/xd/.ssh/id_rsa"), true);
  assert.equal(mentionsCredentialPath("mkdir -p /tmp/x"), false);

  const { counter, deps } = setup();
  await refuse(deps(), "mkdir -p /tmp/one");

  const wiped = await evaluateToolCall("bash", { command: "rm /Users/xd/.ssh/id_rsa" }, deps());
  assert.equal(wiped.layer, "jev");
  assert.equal(counter.calls, 8);
});

test("the tripped state is visible in the widget, in English", async () => {
  const { breaker, deps } = setup();
  await refuse(deps(), "mkdir -p /tmp/one");

  const lines = statusLines(breaker, {
    tool: "bash",
    kind: "allow",
    layer: "breaker",
    reason: "circuit breaker tripped this turn",
    summary: "mkdir -p /tmp/two",
  });
  const banner = lines.find((line) => line.includes("circuit breaker tripped"));
  assert.ok(banner !== undefined, `no breaker banner in ${JSON.stringify(lines)}`);
  assert.match(banner, /this turn's remaining calls are not sent to Jev/);
  assert.equal(/[\u4e00-\u9fff]/.test(lines.join("")), false, "the widget must stay English");
  assert.equal(lines[0], "jev-permit allow bash · mkdir -p /tmp/two");
});

test("a fresh breaker is not tripped and counts no refusals", () => {
  const breaker = new Breaker({ breakerAfter: 3, cooldownMs: 60_000 });
  assert.equal(breaker.tripped(), false);
  assert.equal(breaker.refusals, 0);
});

test("userTurnCount: a user message is a turn, an extension message and tool output are not", () => {
  assert.equal(
    userTurnCount([
      { type: "message", message: { role: "user", content: "one" } },
      { type: "message", message: { role: "assistant", content: "two" } },
      { type: "message", message: { role: "user", content: "injected", customType: "plan-mode" } },
      { type: "tool_call", toolName: "bash" },
      { type: "message", message: { role: "user", content: "three" } },
    ]),
    2,
  );
  assert.equal(userTurnCount([]), 0);
});
