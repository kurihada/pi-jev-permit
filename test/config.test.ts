/**
 * 配置加载 / 合并 / 校验。
 * 只有这一层碰 IO；校验原则是"非法就丢弃该项 + warning"，不让一个错字让门禁起不来。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, PRESETS, loadConfig, mergeObjects, resolveProvider } from "../src/config.ts";

function scaffold(): { agentDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-jev-suite-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  return { agentDir, cwd };
}

// ---------------------------------------------------------------- 预设展开

test("resolveProvider：默认走官方 TypeSafe", () => {
  const p = resolveProvider({});
  assert.equal(p.protocol, "systemone");
  assert.equal(p.baseUrl, PRESETS.typesafe.baseUrl);
  assert.equal(p.model, "jev-1.13.0");
});

test("resolveProvider：预设展开成 protocol + baseUrl + model", () => {
  const p = resolveProvider({ preset: "gateway" });
  assert.equal(p.protocol, "decisions");
  assert.equal(p.baseUrl, "https://gateway.invalid");
  assert.equal(p.model, "typesafe/jev-1.13");
  assert.equal(p.timeoutMs, 4000);
});

test("resolveProvider：显式字段覆盖预设", () => {
  const p = resolveProvider({ preset: "gateway", model: "typesafe/jev-latest", timeoutMs: 9000 });
  assert.equal(p.model, "typesafe/jev-latest");
  assert.equal(p.timeoutMs, 9000);
  assert.equal(p.baseUrl, "https://gateway.invalid");
});

// ---------------------------------------------------------------- 合并

test("mergeObjects：对象递归、数组整体替换", () => {
  const merged = mergeObjects(
    { gate: { allow: ["ls *"], records: "status" }, budget: { usdPerDay: 1 } },
    { gate: { allow: ["cat *"] } },
  );
  assert.deepEqual(merged.gate, { allow: ["cat *"], records: "status" }, "数组是替换不是追加");
  assert.deepEqual(merged.budget, { usdPerDay: 1 });
});

// ---------------------------------------------------------------- 加载

test("没有任何配置文件 → 默认值，无 warning", () => {
  const { agentDir, cwd } = scaffold();
  const r = loadConfig({ agentDir, cwd, trusted: true });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.enabled, DEFAULT_CONFIG.enabled);
  assert.deepEqual(r.config.gate.transparentWrappers, ["rtk"]);
  assert.deepEqual(r.config.provider, DEFAULT_CONFIG.provider);
  assert.equal(r.projectPath, null);
});

test("全局配置生效，且两种接入方式可分别覆盖", () => {
  const { agentDir, cwd } = scaffold();
  writeFileSync(
    join(agentDir, "pi-jev-suite.json"),
    JSON.stringify({
      provider: { preset: "gateway", timeoutMs: 3000 },
      gate: { provider: { preset: "gateway" }, records: "status", allow: ["ls *"] },
      tools: { provider: { preset: "typesafe" } },
    }),
  );
  const r = loadConfig({ agentDir, cwd, trusted: true });
  assert.deepEqual(r.warnings, []);
  assert.equal(resolveProvider(r.config.provider).baseUrl, "https://gateway.invalid");
  assert.equal(resolveProvider(r.config.gate.provider).protocol, "decisions", "门禁走网关");
  assert.equal(resolveProvider(r.config.tools.provider).protocol, "systemone", "工具走官方");
  assert.deepEqual(r.config.gate.allow, ["ls *"]);
});

test("非法值只影响那一项，并产生 warning", () => {
  const { agentDir, cwd } = scaffold();
  writeFileSync(
    join(agentDir, "pi-jev-suite.json"),
    JSON.stringify({
      provider: { preset: "nope", timeoutMs: 999999 },
      gate: { records: "yes", allow: ["ls *", 42, ""], deny: "sudo *" },
      thresholds: { intent_coverage: 0.2, no_secret_egress: 0.97 },
      onUnavailable: { mode: "whatever" },
    }),
  );
  const r = loadConfig({ agentDir, cwd, trusted: true });
  assert.equal(resolveProvider(r.config.provider).baseUrl, PRESETS.typesafe.baseUrl, "非法 preset → 回落到默认");
  assert.equal(r.config.provider.timeoutMs, 4000, "超范围 timeout → 默认值");
  assert.equal(r.config.gate.records, "status", "非法枚举 → 默认值");
  assert.deepEqual(r.config.gate.allow, ["ls *"], "数组里的坏条目被丢掉，好的留下");
  assert.deepEqual(r.config.gate.deny, [], "非法类型整体丢弃");
  assert.equal(r.config.thresholds.intent_coverage, 0.6, "0.2 丢掉了两侧区间 → 拒绝");
  assert.equal(r.config.thresholds.no_secret_egress, 0.97);
  assert.equal(r.config.onUnavailable.mode, "degraded");
  assert.ok(r.warnings.length >= 5, `应产生多条 warning，实际 ${r.warnings.length}`);
});

test("项目配置只在 trusted 时生效", () => {
  const { agentDir, cwd } = scaffold();
  writeFileSync(
    join(agentDir, "pi-jev-suite.json"),
    JSON.stringify({ gate: { records: "off", transparentWrappers: ["rtk"] } }),
  );
  writeFileSync(
    join(cwd, ".pi", "pi-jev-suite.json"),
    JSON.stringify({ gate: { records: "full", transparentWrappers: [] } }),
  );

  const untrusted = loadConfig({ agentDir, cwd, trusted: false });
  assert.equal(untrusted.config.gate.records, "off", "不受信 → 忽略项目配置");
  assert.equal(untrusted.projectPath, null);

  const trusted = loadConfig({ agentDir, cwd, trusted: true });
  assert.equal(trusted.config.gate.records, "full", "受信 → 深合并，项目覆盖全局");
  assert.deepEqual(trusted.config.gate.transparentWrappers, [], "数组整体替换");
  assert.equal(trusted.projectPath, join(cwd, ".pi", "pi-jev-suite.json"));
});

test("坏 JSON 只产生 warning，不影响其它配置", () => {
  const { agentDir, cwd } = scaffold();
  writeFileSync(join(cwd, ".pi", "pi-jev-suite.json"), "{ not json");
  const r = loadConfig({ agentDir, cwd, trusted: true });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /JSON 解析失败/);
  assert.equal(r.config.enabled, true);
});

test("阈值必须保留两侧的「未明确」区间（只能落在 0.5 之上）", () => {
  const { agentDir, cwd } = scaffold();
  writeFileSync(join(agentDir, "pi-jev-suite.json"), JSON.stringify({ thresholds: { no_secret_egress: 0.5 } }));
  const r = loadConfig({ agentDir, cwd, trusted: true });
  assert.equal(r.config.thresholds.no_secret_egress, DEFAULT_CONFIG.thresholds.no_secret_egress);
  assert.match(r.warnings.join("\n"), /两侧都要留/);
});
