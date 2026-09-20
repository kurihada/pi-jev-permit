/**
 * 意图提取：窗口与截断方向。
 *
 * 这里 pin 的是一个**上线实测抓到的 bug**：超预算时原来是保留最旧、丢掉最新
 * （join 后是从旧到新，从头截），于是一场长对话里最近的授权会被裁掉 ——
 * 「用户刚说授权跑验证」却被判成 p=0.23 没有覆盖。上游 intent.ts 同样如此。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_INTENT_OPTIONS, extractRecentIntent } from "../src/gate.ts";

function userMessage(content: string): unknown {
  return { type: "message", message: { role: "user", content } };
}

test("意图：只取 user 消息，跳过扩展注入、assistant 与工具输出", () => {
  const branch = [
    userMessage("第一条请求"),
    { type: "message", message: { role: "assistant", content: "我不算数" } },
    { type: "message", message: { role: "user", content: "扩展注入", customType: "plan-mode" } },
    { type: "tool_result", content: "工具输出不算数" },
    userMessage("最后一条请求"),
  ];
  assert.equal(extractRecentIntent(branch), "第一条请求\n\n最后一条请求");
});

test("意图：分支为空时返回空串（调用方自己补占位文本）", () => {
  assert.equal(extractRecentIntent([]), "");
});

test("意图：超预算时丢最旧的整条消息，最新那条必须在", () => {
  const filler = "x".repeat(DEFAULT_INTENT_OPTIONS.maxMessageChars - 4);
  const branch = Array.from({ length: DEFAULT_INTENT_OPTIONS.maxMessages }, (_value, index) =>
    userMessage(`${filler} #${index}`),
  );

  const intent = extractRecentIntent(branch);
  const newest = DEFAULT_INTENT_OPTIONS.maxMessages - 1;

  assert.ok(intent.includes(`#${newest}`), "最新一条必须还在（否则长对话里最近的授权会被裁掉）");
  assert.ok(!intent.includes("#0 "), "最旧一条应当被丢掉");
  assert.ok(intent.length <= DEFAULT_INTENT_OPTIONS.maxTotalChars, "总长不超预算");

  const kept = intent.split("\n\n").length;
  assert.ok(kept >= 1 && kept < DEFAULT_INTENT_OPTIONS.maxMessages, `保留 ${kept} 条，应当是尾部若干条`);
});

test("意图：没超预算时一条不丢", () => {
  const branch = [userMessage("短的"), userMessage("也很短")];
  assert.equal(extractRecentIntent(branch), "短的\n\n也很短");
});
