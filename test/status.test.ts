/**
 * 状态显示：常驻在**编辑器上方**的 widget（默认位置），显示最近一次判定的结果。
 *
 * 首行 = 结果 · 落点/模型 · 耗时。
 * 第二行 = 拦下给理由（带 p 与阈值）；**放行给三个概率** ——
 * 「条件都通过」那类汇总只是把首行换个说法重复一遍，真正有信息量的是哪条在骑阈值线
 * （例如 egress 0.84 对面阈值 0.85）。
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

const CONDITIONS: readonly ConditionOutcome[] = [
  { id: "intent_coverage", kind: "required", p: 0.82, threshold: 0.6, verdict: "satisfied" },
  { id: "no_secret_egress", kind: "forbidden", p: 0.84, threshold: 0.85, verdict: "unclear" },
  { id: "no_irreversible_damage", kind: "forbidden", p: 0.53, threshold: 0.85, verdict: "unclear" },
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

test("快路径与白名单不打模型名（没走 Jev 就没有模型）", () => {
  assert.equal(
    formatStatusLine(breaker(), { tool: "bash", kind: "allow", layer: "readonly", latencyMs: 0 }),
    "jev-suite 放行 bash · 快路径 0ms",
  );
  assert.equal(
    formatStatusLine(breaker(), { tool: "write", kind: "allow", layer: "config" }),
    "jev-suite 放行 write · 白名单",
  );
});

test("第二行：放行给三个概率，拦下给理由", () => {
  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "allow",
      layer: "jev",
      model: "typesafe/jev-1.13",
      latencyMs: 1200,
      reason: "条件都通过（意图覆盖、无凭据外发、无可逆损害）",
      conditions: CONDITIONS,
    }),
    ["jev-suite 放行 bash · typesafe/jev-1.13 1200ms", "  intent 0.82 · egress 0.84 · damage 0.53"],
    "放行时不重复那句汇总，改给读数",
  );

  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "block",
      layer: "jev",
      model: "typesafe/jev-1.13",
      latencyMs: 900,
      reason: "明确否定：no_secret_egress（p=0.09 ≤ 0.15）",
      conditions: [{ ...CONDITIONS[1]!, p: 0.09, verdict: "rejected" as const }],
    }),
    ["jev-suite 拦下 bash · typesafe/jev-1.13 900ms", "  明确否定：no_secret_egress（p=0.09 ≤ 0.15）"],
  );
});

test("第二行：快路径没有读数，就不给第二行", () => {
  assert.deepEqual(statusLines(breaker(), { tool: "bash", kind: "allow", layer: "readonly", latencyMs: 0 }), [
    "jev-suite 放行 bash · 快路径 0ms",
  ]);
});

test("formatReadings：短标签、认不得的 id 用原样、非有限值写 n/a", () => {
  assert.equal(formatReadings(CONDITIONS), "intent 0.82 · egress 0.84 · damage 0.53");
  assert.equal(
    formatReadings([
      { id: "custom_condition", kind: "forbidden", p: Number.NaN, threshold: 0.9, verdict: "unclear" },
    ]),
    "custom_condition n/a",
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
    conditions: CONDITIONS,
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
