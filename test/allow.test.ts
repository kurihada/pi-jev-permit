/**
 * `/jev-permit allow`: one retry of one refused call — and the two things it must never do.
 *
 *   1. **Layer 0 cannot be granted.** A recursive delete of a root is not a scheduling problem.
 *      The grant check sits after `decideBash`, so a hard deny (and a deny rule, and the
 *      read-only fast path) returns before anything is written to the list — structural, not a
 *      check someone has to remember.
 *   2. **A credential refusal cannot be granted.** That class belongs to `/jev-permit pause` and
 *      to a human; it is the one rule this whole gate exists to keep. The refusal class comes from
 *      the follow-up question the gate already asks on every block.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, type Thresholds } from "../src/config.ts";
import {
  AllowGrants,
  Breaker,
  CREDENTIAL_BLOCK_CLASS,
  type GateDeps,
  evaluateToolCall,
  refusalOption,
  refusalOptionId,
} from "../src/gate.ts";
import { type AskResult, EMPTY_USAGE, type JevClient } from "../src/jev.ts";
import type { BashPolicy } from "../src/policy.ts";

const T: Thresholds = DEFAULT_CONFIG.thresholds;
const POLICY: BashPolicy = { allow: [], deny: [], extraReadOnly: [], transparentWrappers: ["rtk"] };

function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    cwd: "/repo",
    policy: POLICY,
    protectedPaths: [],
    thresholds: T,
    client: null,
    breaker: new Breaker({ breakerAfter: 3, cooldownMs: 60_000 }),
    intent: "tidy the build artifacts",
    latestUserMessage: "tidy the build artifacts",
    isGitRepository: true,
    ...over,
  };
}

function blockAnswers(reasonClass: string): Record<string, number> {
  return {
    because_outside_task: 0.05,
    because_credential_risk: reasonClass === CREDENTIAL_BLOCK_CLASS ? 0.91 : 0.02,
    because_irreversible_risk: reasonClass === "because_irreversible_risk" ? 0.88 : 0.04,
  };
}

/** A refusal the way the three-question table produces one: risky and not clearly asked for. */
const refusedAnswers = { q_critical: 0.05, q_risk: 0.88, q_auth: 0.2 };

/** Refuses the first question and names `reasonClass` on the follow-up (the gate asks two different sets). */
function refusingClient(reasonClass: string): JevClient {
  return {
    transport: "test",
    usage: () => EMPTY_USAGE("2026-09-20"),
    ask: async (payload: Parameters<JevClient["ask"]>[0]): Promise<AskResult> => {
      const primary = Object.hasOwn(payload.questions, "q_critical");
      return {
        ok: true,
        answers: primary ? refusedAnswers : blockAnswers(reasonClass),
        model: "test",
        inputTokens: 10,
        outputTokens: 1,
        usd: 0,
        latencyMs: 5,
      };
    },
  };
}

test("a refusal can be granted once, and the retry spends the grant", async () => {
  const grants = new AllowGrants({ now: () => 1_000 });
  const d = deps({ client: refusingClient("because_irreversible_risk"), grants });

  const refused = await evaluateToolCall("bash", { command: "git clean -fd" }, d);
  assert.equal(refused.kind, "block");
  assert.equal(refused.reasonClass, "because_irreversible_risk");
  assert.equal(grants.list().length, 1, "a model refusal is what `allow` may point at");

  const issued = grants.grant(grants.list()[0]!.id);
  assert.equal(issued.ok, true);

  const retry = await evaluateToolCall("bash", { command: "git clean -fd" }, d);
  assert.equal(retry.kind, "allow");
  assert.equal(retry.layer, "grant");
  assert.match(retry.reason, /allowed once/);
  // Wording-agnostic on purpose: the policy reason comes from the read-only table, which is not
  // what this test is about, and pinning its phrasing is how a test starts lying.
  assert.ok(Array.isArray(retry.policyReasons) && retry.policyReasons.length > 0);

  const again = await evaluateToolCall("bash", { command: "git clean -fd" }, d);
  assert.equal(again.kind, "block", "one approval per refusal, never a standing permission");
});

test("a grant covers that exact call only", async () => {
  const grants = new AllowGrants({ now: () => 1_000 });
  const d = deps({ client: refusingClient("because_irreversible_risk"), grants });
  await evaluateToolCall("bash", { command: "git clean -fd" }, d);
  grants.grant(grants.list()[0]!.id);

  const other = await evaluateToolCall("bash", { command: "git clean -fdx" }, d);
  assert.equal(other.kind, "block", "a different command is a different refusal");
});

test("a credential refusal cannot be granted", async () => {
  const grants = new AllowGrants({ now: () => 1_000 });
  const d = deps({ client: refusingClient(CREDENTIAL_BLOCK_CLASS), grants });

  const refused = await evaluateToolCall("bash", { command: "cat ~/.ssh/id_rsa" }, d);
  assert.equal(refused.kind, "block");
  assert.equal(refused.reasonClass, CREDENTIAL_BLOCK_CLASS);

  const issued = grants.grant(grants.list()[0]!.id);
  assert.equal(issued.ok, false);
  assert.match(issued.ok === false ? issued.reason : "", /credential/);

  const retry = await evaluateToolCall("bash", { command: "cat ~/.ssh/id_rsa" }, d);
  assert.equal(retry.kind, "block", "the refusal stands: pause is the only way through");
  assert.equal(retry.layer, "jev");
});

test("layer 0 never reaches the list at all", async () => {
  const grants = new AllowGrants();
  const d = deps({ client: refusingClient("because_irreversible_risk"), grants });

  const verdict = await evaluateToolCall("bash", { command: "rm -rf /" }, d);
  assert.equal(verdict.kind, "block");
  assert.equal(verdict.layer, "harddeny");
  assert.equal(grants.list().length, 0, "the hard deny returned before anything could be recorded");
  assert.equal(grants.grant(1).ok, false);
});

test("a deny rule and the read-only fast path never reach it either", async () => {
  const grants = new AllowGrants();
  const d = deps({
    client: refusingClient("because_irreversible_risk"),
    grants,
    policy: { ...POLICY, deny: ["npm publish*"] },
  });

  assert.equal((await evaluateToolCall("bash", { command: "npm publish" }, d)).layer, "config");
  assert.equal((await evaluateToolCall("bash", { command: "ls -la" }, d)).layer, "readonly");
  assert.equal(grants.list().length, 0, "only the model's own refusals are listed");
});

test("a grant expires", async () => {
  let clock = 1_000;
  const grants = new AllowGrants({ now: () => clock, ttlMs: 60_000 });
  const d = deps({ client: refusingClient("because_irreversible_risk"), grants });
  await evaluateToolCall("bash", { command: "git clean -fd" }, d);
  assert.equal(grants.grant(grants.list()[0]!.id).ok, true);

  clock += 60_001;
  const late = await evaluateToolCall("bash", { command: "git clean -fd" }, d);
  assert.equal(late.kind, "block", "sixty seconds is the whole window");
});

test("a grant cannot wave a call through a gate that is not judging", async () => {
  const grants = new AllowGrants({ now: () => 1_000 });
  const d = deps({ client: refusingClient("because_irreversible_risk"), grants });
  await evaluateToolCall("bash", { command: "git clean -fd" }, d);
  assert.equal(grants.grant(grants.list()[0]!.id).ok, true);

  const noKey = await evaluateToolCall("bash", { command: "git clean -fd" }, { ...d, client: null });
  assert.equal(noKey.kind, "block");
  assert.equal(noKey.layer, "unavailable", "no key is not something a grant may bypass");
});

// The picker (`ctx.ui.select`) hands back the chosen string, not an index, so the line has to carry
// the id it stands for. These two tests are that round trip.
test("a picker line carries the id it stands for", () => {
  const line = refusalOption({ id: 7, tool: "bash", summary: "git clean -fd", reason: "x" });
  assert.equal(line, "#7  bash  git clean -fd");
  assert.equal(refusalOptionId(line), 7);
  assert.equal(refusalOptionId("bash  git clean -fd"), null, "a line without an id is not a choice");
  assert.equal(refusalOptionId(""), null);
});

test("a credential refusal says so, and a long command is shortened", () => {
  const line = refusalOption({
    id: 2,
    tool: "bash",
    summary: "cat /Users/xd/.ssh/id_rsa",
    reason: "x",
    reasonClass: CREDENTIAL_BLOCK_CLASS,
  });
  assert.match(line, /pause only/, "the reader has to see that allow is not an option here");
  assert.equal(refusalOptionId(line), 2);

  const long = refusalOption({ id: 3, tool: "bash", summary: "x".repeat(200), reason: "x" });
  assert.ok(long.length < 120, "the picker is one line wide");
  assert.equal(refusalOptionId(long), 3);
});
