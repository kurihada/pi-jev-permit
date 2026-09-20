/**
 * 状态显示：常驻在**编辑器上方**的 widget（默认位置）。
 *
 * ```
 * jev-suite 放行 bash                       ← 首行：结论（非 Jev 的落点也带在首行）
 *   typesafe/jev-1.13 · allow 0.94 · 830ms  ← 次行：证据（模型 · 读数 · 耗时）
 *   没有明确认为该放行（p=0.04 < 0.6）      ← 只有拦下时多这一行
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
} from "../src/gate.ts";

function breaker(): Breaker {
  return new Breaker({ breakerAfter: 3, cooldownMs: 60_000, now: () => 0 });
}

const ALLOWED: readonly ConditionOutcome[] = [
  { id: "allow", kind: "required", p: 0.91, threshold: 0.6, verdict: "satisfied" },
];

test("首行：结论 + 工具；Jev 判定的落点不重复在首行", () => {
  assert.equal(
    formatStatusLine(breaker(), {
      tool: "bash",
      kind: "allow",
      layer: "jev",
      model: "typesafe/jev-1.13",
      latencyMs: 1210,
    }),
    "jev-suite 放行 bash",
  );
  assert.equal(formatStatusLine(breaker(), { tool: "bash", kind: "block", layer: "jev" }), "jev-suite 拦下 bash");
});

test("首行：非 Jev 的落点带在首行", () => {
  assert.equal(
    formatStatusLine(breaker(), { tool: "bash", kind: "allow", layer: "readonly", latencyMs: 0 }),
    "jev-suite 放行 bash · 快路径",
  );
  assert.equal(
    formatStatusLine(breaker(), { tool: "write", kind: "allow", layer: "config" }),
    "jev-suite 放行 write · 白名单",
  );
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
});

test("第二行：模型 · 读数 · 耗时（放行只有两行）", () => {
  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "allow",
      layer: "jev",
      model: "typesafe/jev-1.13",
      latencyMs: 830,
      conditions: ALLOWED,
      reason: "判断为可放行（p=0.91 ≥ 0.6）",
    }),
    ["jev-suite 放行 bash", "  typesafe/jev-1.13 · allow 0.91 · 830ms"],
    "放行时理由不占位（它只是把读数换个说法）",
  );
});

test("第三行：只有拦下时给理由", () => {
  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "block",
      layer: "jev",
      model: "typesafe/jev-1.13",
      latencyMs: 792,
      conditions: [{ id: "allow", kind: "required", p: 0.04, threshold: 0.6, verdict: "rejected" }],
      reason: "没有明确认为该放行（p=0.04 < 0.6）",
    }),
    [
      "jev-suite 拦下 bash",
      "  typesafe/jev-1.13 · allow 0.04 · 792ms",
      "  没有明确认为该放行（p=0.04 < 0.6）",
    ],
  );

  // 硬拦没有模型与读数，但理由必须在
  assert.deepEqual(
    statusLines(breaker(), { tool: "bash", kind: "block", layer: "harddeny", reason: "递归删除根目录：/" }),
    ["jev-suite 拦下 bash · 硬拦", "  递归删除根目录：/"],
  );
});

test("快路径只有一行", () => {
  assert.deepEqual(statusLines(breaker(), { tool: "bash", kind: "allow", layer: "readonly", latencyMs: 0 }), [
    "jev-suite 放行 bash · 快路径",
  ]);
});

test("formatReadings：非有限值写 n/a", () => {
  assert.equal(formatReadings(ALLOWED), "allow 0.91");
  assert.equal(
    formatReadings([{ id: "allow", kind: "required", p: Number.NaN, threshold: 0.6, verdict: "rejected" }]),
    "allow n/a",
  );
});

test("理由过长要截断，别把 widget 撑爆", () => {
  const lines = statusLines(breaker(), { tool: "bash", kind: "block", layer: "jev", reason: "x".repeat(400) });
  assert.equal(lines.length, 2);
  assert.equal(lines.at(-1)!.length, 142, "两空格 + 最多 140 字符");
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
    model: "typesafe/jev-1.13",
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
