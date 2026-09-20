/**
 * 状态行：常驻在输入框上方，显示最近一次判定的结果。
 *
 * 起因：原来只在拦下时才有反馈，放行完全不可见 ——「它到底看没看这条命令」只能靠猜。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Breaker, formatStatusLine } from "../src/gate.ts";

function breaker(): Breaker {
  return new Breaker({ breakerAfter: 3, cooldownMs: 60_000, now: () => 0 });
}

test("状态行：放行与拦下都显示，并带上模型与耗时", () => {
  assert.equal(
    formatStatusLine(breaker(), {
      tool: "bash",
      kind: "allow",
      layer: "jev",
      model: "typesafe/jev-1.13",
      latencyMs: 1210,
    }),
    "jev-suite 放行 bash · typesafe/jev-1.13 1210ms",
  );
  assert.equal(
    formatStatusLine(breaker(), {
      tool: "bash",
      kind: "block",
      layer: "jev",
      model: "typesafe/jev-1.13",
      latencyMs: 900,
    }),
    "jev-suite 拦下 bash · typesafe/jev-1.13 900ms",
  );
});

test("状态行：快路径与白名单不打模型名（没走 Jev 就没有模型）", () => {
  assert.equal(
    formatStatusLine(breaker(), { tool: "bash", kind: "allow", layer: "readonly", latencyMs: 0 }),
    "jev-suite 放行 bash · 快路径 0ms",
  );
  assert.equal(
    formatStatusLine(breaker(), { tool: "write", kind: "allow", layer: "config" }),
    "jev-suite 放行 write · 白名单",
  );
});

test("状态行：降级与暂停优先显示（比单次结果更重要）", () => {
  const degraded = breaker();
  degraded.recordFailure("连不上");
  degraded.recordFailure("连不上");
  degraded.recordFailure("连不上");
  assert.match(formatStatusLine(degraded, { tool: "bash", kind: "block", layer: "jev" }), /DEGRADED/);

  const paused = breaker();
  paused.pause(30 * 60_000);
  assert.equal(formatStatusLine(paused), "jev-suite PAUSED 30m");
});

test("状态行：还没判定过时只说 ok", () => {
  assert.equal(formatStatusLine(breaker()), "jev-suite ok");
});
