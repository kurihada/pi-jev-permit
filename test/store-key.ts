/**
 * 把环境变量里的 key 存进本包的槽位 —— `/jev-suite login` 的非交互等价物。
 *
 * 用法：
 *   node --experimental-strip-types test/store-key.ts [systemone|decisions]
 *
 * key 从 `PI_JEV_SUITE_API_KEY` 读，没有就退回 `TAPSVC_LLM_KEY`（公司网关那把）。
 * **先验后存**：验证不过就什么都不写，避免一个错字变成"什么都拦"。
 * **从不打印 key 本身。**
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { type ResolvedProvider, loadConfig, resolveProvider } from "../src/config.ts";
import { credentialPath, verifyKey, writeStoredApiKey } from "../src/jev.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const { config } = loadConfig({ agentDir, cwd: process.cwd(), trusted: false });

const candidates: { label: string; provider: ResolvedProvider }[] = [
  { label: "默认", provider: resolveProvider(config.provider) },
  { label: "门禁", provider: resolveProvider(config.gate.provider ?? config.provider) },
  { label: "工具", provider: resolveProvider(config.tools.provider ?? config.provider) },
];

const requested = process.argv[2];
const chosen =
  requested === undefined ? candidates[0] : candidates.find((c) => c.provider.protocol === requested);
if (chosen === undefined) {
  console.error(`配置里没有走 ${requested} 的消费方`);
  process.exit(2);
}

const key = process.env.PI_JEV_SUITE_API_KEY?.trim() || process.env.TAPSVC_LLM_KEY?.trim();
if (key === undefined || key.length === 0) {
  console.error("环境里没有 PI_JEV_SUITE_API_KEY，也没有 TAPSVC_LLM_KEY");
  process.exit(2);
}

const { protocol, baseUrl, model } = chosen.provider;
console.log(`正在验证 ${protocol} 的 key：${baseUrl}（模型 ${model}）`);

const result = await verifyKey({ protocol, baseUrl, apiKey: key, model });
if (!result.ok) {
  console.error(`✘ 验证失败（${result.reason}）：${result.detail} —— 没有写入任何东西`);
  process.exit(1);
}

writeStoredApiKey(agentDir, protocol, key);
console.log(`✔ 已验证并写入：${credentialPath(agentDir, protocol)}（供${chosen.label}使用，0600）`);
