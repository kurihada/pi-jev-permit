/**
 * Status display: the widget that sits permanently just above the input box.
 *
 * ```
 * jev-suite allow bash · ls -la /tmp        ← line 1: verdict + tool + the call being judged
 *   fast path · 0ms                         ← line 2: how it was decided (route/model · reading · time)
 * jev-suite deny bash · npm publish
 *   typesafe/jev-1.13 · allow 0.04 · 792ms
 *   not clearly allowed (p=0.04 < 0.6)      ← line 3, only when blocked
 * ```
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Breaker,
  type ConditionOutcome,
  formatReadings,
  formatStatusLine,
  statusLines,
  summariseCall,
} from "../src/gate.ts";

function breaker(): Breaker {
  return new Breaker({ breakerAfter: 3, cooldownMs: 60_000, now: () => 0 });
}

const ALLOWED: readonly ConditionOutcome[] = [
  { id: "allow", kind: "required", p: 0.94, threshold: 0.6, verdict: "satisfied" },
];
const REJECTED: readonly ConditionOutcome[] = [
  { id: "allow", kind: "required", p: 0.04, threshold: 0.6, verdict: "rejected" },
];

test("line 1: verdict + tool + the call being judged (both allow and deny)", () => {
  assert.equal(
    formatStatusLine(breaker(), { tool: "bash", kind: "allow", layer: "readonly", summary: "ls -la /tmp" }),
    "jev-suite allow bash · ls -la /tmp",
  );
  assert.equal(
    formatStatusLine(breaker(), {
      tool: "write",
      kind: "block",
      layer: "harddeny",
      summary: "/Users/xd/.pi/agent/settings.json",
    }),
    "jev-suite deny write · /Users/xd/.pi/agent/settings.json",
  );
  // no summary -> no dangling separator
  assert.equal(formatStatusLine(breaker(), { tool: "bash", kind: "allow", layer: "config" }), "jev-suite allow bash");
});

test("summariseCall: redacted, flattened, truncated (the widget copy caps at 80)", () => {
  assert.equal(summariseCall("bash", { command: "ls -la\n/tmp" }, 80), "ls -la /tmp", "newlines flattened");
  const long = summariseCall("bash", { command: "x".repeat(200) }, 80);
  assert.equal(long.length, 81, "80 chars + ellipsis");
  assert.ok(long.endsWith("…"));
  assert.ok(
    summariseCall("bash", { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwx' x.dev" }, 80).includes(
      "<redacted>",
    ),
    "a credential in the command must never reach the screen",
  );
  assert.equal(summariseCall("write", { path: "/tmp/a.ts" }, 80), "/tmp/a.ts");
  assert.equal(summariseCall("edit", {}, 80), "");
});

test("line 2: route/model · reading · latency, same shape in all three cases", () => {
  // fast path: decided locally, so no model and no reading
  assert.deepEqual(
    statusLines(breaker(), { tool: "bash", kind: "allow", layer: "readonly", summary: "ls", latencyMs: 0 }),
    ["jev-suite allow bash · ls", "  fast path · 0ms"],
  );
  // allowlist: the config layer has no latency
  assert.deepEqual(statusLines(breaker(), { tool: "write", kind: "allow", layer: "config", summary: "src/a.ts" }), [
    "jev-suite allow write · src/a.ts",
    "  allowlist",
  ]);
  // Jev: the model name replaces the route label
  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "allow",
      layer: "jev",
      summary: "npm install",
      model: "typesafe/jev-1.13",
      latencyMs: 830,
      conditions: ALLOWED,
      reason: "allowed (p=0.94 >= 0.6)",
    }),
    ["jev-suite allow bash · npm install", "  typesafe/jev-1.13 · allow 0.94 · 830ms"],
    "an allow never spends a line on the reason (it only restates the reading)",
  );
});

test("line 3: the reason, only when blocked", () => {
  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "block",
      layer: "jev",
      summary: "npm publish",
      model: "typesafe/jev-1.13",
      latencyMs: 792,
      conditions: REJECTED,
      reason: "not clearly allowed (p=0.04 < 0.6)",
    }),
    [
      "jev-suite deny bash · npm publish",
      "  typesafe/jev-1.13 · allow 0.04 · 792ms",
      "  not clearly allowed (p=0.04 < 0.6)",
    ],
  );

  // hard deny has no model and no reading, but the reason must be there
  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "block",
      layer: "harddeny",
      summary: "rm -rf /",
      reason: "recursive delete of a root directory: /",
    }),
    ["jev-suite deny bash · rm -rf /", "  hard deny", "  recursive delete of a root directory: /"],
  );

  // a deny-rule block lands on the config layer
  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "block",
      layer: "config",
      summary: "sudo ls",
      reason: "matched deny: sudo *",
    }),
    ["jev-suite deny bash · sudo ls", "  deny rule", "  matched deny: sudo *"],
  );
});

test("formatReadings: non-finite probabilities read as n/a", () => {
  assert.equal(formatReadings(ALLOWED), "allow 0.94");
  assert.equal(
    formatReadings([{ id: "allow", kind: "required", p: Number.NaN, threshold: 0.6, verdict: "rejected" }]),
    "allow n/a",
  );
});

test("an over-long reason is truncated instead of blowing up the widget", () => {
  const lines = statusLines(breaker(), {
    tool: "bash",
    kind: "block",
    layer: "jev",
    summary: "x",
    reason: "y".repeat(400),
  });
  assert.equal(lines.length, 3);
  assert.equal(lines.at(-1)!.length, 142, "two spaces + at most 140 chars");
});

test("degraded and paused win over a single verdict, and take a single line", () => {
  const degraded = breaker();
  degraded.recordFailure("unreachable");
  degraded.recordFailure("unreachable");
  degraded.recordFailure("unreachable");
  const lines = statusLines(degraded, {
    tool: "bash",
    kind: "block",
    layer: "jev",
    summary: "npm install",
    model: "typesafe/jev-1.13",
    reason: "whatever",
    conditions: ALLOWED,
  });
  assert.equal(lines.length, 1, "the degraded state is the whole story");
  assert.match(lines[0]!, /DEGRADED/);

  const paused = breaker();
  paused.pause(30 * 60_000);
  assert.deepEqual(statusLines(paused), ["jev-suite PAUSED 30m"]);
});

test("nothing judged yet: just ok", () => {
  assert.deepEqual(statusLines(breaker()), ["jev-suite ok"]);
});
