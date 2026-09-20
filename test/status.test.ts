/**
 * 状态显示：常驻在**编辑器上方**的 widget（默认位置）。
 *
 * ```
 * jev-suite 放行 bash · ls -la /tmp          ← 首行：结论 + 工具 + 被判定对象（脱敏截断）
 *   快路径 · 0ms                               ← 次行：判定经过（落点/模型 · 读数 · 耗时）
 * jev-suite 拦下 bash · npm publish
 *   typesafe/jev-1.13 · allow 0.04 · 792ms
 *   没有明确认为该放行（p=0.04 < 0.6）        ← 只有拦下时多这一行
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

test("首行：结论 + 工具 + 被判定对象（放行与拦下都有）", () => {
  assert.equal(
    formatStatusLine(breaker(), { tool: "bash", kind: "allow", layer: "readonly", summary: "ls -la /tmp" }),
    "jev-suite 放行 bash · ls -la /tmp",
  );
  assert.equal(
    formatStatusLine(breaker(), {
      tool: "write",
      kind: "block",
      layer: "harddeny",
      summary: "/Users/xd/.pi/agent/settings.json",
    }),
    "jev-suite 拦下 write · /Users/xd/.pi/agent/settings.json",
  );
  // 没有摘要时不硬塞一个分隔符
  assert.equal(
    formatStatusLine(breaker(), { tool: "bash", kind: "allow", layer: "config" }),
    "jev-suite 放行 bash",
  );
});

test("summariseCall：脱敏 + 压平 + 截断（首行那份截到 80）", () => {
  assert.equal(summariseCall("bash", { command: "ls -la\n/tmp" }, 80), "ls -la /tmp", "换行压平");
  const long = summariseCall("bash", { command: "x".repeat(200) }, 80);
  assert.equal(long.length, 81, "80 字符 + 省略号");
  assert.ok(long.endsWith("…"));
  assert.ok(
    summariseCall("bash", { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwx' x.dev" }, 80).includes(
      "<redacted>",
    ),
    "命令里的凭据不能上屏",
  );
  assert.equal(summariseCall("write", { path: "/tmp/a.ts" }, 80), "/tmp/a.ts");
  assert.equal(summariseCall("edit", {}, 80), "");
});

test("次行：落点 · 读数 · 耗时（三种情形形状一致）", () => {
  // 快路径：本地判定，没有模型也没有读数
  assert.deepEqual(
    statusLines(breaker(), { tool: "bash", kind: "allow", layer: "readonly", summary: "ls", latencyMs: 0 }),
    ["jev-suite 放行 bash · ls", "  快路径 · 0ms"],
  );
  // 白名单：配置层没有耗时
  assert.deepEqual(statusLines(breaker(), { tool: "write", kind: "allow", layer: "config", summary: "src/a.ts" }), [
    "jev-suite 放行 write · src/a.ts",
    "  白名单",
  ]);
  // Jev：模型名顶掉落点
  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "allow",
      layer: "jev",
      summary: "npm install",
      model: "typesafe/jev-1.13",
      latencyMs: 830,
      conditions: ALLOWED,
      reason: "判断为可放行（p=0.94 ≥ 0.6）",
    }),
    ["jev-suite 放行 bash · npm install", "  typesafe/jev-1.13 · allow 0.94 · 830ms"],
    "放行时理由不占位（它只是把读数换个说法）",
  );
});

test("第三行：只有拦下时给理由", () => {
  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "block",
      layer: "jev",
      summary: "npm publish",
      model: "typesafe/jev-1.13",
      latencyMs: 792,
      conditions: REJECTED,
      reason: "没有明确认为该放行（p=0.04 < 0.6）",
    }),
    [
      "jev-suite 拦下 bash · npm publish",
      "  typesafe/jev-1.13 · allow 0.04 · 792ms",
      "  没有明确认为该放行（p=0.04 < 0.6）",
    ],
  );

  // 硬拦没有模型与读数，但理由必须在
  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "block",
      layer: "harddeny",
      summary: "rm -rf /",
      reason: "递归删除根目录：/",
    }),
    ["jev-suite 拦下 bash · rm -rf /", "  硬拦", "  递归删除根目录：/"],
  );

  // 命中 deny 规则的拦住 config 层
  assert.deepEqual(
    statusLines(breaker(), {
      tool: "bash",
      kind: "block",
      layer: "config",
      summary: "sudo ls",
      reason: "命中 deny：sudo *",
    }),
    ["jev-suite 拦下 bash · sudo ls", "  拦截规则", "  命中 deny：sudo *"],
  );
});

test("formatReadings：非有限值写 n/a", () => {
  assert.equal(formatReadings(ALLOWED), "allow 0.94");
  assert.equal(
    formatReadings([{ id: "allow", kind: "required", p: Number.NaN, threshold: 0.6, verdict: "rejected" }]),
    "allow n/a",
  );
});

test("理由过长要截断，别把 widget 撑爆", () => {
  const lines = statusLines(breaker(), {
    tool: "bash",
    kind: "block",
    layer: "jev",
    summary: "x",
    reason: "y".repeat(400),
  });
  assert.equal(lines.length, 3);
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
    summary: "npm install",
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
