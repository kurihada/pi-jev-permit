/**
 * Intent extraction: the window and its truncation direction.
 *
 * This pins a bug caught by a live run: when over budget the original code kept the oldest and
 * dropped the newest (after the join the text is oldest-first, and it truncated from the front),
 * so in a long conversation the most recent authorization was cut off — "the user just said go
 * run the verification" was judged p=0.23, not covered. The upstream intent.ts has the same bug.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_INTENT_OPTIONS, extractRecentIntent } from "../src/gate.ts";

function userMessage(content: string): unknown {
  return { type: "message", message: { role: "user", content } };
}

test("intent: only user messages, skipping extension-injected, assistant and tool output", () => {
  const branch = [
    userMessage("first request"),
    { type: "message", message: { role: "assistant", content: "I don't count" } },
    { type: "message", message: { role: "user", content: "extension-injected", customType: "plan-mode" } },
    { type: "tool_result", content: "tool output doesn't count" },
    userMessage("last request"),
  ];
  assert.equal(extractRecentIntent(branch), "first request\n\nlast request");
});

test("intent: an empty branch returns an empty string (the caller fills the placeholder)", () => {
  assert.equal(extractRecentIntent([]), "");
});

test("intent: over budget, drop the oldest whole messages and keep the newest", () => {
  const filler = "x".repeat(DEFAULT_INTENT_OPTIONS.maxMessageChars - 4);
  const branch = Array.from({ length: DEFAULT_INTENT_OPTIONS.maxMessages }, (_value, index) =>
    userMessage(`${filler} #${index}`),
  );

  const intent = extractRecentIntent(branch);
  const newest = DEFAULT_INTENT_OPTIONS.maxMessages - 1;

  assert.ok(intent.includes(`#${newest}`), "the newest must still be there (otherwise a long conversation would cut off the most recent authorization)");
  assert.ok(!intent.includes("#0 "), "the oldest should be dropped");
  assert.ok(intent.length <= DEFAULT_INTENT_OPTIONS.maxTotalChars, "total length stays within budget");

  const kept = intent.split("\n\n").length;
  assert.ok(kept >= 1 && kept < DEFAULT_INTENT_OPTIONS.maxMessages, `kept ${kept}, should be the trailing few`);
});

test("intent: under budget, nothing is dropped", () => {
  const branch = [userMessage("short"), userMessage("also short")];
  assert.equal(extractRecentIntent(branch), "short\n\nalso short");
});
