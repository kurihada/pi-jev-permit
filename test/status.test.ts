/**
 * 状态显示：常驻在**编辑器上方**的 widget（默认位置），显示最近一次判定的结果。
 *
 * 起因：原来只在拦下时才有反馈，放行完全不可见 ——「它到底看没看这条命令」只能靠猜。
 * 位置说明：pi 的 `setStatus` 落在页脚，`setWidget` 默认落在编辑器上方 —— 后者才是
 * 「输入框上面常驻」要用的那个，所以主用 widget、setStatus 只作兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Breaker, formatStatusLine, statusLines } from "../src/gate.ts";

function breaker(): Breaker {
  return new Breaker({ breakerAfter: 3, cooldownMs: 60_000, now: () => 0 });
}

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

test("widget 第二行给理由：只在真的走了 Jev 且有理由时", () => {
  const judged = {
    tool: "bash",
    kind: "allow" as const,
    layer: "jev" as const,
    model: "typesafe/jev-1.13",
    latencyMs: 1200,
    reason: "条件都通过（意图覆盖、无凭据外发、无可逆损害）",
  };
  assert.deepEqual(statusLines(breaker(), judged), [
    "jev-suite 放行 bash · typesafe/jev-1.13 1200ms",
    "  条件都通过（意图覆盖、无凭据外发、无可逆损害）",
  ]);

  // 快路径没有理由可讲
  assert.deepEqual(statusLines(breaker(), { tool: "bash", kind: "allow", layer: "readonly", latencyMs: 0 }), [
    "jev-suite 放行 bash · 快路径 0ms",
  ]);

  // 理由过长要截断，别把 widget 撑爆
  const long = statusLines(breaker(), { ...judged, reason: "x".repeat(400) });
  assert.equal(long.length, 2);
  assert.equal(long[1]!.length, 122, "两空格 + 最多 120 字符");
});

test("降级与暂停优先显示，且只给一行", () => {
  const degraded = breaker();
  degraded.recordFailure("连不上");
  degraded.recordFailure("连不上");
  degraded.recordFailure("连不上");
  const lines = statusLines(degraded, { tool: "bash", kind: "block", layer: "jev", reason: "随便" });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /DEGRADED/);

  const paused = breaker();
  paused.pause(30 * 60_000);
  assert.deepEqual(statusLines(paused), ["jev-suite PAUSED 30m"]);
});

test("还没判定过时只说 ok", () => {
  assert.deepEqual(statusLines(breaker()), ["jev-suite ok"]);
});
