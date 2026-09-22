/**
 * Shadow mode: judge everything, enforce the model's refusals never.
 *
 * The point of it is data — what the gate *would* have refused on real traffic, collected while no
 * work is interrupted. That makes two properties load-bearing, and neither is about convenience:
 *
 * - it may only ever make the **model's own** refusals pass. Layer 0, the deny rules, an unavailable
 *   endpoint and the breaker all still apply, so a window cannot become a way around the policy; and
 * - a **credential** refusal is exempt from the window entirely, because that is the one class an
 *   instruction may not override, and a window is not an instruction.
 *
 * (Vercel's `@ai-sdk/policy-opa` ships the same idea: "Do not ship a new policy straight to enforce.
 * The first version almost always denies things you did not mean to.")
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { AllowGrants, Breaker, CREDENTIAL_BLOCK_CLASS, type GateDeps, evaluateToolCall } from "../src/gate.ts";
import { type AskResult, EMPTY_USAGE, type JevClient } from "../src/jev.ts";
import type { BashPolicy } from "../src/policy.ts";

const POLICY: BashPolicy = { allow: [], deny: [], extraReadOnly: [], transparentWrappers: ["rtk"] };
const ALLOW = { q_critical: 0.02, q_risk: 0.2, q_auth: 0.9 };
const REFUSE = { q_critical: 0.5, q_risk: 0.8, q_auth: 0.1 };
const OUTSIDE_TASK = { because_outside_task: 0.9, because_credential_risk: 0.05, because_irreversible_risk: 0.1 };
const CREDENTIAL = { because_outside_task: 0.05, because_credential_risk: 0.95, because_irreversible_risk: 0.1 };

/** The primary question gets `answers`; the follow-up gets `followUp`, which is what names the class. */
function client(answers: Record<string, number>, followUp: Record<string, number>): JevClient {
  return {
    transport: "test",
    usage: () => EMPTY_USAGE("2026-09-21"),
    ask: async (payload): Promise<AskResult> => {
      const primary = Object.hasOwn(payload.questions, "q_critical");
      return {
        ok: true,
        answers: primary ? answers : followUp,
        model: "test",
        inputTokens: 10,
        outputTokens: 1,
        usd: 0,
        latencyMs: 5,
      };
    },
  };
}

function setup(clock: { now: number }, over: Partial<GateDeps> = {}) {
  const breaker = new Breaker({ breakerAfter: 3, cooldownMs: 60_000, now: () => clock.now });
  const grants = new AllowGrants();
  const deps = (extra: Partial<GateDeps> = {}): GateDeps => ({
    cwd: "/repo",
    policy: POLICY,
    protectedPaths: [],
    thresholds: DEFAULT_CONFIG.thresholds,
    client: client(REFUSE, OUTSIDE_TASK),
    breaker,
    grants,
    intent: "work on the project",
    isGitRepository: true,
    turnKey: "1",
    ...over,
    ...extra,
  });
  return { breaker, grants, deps };
}

test("a refusal inside the window is recorded in full and not enforced", async () => {
  const clock = { now: 0 };
  const { breaker, grants, deps } = setup(clock);
  breaker.shadow(60_000);

  const verdict = await evaluateToolCall("bash", { command: "mkdir -p /tmp/x" }, deps());

  assert.equal(verdict.kind, "allow", "the work is not interrupted");
  assert.equal(verdict.layer, "shadow");
  assert.match(verdict.reason, /^would have blocked: /);
  assert.match(verdict.reason, /most likely because/, "the follow-up still ran: the reason is the data");
  assert.ok(verdict.judgment !== undefined, "the judgement itself is kept");
  assert.equal(verdict.judgment?.conditions.length, 3, "all three readings travel with it");
  assert.equal(verdict.model, "test", "and so does the model that produced them");
  assert.equal(grants.list().length, 0, "nothing was refused, so there is nothing to authorise");
});

test("a credential refusal is never shadowed", async () => {
  const clock = { now: 0 };
  const { breaker, deps } = setup(clock, { client: client(REFUSE, CREDENTIAL) });
  breaker.shadow(60_000);

  const verdict = await evaluateToolCall("bash", { command: "cat /Users/xd/.ssh/id_rsa" }, deps());

  assert.equal(verdict.kind, "block", "the one class an instruction cannot override, a window cannot either");
  assert.equal(verdict.layer, "jev");
  assert.equal(verdict.reasonClass, CREDENTIAL_BLOCK_CLASS);
});

test("the window only covers the model layer: layer 0 and the deny rules are untouched", async () => {
  const clock = { now: 0 };
  const { breaker, deps } = setup(clock, { policy: { ...POLICY, deny: ["sudo *"] } });
  breaker.shadow(60_000);

  const wiped = await evaluateToolCall("bash", { command: "rm -rf /" }, deps());
  assert.equal(wiped.kind, "block");
  assert.equal(wiped.layer, "harddeny");

  const denied = await evaluateToolCall("bash", { command: "sudo rm -rf build" }, deps());
  assert.equal(denied.kind, "block");
  assert.equal(denied.layer, "config");
});

test("with no window a refusal is a refusal", async () => {
  const clock = { now: 0 };
  const { breaker, deps } = setup(clock);
  assert.equal(breaker.shadowing(), false);

  const verdict = await evaluateToolCall("bash", { command: "mkdir -p /tmp/x" }, deps());
  assert.equal(verdict.kind, "block");
  assert.equal(verdict.layer, "jev");
});

test("the window ends by itself, and can be ended by hand", async () => {
  const clock = { now: 0 };
  const { breaker, deps } = setup(clock);
  breaker.shadow(1_000);

  assert.equal(breaker.shadowing(), true);
  assert.equal(breaker.shadowRemainingMs(), 1_000);
  assert.equal((await evaluateToolCall("bash", { command: "mkdir -p /tmp/x" }, deps())).layer, "shadow");

  clock.now = 2_000;
  assert.equal(breaker.shadowing(), false, "a window that ends by itself cannot be forgotten");
  assert.equal(breaker.shadowRemainingMs(), 0);
  assert.equal((await evaluateToolCall("bash", { command: "mkdir -p /tmp/x" }, deps())).layer, "jev");

  breaker.shadow(60_000);
  breaker.endShadow();
  assert.equal(breaker.shadowing(), false);
});

test("an allowed call is unaffected by the window", async () => {
  const clock = { now: 0 };
  const { breaker, deps } = setup(clock, { client: client(ALLOW, OUTSIDE_TASK) });
  breaker.shadow(60_000);

  const verdict = await evaluateToolCall("bash", { command: "mkdir -p /tmp/x" }, deps());
  assert.equal(verdict.kind, "allow");
  assert.equal(verdict.layer, "jev", "an allow is an allow: shadow only ever touches refusals");
  assert.doesNotMatch(verdict.reason, /would have blocked/);
});
