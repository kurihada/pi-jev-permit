/**
 * Authorisation the reader can see, and a block message that explains itself.
 *
 * Two additions after a live case: an explicitly requested `git filter-branch` was blocked at
 * p=0.34-0.45 because the intent window is a conversation rather than an instruction, and a block
 * said only "not clearly allowed" - which leaves three very different next moves to guess from.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, type Thresholds } from "../src/config.ts";
import {
  Breaker,
  type GateDeps,
  blockReasonQuestions,
  buildGateState,
  evaluateToolCall,
  gateQuestions,
  latestUserMessage,
  pickBlockReason,
} from "../src/gate.ts";
import { type AskResult, EMPTY_USAGE, type JevClient } from "../src/jev.ts";
import type { BashPolicy } from "../src/policy.ts";

const T: Thresholds = DEFAULT_CONFIG.thresholds;
const POLICY: BashPolicy = { allow: [], deny: [], extraReadOnly: [], transparentWrappers: ["rtk"] };

function user(content: string): unknown {
  return { type: "message", message: { role: "user", content } };
}

test("latestUserMessage: the newest user turn, and only a user turn", () => {
  const branch = [
    user("first"),
    { type: "message", message: { role: "assistant", content: "ignore me" } },
    { type: "message", message: { role: "user", content: "injected", customType: "plan-mode" } },
    user("please rewrite the git history"),
  ];
  assert.equal(latestUserMessage(branch), "please rewrite the git history");
  assert.equal(latestUserMessage([]), "");
});

test("the state carries the newest message separately, and the question names that field", () => {
  const state = buildGateState(
    {
      tool: "bash",
      operation: "git filter-branch",
      reasons: ["not on the read-only list"],
      userIntent: "whole window",
      latestUserMessage: "please rewrite the git history",
    },
    { cwd: "/repo", isGitRepository: true, protectedPaths: [] },
  );
  const value = state.value as Record<string, unknown>;
  assert.equal(value["user_intent"], "whole window");
  assert.equal(value["latest_user_message"], "please rewrite the git history");

  // An absent newest message still sends something rather than an empty string
  const blank = buildGateState(
    { tool: "bash", operation: "x", reasons: [], userIntent: "" },
    { cwd: "/repo", isGitRepository: false, protectedPaths: [] },
  );
  assert.equal((blank.value as Record<string, unknown>)["latest_user_message"], "(no user request is in context)");

  // q_auth is the question that reads the user's own words, so the field has to be named there
  const auth = String((gateQuestions()["q_auth"]!.instructions as Record<string, unknown>)["question"]);
  assert.match(auth, /latest_user_message/, "the model has to be told the field exists");
  assert.match(auth, /They asked for it/, "and that a direct instruction is its own band");
});

test("pickBlockReason: the clearest reason, or nothing when none stands out", () => {
  assert.deepEqual(pickBlockReason({ because_irreversible_risk: 0.86, because_outside_task: 0.05 }, 0.6), {
    id: "because_irreversible_risk",
    label: "could destroy something hard to undo",
    p: 0.86,
  });
  assert.equal(pickBlockReason({ because_outside_task: 0.4, because_credential_risk: 0.3 }, 0.6), null);
  assert.equal(pickBlockReason({}, 0.6), null, "a missing answer is not a reason");
  assert.equal(Object.keys(blockReasonQuestions()).length, 3);
});

function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    cwd: "/repo",
    policy: POLICY,
    protectedPaths: [],
    thresholds: T,
    client: null,
    breaker: new Breaker({ breakerAfter: 3, cooldownMs: 60_000 }),
    intent: "please rewrite the git history",
    latestUserMessage: "please rewrite the git history",
    isGitRepository: true,
    ...over,
  };
}

test("a blocked call asks exactly one follow-up, and the message names the reason", async () => {
  let calls = 0;
  const client: JevClient = {
    transport: "test",
    usage: () => EMPTY_USAGE("2026-09-20"),
    ask: async (): Promise<AskResult> => {
      calls += 1;
      const answers: Record<string, number> =
        calls === 1
          ? { q_critical: 0.05, q_risk: 0.88, q_auth: 0.2 }
          : { because_outside_task: 0.05, because_credential_risk: 0.02, because_irreversible_risk: 0.86 };
      return { ok: true, answers, model: "test", inputTokens: 10, outputTokens: 1, usd: 0, latencyMs: 5 };
    },
  };

  const verdict = await evaluateToolCall("bash", { command: "git filter-branch -f --all" }, deps({ client }));
  assert.equal(verdict.kind, "block");
  assert.match(verdict.reason, /risky and not clearly asked for/);
  assert.match(verdict.reason, /most likely because: could destroy something hard to undo/);
  assert.match(verdict.reason, /0\.86/);
  assert.equal(calls, 2, "one judgement plus exactly one follow-up");
});

test("an allow pays nothing for the follow-up", async () => {
  let calls = 0;
  const client: JevClient = {
    transport: "test",
    usage: () => EMPTY_USAGE("2026-09-20"),
    ask: async (): Promise<AskResult> => {
      calls += 1;
      return { ok: true, answers: { q_critical: 0.02, q_risk: 0.2, q_auth: 0.91 }, model: "test", inputTokens: 10, outputTokens: 1, usd: 0, latencyMs: 5 };
    },
  };
  const verdict = await evaluateToolCall("bash", { command: "npm install" }, deps({ client }));
  assert.equal(verdict.kind, "allow");
  assert.equal(calls, 1, "no follow-up when nothing was blocked");
});
