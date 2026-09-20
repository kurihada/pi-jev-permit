/**
 * 门禁：条件组合、断路器、意图提取、保护路径、端到端判定 —— 全部用假 client，不打网络。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, type Thresholds } from "../src/config.ts";
import {
  Breaker,
  type GateDeps,
  NO_INTENT_PLACEHOLDER,
  combine,
  evaluateToolCall,
  extractRecentIntent,
  gateQuestions,
  messageText,
  resolveWriteTarget,
} from "../src/gate.ts";
import { type AskRequest, type AskResult, type JevClient, EMPTY_USAGE } from "../src/jev.ts";
import { type BashPolicy, protectedPathReason, redact } from "../src/policy.ts";

const T: Thresholds = DEFAULT_CONFIG.thresholds;

const POLICY: BashPolicy = { allow: [], deny: [], extraReadOnly: [], transparentWrappers: ["rtk"] };

function fakeClient(result: AskResult): { client: JevClient; calls: AskRequest[] } {
  const calls: AskRequest[] = [];
  const client: JevClient = {
    transport: "test-transport",
    usage: () => EMPTY_USAGE("2026-09-20"),
    ask: async (request: AskRequest) => {
      calls.push(request);
      return result;
    },
  };
  return { client, calls };
}

const allowedAnswers = { intent_coverage: 0.9, no_secret_egress: 0.95, no_irreversible_damage: 0.95 };

function okResult(answers: Record<string, number> = allowedAnswers): AskResult {
  return { ok: true, answers, model: "test", inputTokens: 10, outputTokens: 1, usd: 0, latencyMs: 7 };
}

function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    cwd: "/repo",
    policy: POLICY,
    protectedPaths: [],
    thresholds: T,
    client: null,
    breaker: new Breaker({ breakerAfter: 3, cooldownMs: 60_000 }),
    intent: "请把 README 里的命令更新一下",
    isGitRepository: true,
    ...over,
  };
}

// ---------------------------------------------------------------- combine

test("combine：三项都满足 → 放行", () => {
  const j = combine(allowedAnswers, T);
  assert.equal(j.allow, true);
  assert.equal(j.decidingRule, "intent_coverage");
});

test("combine：禁项被明确否定 → 拦，且不看意图", () => {
  const j = combine({ ...allowedAnswers, no_secret_egress: 0.02 }, T);
  assert.equal(j.allow, false);
  assert.equal(j.decidingRule, "no_secret_egress");
  assert.match(j.reason, /明确否定/);
  const j2 = combine({ ...allowedAnswers, no_irreversible_damage: 0.1 }, T);
  assert.equal(j2.decidingRule, "no_irreversible_damage");
});

test("combine：禁项的中间地带被忽略（不拦）", () => {
  // 阈值 0.85 → 明确否定是 p ≤ 0.15；0.5 / 0.8 都落中间，不构成拦截理由
  const j = combine({ ...allowedAnswers, no_secret_egress: 0.5, no_irreversible_damage: 0.8 }, T);
  assert.equal(j.allow, true);
});

test("combine：禁项阈值必须让「明显危害」够得着否定线（e2e 抓到的真漏洞）", () => {
  // 实测：读 ~/.ssh/id_rsa 时模型的 no_secret_egress = 0.10
  const credentialRead = { ...allowedAnswers, no_secret_egress: 0.1 };
  assert.equal(combine(credentialRead, T).allow, false, "0.10 必须能触发否定线");
  assert.equal(combine(credentialRead, T).decidingRule, "no_secret_egress");

  // 旧默认值 0.97 的否定线是 p ≤ 0.03 —— 那个区间模型不会给，规则等于失效
  const oldDefault = { ...T, no_secret_egress: 0.97 };
  assert.equal(combine(credentialRead, oldDefault).allow, true, "这就是旧默认值的洞");

  // 普通命令的读数远高于阈值，不受影响
  assert.equal(combine({ ...allowedAnswers, no_secret_egress: 0.95 }, T).allow, true);
});

test("combine：意图没被明确满足就拦（这条是唯一真正的权限问题）", () => {
  const low = combine({ ...allowedAnswers, intent_coverage: 0.35 }, T);
  assert.equal(low.allow, false);
  assert.equal(low.decidingRule, "intent_coverage");
  assert.match(low.reason, /没有明确覆盖/);

  // 边界：正好等于阈值算满足
  assert.equal(combine({ ...allowedAnswers, intent_coverage: 0.6 }, T).allow, true);
  // 中间地带（0.55）不算"明确满足"
  assert.equal(combine({ ...allowedAnswers, intent_coverage: 0.55 }, T).allow, false);
});

test("combine：没答的 key 不放行（答不出来 ≠ 同意）", () => {
  const j = combine({ no_secret_egress: 0.95, no_irreversible_damage: 0.95 }, T);
  assert.equal(j.allow, false);
  assert.match(j.reason, /没有回答/);
});

test("gateQuestions：三个条件都带上 criteria（中间地带必须存在）", () => {
  const questions = gateQuestions();
  assert.deepEqual(Object.keys(questions).sort(), ["intent_coverage", "no_irreversible_damage", "no_secret_egress"]);
  for (const q of Object.values(questions)) {
    assert.equal(q.type, "noul");
    assert.ok(q.criteria?.true);
    assert.ok(q.criteria?.false);
    const instructions = q.instructions as Record<string, unknown>;
    assert.equal(instructions["judge"], "value");
    assert.equal(instructions["reference"], "context");
  }
});

// ---------------------------------------------------------------- 断路器

test("断路器：连续失败到达阈值 → 降级；冷却过后重新探测", () => {
  let nowMs = 1_000_000;
  const breaker = new Breaker({ breakerAfter: 3, cooldownMs: 60_000, now: () => nowMs });
  assert.equal(breaker.state(), "ok");
  breaker.recordFailure("连不上");
  breaker.recordFailure("连不上");
  assert.equal(breaker.state(), "ok", "两次还不够");
  breaker.recordFailure("连不上");
  assert.equal(breaker.state(), "degraded");
  assert.equal(breaker.lastReason, "连不上");

  nowMs += 60_001;
  assert.equal(breaker.state(), "ok", "冷却过后放行一次当作探测");
  breaker.recordSuccess();
  assert.equal(breaker.failures, 0);
});

test("断路器：成功会清零连续失败计数", () => {
  const breaker = new Breaker({ breakerAfter: 2, cooldownMs: 1000, now: () => 0 });
  breaker.recordFailure("x");
  breaker.recordSuccess();
  breaker.recordFailure("x");
  assert.equal(breaker.state(), "ok", "中间成功过就不算连续失败");
});

test("断路器：暂停与自动恢复", () => {
  let nowMs = 0;
  // 冷却 60 分钟 > 暂停 30 分钟：暂停到期后应当回到 degraded，而不是直接 ok
  const breaker = new Breaker({ breakerAfter: 3, cooldownMs: 60 * 60_000, now: () => nowMs });
  breaker.recordFailure("x");
  breaker.recordFailure("x");
  breaker.recordFailure("x");
  breaker.pause(30 * 60_000);
  assert.equal(breaker.state(), "paused", "暂停优先于降级");
  assert.equal(breaker.pauseRemainingMs(), 30 * 60_000);
  nowMs += 30 * 60_001;
  assert.equal(breaker.state(), "degraded", "暂停到期后回到真实状态");
  breaker.resume();
  assert.equal(breaker.state(), "degraded");
});

// ---------------------------------------------------------------- 意图

test("意图提取：只取 user 消息，跳过扩展注入与 assistant", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "第一条请求" } },
    { type: "message", message: { role: "assistant", content: "我不算数" } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "第二条请求" }] } },
    { type: "message", message: { role: "user", content: "扩展注入", customType: "plan-mode" } },
    { type: "tool_result", content: "工具输出不算数" },
  ];
  assert.equal(extractRecentIntent(branch), "第一条请求\n\n第二条请求");
  assert.equal(extractRecentIntent([]), "");
});

test("messageText：字符串 / 分段 / 其它类型", () => {
  assert.equal(messageText("abc"), "abc");
  assert.equal(messageText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(messageText(42), "");
  assert.equal(messageText(undefined), "");
});

// ---------------------------------------------------------------- 保护路径

test("保护路径：凭据、版本库元数据、agent 指令文件", () => {
  for (const path of [
    "/Users/xd/.ssh/id_rsa",
    "/repo/.git/config",
    "/Users/xd/.pi/agent/settings.json",
    "/repo/.env",
    "/repo/.env.local",
    "/repo/AGENTS.md",
    "/Users/xd/.aws/credentials",
    "/repo/.github/workflows/ci.yml",
    "/repo/npm-debug.pem",
  ]) {
    assert.notEqual(protectedPathReason(path), null, path);
  }
  for (const path of ["/repo/src/policy.ts", "/repo/README.md", "/repo/.env.example", "/repo/src/config.ts"]) {
    assert.equal(protectedPathReason(path), null, path);
  }
});

test("保护路径：exempt 前缀永远放行（否则连自己的配置都改不了）", () => {
  const config = "/Users/xd/.pi/agent/pi-jev-suite.json";
  assert.notEqual(protectedPathReason(config), null, "默认 .pi 段是保护的");
  assert.equal(protectedPathReason(config, [], ["/Users/xd/.pi/agent/pi-jev-suite"]), null);
});

test("保护路径：配置里的附加模式（子串或 glob）", () => {
  assert.notEqual(protectedPathReason("/opt/company/secrets/x.txt", ["/opt/company/"]), null);
  assert.notEqual(protectedPathReason("/repo/docs/private.md", ["**/private.md"]), null);
  assert.equal(protectedPathReason("/repo/docs/public.md", ["**/private.md"]), null);
});

// ---------------------------------------------------------------- 脱敏

test("脱敏：常见凭据形态被抹掉", () => {
  const samples = [
    "ghp_abcdefghijklmnopqrstuvwxyz01",
    "AKIAIOSFODNN7EXAMPLE",
    "sk-abcdefghijklmnopqrstuvwx",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk",
    "Authorization: Bearer abcdefghijklmnopqrstuvwx",
    "api_key = 'abcdefghijklmnop'",
  ];
  for (const sample of samples) {
    const out = redact(`curl -H "${sample}" https://x.dev`);
    assert.ok(!out.includes(sample), `没抹掉：${sample} → ${out}`);
    assert.ok(out.includes("<redacted>"));
  }
});

// ---------------------------------------------------------------- 写入目标

test("写入目标：相对路径 vs 绝对路径", () => {
  assert.deepEqual(resolveWriteTarget({ path: "src/a.ts" }, "/repo"), {
    absolutePath: "/repo/src/a.ts",
    relativePath: "src/a.ts",
    outsideCwd: false,
  });
  assert.equal(resolveWriteTarget({ path: "/tmp/a.ts" }, "/repo")?.outsideCwd, true);
  assert.equal(resolveWriteTarget({ file_path: "/tmp/a.ts" }, "/repo")?.absolutePath, "/tmp/a.ts");
  assert.equal(resolveWriteTarget({}, "/repo"), null);
});

// ---------------------------------------------------------------- 端到端

test("端到端：不在门禁范围的工具直接放行", async () => {
  const v = await evaluateToolCall("read", {}, deps());
  assert.equal(v.kind, "allow");
  assert.equal(v.layer, "config");
});

test("端到端：只读命令走第 ② 层，不问 Jev", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall("bash", { command: "ls -la" }, deps({ client: f.client }));
  assert.equal(v.kind, "allow");
  assert.equal(v.layer, "readonly");
  assert.equal(f.calls.length, 0, "快路径不该打网络");
});

test("端到端：rtk 包装 + 惰性赋值也不问 Jev", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall(
    "bash",
    { command: "export RTK_DB_PATH='/tmp/h.db'; rtk ls -l /tmp" },
    deps({ client: f.client }),
  );
  assert.equal(v.kind, "allow");
  assert.equal(f.calls.length, 0);
});

test("端到端：硬拦在 Jev 之前，概率不可覆盖", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall("bash", { command: "rm -rf /" }, deps({ client: f.client }));
  assert.equal(v.kind, "block");
  assert.equal(v.layer, "harddeny");
  assert.equal(f.calls.length, 0);
});

test("端到端：命中 deny 的也不问 Jev", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall(
    "bash",
    { command: "sudo ls" },
    deps({ client: f.client, policy: { ...POLICY, deny: ["sudo *"] } }),
  );
  assert.equal(v.kind, "block");
  assert.equal(v.layer, "config");
  assert.equal(f.calls.length, 0);
});

test("端到端：需要判定的命令会带上意图、原因与脱敏后的命令", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall(
    "bash",
    { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwx' https://x.dev" },
    deps({ client: f.client }),
  );
  assert.equal(v.kind, "allow");
  assert.equal(v.layer, "jev");
  assert.equal(f.calls.length, 1);

  const state = f.calls[0]!.state.value as Record<string, unknown>;
  assert.equal(state["tool"], "bash");
  assert.ok(String(state["operation"]).includes("<redacted>"), "命令里的凭据必须被抹掉");
  assert.equal(state["user_intent"], "请把 README 里的命令更新一下");
  assert.deepEqual(state["matched_policy_reasons"], ["不在只读表：curl"]);
  assert.ok(f.calls[0]!.questions["intent_coverage"]);
});

test("端到端：没有 key 时第 ③ 层拦，第 ①② 层照常", async () => {
  const blocked = await evaluateToolCall("bash", { command: "npm install" }, deps({ client: null }));
  assert.equal(blocked.kind, "block");
  assert.equal(blocked.layer, "unavailable");

  const allowed = await evaluateToolCall("bash", { command: "ls -la" }, deps({ client: null }));
  assert.equal(allowed.kind, "allow", "只读命令不依赖 Jev");
  assert.equal(allowed.layer, "readonly");
});

test("端到端：判定失败会记进断路器，并降级后续调用", async () => {
  const failing: JevClient = {
    transport: "test",
    usage: () => EMPTY_USAGE("2026-09-20"),
    ask: async () => ({ ok: false, reason: "network", detail: "连不上", latencyMs: 3 }),
  };
  const breaker = new Breaker({ breakerAfter: 1, cooldownMs: 60_000, now: () => 0 });
  const d = deps({ client: failing, breaker });

  const first = await evaluateToolCall("bash", { command: "npm install" }, d);
  assert.equal(first.kind, "block");
  assert.equal(first.layer, "unavailable");
  assert.match(first.reason, /连不上/);

  const second = await evaluateToolCall("bash", { command: "npm install" }, d);
  assert.equal(second.layer, "degraded", "已经是降级状态，不再打网络");
  assert.match(second.reason, /已降级/);

  // 降级不影响第 ①② 层
  assert.equal((await evaluateToolCall("bash", { command: "git status" }, d)).kind, "allow");
});

test("端到端：暂停时全放行", async () => {
  const breaker = new Breaker({ breakerAfter: 1, cooldownMs: 60_000, now: () => 0 });
  breaker.pause(60_000);
  const v = await evaluateToolCall("bash", { command: "npm install" }, deps({ breaker }));
  assert.equal(v.kind, "allow");
  assert.equal(v.layer, "paused");
});

test("端到端：意图为空时用占位文本（不能读成“没要求所以随意”）", async () => {
  const f = fakeClient(okResult({ ...allowedAnswers, intent_coverage: 0.1 }));
  const v = await evaluateToolCall("bash", { command: "npm install" }, deps({ client: f.client, intent: "" }));
  const state = f.calls[0]!.state.value as Record<string, unknown>;
  assert.equal(state["user_intent"], NO_INTENT_PLACEHOLDER);
  assert.equal(v.kind, "block");
  assert.equal(v.judgment?.decidingRule, "intent_coverage");
});

test("端到端：项目内的普通写入不判定，也不读取文件内容", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall(
    "write",
    { path: "src/a.ts", content: "export const secret = 'x'" },
    deps({ client: f.client }),
  );
  assert.equal(v.kind, "allow");
  assert.equal(v.layer, "config");
  assert.equal(f.calls.length, 0);
});

test("端到端：写保护路径会被判定，且状态里没有文件内容", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall(
    "write",
    { path: "/Users/xd/.ssh/authorized_keys", content: "ssh-rsa AAAA" },
    deps({ client: f.client }),
  );
  assert.equal(v.kind, "allow");
  assert.equal(v.layer, "jev");
  const state = f.calls[0]!.state.value as Record<string, unknown>;
  assert.equal(state["operation"], "/Users/xd/.ssh/authorized_keys");
  assert.equal(state["outside_working_directory"], true);
  assert.ok(!Object.keys(state).includes("content"), "绝不发文件内容");
  assert.ok(JSON.stringify(f.calls[0]).includes("受保护目录段"), "带了保护原因");
});

test("端到端：写工作目录外但非保护路径，也会被判定", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall("edit", { path: "/tmp/notes.md", edits: [{}, {}] }, deps({ client: f.client }));
  assert.equal(v.layer, "jev");
  const state = f.calls[0]!.state.value as Record<string, unknown>;
  assert.equal(state["outside_working_directory"], true);
  assert.equal(state["edit_count"], 2);
});

test("端到端：本包自己的配置可写（exempt）", async () => {
  const f = fakeClient(okResult());
  const v = await evaluateToolCall(
    "write",
    { path: "/Users/xd/.pi/agent/pi-jev-suite.json", content: "{}" },
    deps({ client: f.client, exemptPaths: ["/Users/xd/.pi/agent/pi-jev-suite"] }),
  );
  assert.equal(v.kind, "allow");
  assert.equal(f.calls.length, 0);
});
