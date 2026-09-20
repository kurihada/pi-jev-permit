/**
 * 状态显示：常驻在**编辑器上方**的 widget（默认位置），显示最近一次判定的结果。
 *
 * 首行 = 结果 · 落点/模型 · 耗时。
 * 第二行 = 拦下给理由（带 p 与阈值）；**放行给读数** ——
 * 「可以放行」这类汇总只是把首行换个说法重复一遍。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Breaker,
  type ConditionOutcome,
  formatReadings,
  formatStatusLine,
  statusLines,
} from "../src/gate.ts";

function breaker(): Breaker {
  return new Breaker({ breakerAfter: 3, cooldownMs: 60_000, now: () => 0 });
}

const ALLOWED: readonly ConditionOutcome[] = [
  { id: "allow", kind: "required", p: 0.91, threshold: 0.6, verdict: "satisfied" },
];

test("放行与拦下都显示，并带上模型与耗时", () => {
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

test("落点标签：快路径 / 白名单 / 拦截规则 / 硬拦 / 模型名", () => {
  assert.equal(
    formatStatusLine(breaker(), { tool: "bash", kind: "allow", layer: "readonly", latencyMs: 0 }),
    "jev-suite 放行 bash · 快路径 0ms",
  );
  assert.equal(
    formatStatusLine(breaker(), { tool: "write", kind: "allow", layer: "config" }),
    "jev-suite 放行 write · 白名单",
  );
  // 命中 deny 被拦时同样落在 config 层，但标签必须不一样
  assert.equal(
    formatStatusLine(breaker(), { tool: "bash", kind: "block", layer: "config" }),
    "jev-suite 拦下 bash · 拦截规则",
  );
  assert.equal(
    formatStatusLine(breaker(), { tool: "bash", kind: "block", layer: "harddeny" }),
    "jev-suite 拦下 bash · 硬拦",
  );
  assert.equal(
    formatStatusLine(breaker(), { tool: "bash", kind: "block", layer: "unavailable" }),
    "jev-suite 拦下 bash · Jev 不可用",
  );
  assert.equal(
    formatStatusLine(breaker(), { tool: "bash", kind: "allow", layer: "jev", model: "typesafe/jev-1.13" }),
    "jev-suite 放行 bash · typesafe/jev-1.13",
  );
});

test("第二行：放行给读数，拦下给理由", () => {
  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "allow",
      layer: "jev",
      model: "typesafe/jev-1.13",
      latencyMs: 1200,
      reason: "判断为可放行（p=0.91 ≥ 0.6）",
      conditions: ALLOWED,
    }),
    ["jev-suite 放行 bash · typesafe/jev-1.13 1200ms", "  allow 0.91"],
    "放行时不重复那句汇总，改给读数",
  );

  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "block",
      layer: "jev",
      model: "typesafe/jev-1.13",
      latencyMs: 900,
      reason: "没有明确认为该放行（p=0.35 < 0.6）",
      conditions: [{ id: "allow", kind: "required", p: 0.35, threshold: 0.6, verdict: "rejected" }],
    }),
    ["jev-suite 拦下 bash · typesafe/jev-1.13 900ms", "  没有明确认为该放行（p=0.35 < 0.6）"],
  );
});

test("第二行：快路径没有读数，就不给第二行", () => {
  assert.deepEqual(statusLines(breaker(), { tool: "bash", kind: "allow", layer: "readonly", latencyMs: 0 }), [
    "jev-suite 放行 bash · 快路径 0ms",
  ]);
});

test("formatReadings：非有限值写 n/a", () => {
  assert.equal(formatReadings(ALLOWED), "allow 0.91");
  assert.equal(
    formatReadings([{ id: "allow", kind: "required", p: Number.NaN, threshold: 0.6, verdict: "rejected" }]),
    "allow n/a",
  );
});

test("第二行过长要截断，别把 widget 撑爆", () => {
  const lines = statusLines(breaker(), { tool: "bash", kind: "block", layer: "jev", reason: "x".repeat(400) });
  assert.equal(lines.length, 2);
  assert.equal(lines[1]!.length, 142, "两空格 + 最多 140 字符");
});

test("降级与暂停优先显示，且只给一行", () => {
  const degraded = breaker();
  degraded.recordFailure("连不上");
  degraded.recordFailure("连不上");
  degraded.recordFailure("连不上");
  const lines = statusLines(degraded, {
    tool: "bash",
    kind: "block",
    layer: "jev",
    reason: "随便",
    conditions: ALLOWED,
  });
  assert.equal(lines.length, 1, "降级状态本身就说完了一切");
  assert.match(lines[0]!, /DEGRADED/);

  const paused = breaker();
  paused.pause(30 * 60_000);
  assert.deepEqual(statusLines(paused), ["jev-suite PAUSED 30m"]);
});

test("还没判定过时只说 ok", () => {
  assert.deepEqual(statusLines(breaker()), ["jev-suite ok"]);
});
