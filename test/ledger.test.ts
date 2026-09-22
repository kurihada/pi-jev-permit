/**
 * The history: a repeat of an already-allowed command, and the counters the judgement sees.
 *
 * Two mechanisms, deliberately kept apart. The **repeat layer** is a local short-circuit and therefore
 * carries risk, so it is pinned here with all six of its guards; the **counters** only add evidence and
 * are pinned by shape.
 *
 * The risk it has to keep out: a repeated allow must never become a way to reach something the gates
 * above would refuse, and it must never survive a change in the model's answer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, type Thresholds } from "../src/config.ts";
import { Breaker, type GateDeps, Ledger, buildGateState, evaluateToolCall } from "../src/gate.ts";
import { type AskResult, EMPTY_USAGE, type JevClient } from "../src/jev.ts";
import type { BashPolicy } from "../src/policy.ts";

const T: Thresholds = DEFAULT_CONFIG.thresholds;
const POLICY: BashPolicy = { allow: [], deny: [], extraReadOnly: [], transparentWrappers: ["rtk"] };
const ALLOW = { q_critical: 0.02, q_risk: 0.2, q_auth: 0.9 };

/** A client whose answers are scripted per judgement, counting every request. */
function scripted(answers: readonly (typeof ALLOW)[], counter: { calls: number }): JevClient {
  let judgement = 0;
  return {
    transport: "test",
    usage: () => EMPTY_USAGE("2026-09-21"),
    ask: async (payload): Promise<AskResult> => {
      counter.calls += 1;
      if (!Object.hasOwn(payload.questions, "q_critical")) {
        return { ok: true, answers: { because_outside_task: 0.9 }, model: "test", inputTokens: 1, outputTokens: 0, usd: 0, latencyMs: 1 };
      }
      const next = answers[judgement] ?? answers[answers.length - 1] ?? ALLOW;
      judgement += 1;
      return { ok: true, answers: next, model: "test", inputTokens: 10, outputTokens: 1, usd: 0, latencyMs: 5 };
    },
  };
}

function setup(answers: readonly (typeof ALLOW)[] = [ALLOW], over: Partial<GateDeps> = {}) {
  const counter = { calls: 0 };
  const ledger = new Ledger({ repeatAllowance: 2 });
  const deps = (extra: Partial<GateDeps> = {}): GateDeps => ({
    cwd: "/repo",
    policy: POLICY,
    protectedPaths: [],
    thresholds: T,
    client: scripted(answers, counter),
    breaker: new Breaker({ breakerAfter: 3, cooldownMs: 60_000 }),
    intent: "run the test suite until it passes",
    latestUserMessage: "run the test suite until it passes",
    isGitRepository: true,
    turnKey: "1",
    ledger,
    ...over,
    ...extra,
  });
  return { counter, ledger, deps };
}

test("N=2: the first call is judged, the second is replayed, and the third too", async () => {
  const { counter, deps } = setup();
  const command = "cd /repo && ./test.sh 2>&1 | tail -30";

  const first = await evaluateToolCall("bash", { command }, deps());
  assert.equal(first.kind, "allow");
  assert.equal(first.layer, "jev");
  assert.equal(counter.calls, 1, "the first one pays for a judgement");

  const second = await evaluateToolCall("bash", { command }, deps());
  assert.equal(second.kind, "allow");
  assert.equal(second.layer, "repeat");
  assert.match(second.reason, /already allowed in this turn/);
  assert.equal(counter.calls, 1, "the repeat costs nothing");

  const third = await evaluateToolCall("bash", { command }, deps());
  assert.equal(third.layer, "repeat");
  assert.equal(counter.calls, 1);
});

test("a different command is still judged — repeating is not a class-wide allowance", async () => {
  const { counter, deps } = setup();
  await evaluateToolCall("bash", { command: "git clean -fd" }, deps());
  const other = await evaluateToolCall("bash", { command: "git clean -fdx" }, deps());

  assert.equal(other.layer, "jev");
  assert.equal(counter.calls, 2, "one character of difference means a new judgement");
});

test("a new turn starts the history over", async () => {
  const { counter, deps } = setup();
  await evaluateToolCall("bash", { command: "mkdir -p /tmp/x" }, deps());
  const nextTurn = await evaluateToolCall("bash", { command: "mkdir -p /tmp/x" }, deps({ turnKey: "2" }));

  assert.equal(nextTurn.layer, "jev");
  assert.equal(counter.calls, 2);
});

test("a refusal clears the earlier allows for that command", () => {
  // Tested at the ledger, because through the pipeline the second call is already a repeat: the
  // clearing rule is what makes the *third* one a judgement again, and that is the property here.
  const ledger = new Ledger();
  const key = "bash\u0000mkdir -p /tmp/x";
  ledger.record({ key, turnKey: "1", allowed: true, layer: "jev", facts: { writes: 0, network: false } });
  assert.equal(ledger.modelAllowsThisTurn(key, "1"), 1);

  ledger.record({ key, turnKey: "1", allowed: false, layer: "jev", facts: { writes: 0, network: false } });
  assert.equal(ledger.modelAllowsThisTurn(key, "1"), 0, "the refusal is the model's latest word on it");

  // A block for one command must not clear another command's history.
  ledger.record({ key: "bash\u0000other", turnKey: "1", allowed: true, layer: "jev", facts: { writes: 0, network: false } });
  ledger.record({ key, turnKey: "1", allowed: false, layer: "jev", facts: { writes: 0, network: false } });
  assert.equal(ledger.modelAllowsThisTurn("bash\u0000other", "1"), 1);
});

test("a credential path never takes the repeat layer, even after the model allowed it", async () => {
  const { counter, deps } = setup();
  const command = "cat /Users/xd/.ssh/id_rsa";

  const first = await evaluateToolCall("bash", { command }, deps());
  assert.equal(first.layer, "jev", "the model allowed it (the script says so)");
  const second = await evaluateToolCall("bash", { command }, deps());

  assert.equal(second.layer, "jev", "credentials are the one class no short-circuit may cover");
  assert.equal(counter.calls, 2);
});

test("only a model allow feeds the history: grants and fast paths do not", async () => {
  const { counter, ledger, deps } = setup();
  const command = "mkdir -p /tmp/x";
  ledger.record({ key: "bash\u0000mkdir -p /tmp/x", turnKey: "1", allowed: true, layer: "grant", facts: { writes: 0, network: false } });
  ledger.record({ key: "bash\u0000other", turnKey: "1", allowed: true, layer: "readonly", facts: { writes: 0, network: false } });

  const verdict = await evaluateToolCall("bash", { command }, deps());
  assert.equal(verdict.layer, "jev", "a grant is a human decision for one retry, not a precedent");
  assert.equal(counter.calls, 1);
});

test("a repeat still runs while Jev is unavailable, because the judgement is already in hand", async () => {
  const { ledger } = setup();
  const command = "mkdir -p /tmp/x";
  ledger.record({ key: "bash\u0000mkdir -p /tmp/x", turnKey: "1", allowed: true, layer: "jev", facts: { writes: 0, network: false } });

  const { deps } = setup([ALLOW], { client: null, ledger });
  const verdict = await evaluateToolCall("bash", { command }, deps());
  assert.equal(verdict.kind, "allow");
  assert.equal(verdict.layer, "repeat");

  const judgedAnyway = await evaluateToolCall("bash", { command: "mkdir -p /tmp/y" }, deps());
  assert.equal(judgedAnyway.layer, "unavailable", "anything new still stops when there is no key");
});

test("a hard deny is never a repeat", async () => {
  const { ledger, deps } = setup();
  ledger.record({ key: "bash\u0000rm -rf /", turnKey: "1", allowed: true, layer: "jev", facts: { writes: 0, network: false } });

  const verdict = await evaluateToolCall("bash", { command: "rm -rf /" }, deps());
  assert.equal(verdict.layer, "harddeny");
});

test("with no ledger there is no repeat layer, and nothing else changes", async () => {
  const counter = { calls: 0 };
  const deps: GateDeps = {
    cwd: "/repo",
    policy: POLICY,
    protectedPaths: [],
    thresholds: T,
    client: scripted([ALLOW], counter),
    breaker: new Breaker({ breakerAfter: 3, cooldownMs: 60_000 }),
    intent: "x",
    isGitRepository: true,
    turnKey: "1",
  };
  const command = "mkdir -p /tmp/x";
  assert.equal((await evaluateToolCall("bash", { command }, deps)).layer, "jev");
  assert.equal((await evaluateToolCall("bash", { command }, deps)).layer, "jev");
  assert.equal(counter.calls, 2);
});

test("the counters reach the state, in counts and nothing else", () => {
  const ledger = new Ledger();
  ledger.record({ key: "bash\u0000a", turnKey: "1", allowed: true, layer: "jev", facts: { writes: 2, network: false } });
  ledger.record({ key: "bash\u0000a", turnKey: "1", allowed: true, layer: "repeat", facts: { writes: 0, network: false } });
  ledger.record({ key: "bash\u0000b", turnKey: "1", allowed: false, layer: "jev", facts: { writes: 0, network: true } });

  const summary = ledger.summary("1");
  assert.equal(summary.turnJudged, 3);
  assert.equal(summary.turnAllowed, 2);
  assert.equal(summary.turnBlocked, 1);
  assert.equal(summary.turnDistinct, 2);
  assert.equal(summary.turnRepeats, 1);
  assert.equal(summary.sessionWrites, 2);
  assert.equal(summary.sessionNetwork, 1);

  const state = buildGateState(
    { tool: "bash", operation: "a", reasons: [], userIntent: "x", history: summary },
    { cwd: "/repo", isGitRepository: true, protectedPaths: [] },
  );
  const wire = (state.value as Record<string, unknown>)["history"] as Record<string, Record<string, unknown>>;
  assert.deepEqual(wire["this_turn"], {
    judged: 3,
    allowed: 2,
    blocked: 1,
    distinct_commands: 2,
    repeats: 1,
  });
  assert.equal(wire["this_session"]?.["file_writes"], 2);
  assert.equal(wire["this_session"]?.["network_commands"], 1);
  // Nothing about credentials is ever counted: a count would only be an argument to allow them.
  assert.equal(JSON.stringify(wire).match(/credential/i), null);
});

test("the state carries no history when there is none to carry", () => {
  const state = buildGateState(
    { tool: "bash", operation: "a", reasons: [], userIntent: "x" },
    { cwd: "/repo", isGitRepository: true, protectedPaths: [] },
  );
  assert.equal("history" in (state.value as Record<string, unknown>), false);
});
