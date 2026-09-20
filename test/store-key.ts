/**
 * Store a key from the environment into this package's key slot — the
 * non-interactive equivalent of `/jev-permit login`.
 *
 * Usage:
 *   node --experimental-strip-types test/store-key.ts [systemone|decisions]
 *
 * The key is read from `PI_JEV_PERMIT_API_KEY`, falling back to `TAPSVC_LLM_KEY`
 * (the company gateway key).
 * **Verify before storing**: if verification fails nothing is written, so a
 * typo never becomes "everything gets blocked".
 * **The key itself is never printed.**
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { type ResolvedProvider, loadConfig, resolveProvider } from "../src/config.ts";
import { credentialPath, verifyKey, writeStoredApiKey } from "../src/jev.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const { config } = loadConfig({ agentDir, cwd: process.cwd(), trusted: false });

const candidates: { label: string; provider: ResolvedProvider }[] = [
  { label: "default", provider: resolveProvider(config.provider) },
  { label: "gate", provider: resolveProvider(config.gate.provider ?? config.provider) },
];

const requested = process.argv[2];
const chosen =
  requested === undefined ? candidates[0] : candidates.find((c) => c.provider.protocol === requested);
if (chosen === undefined) {
  console.error(`no consumer is configured for ${requested}`);
  process.exit(2);
}

const key = process.env.PI_JEV_PERMIT_API_KEY?.trim() || process.env.TAPSVC_LLM_KEY?.trim();
if (key === undefined || key.length === 0) {
  console.error("neither PI_JEV_PERMIT_API_KEY nor TAPSVC_LLM_KEY is set in the environment");
  process.exit(2);
}

const { protocol, baseUrl, model } = chosen.provider;
console.log(`Verifying the ${protocol} key: ${baseUrl} (model ${model})`);

const result = await verifyKey({ protocol, baseUrl, apiKey: key, model });
if (!result.ok) {
  console.error(`✘ verification failed (${result.reason}): ${result.detail} — nothing was written`);
  process.exit(1);
}

writeStoredApiKey(agentDir, protocol, key);
console.log(`✔ verified and written: ${credentialPath(agentDir, protocol)} (used by ${chosen.label}, 0600)`);
