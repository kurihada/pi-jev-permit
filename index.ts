/**
 * pi-jev-permit — the single Jev surface in pi.
 *
 * The entry point does exactly three things: load config, build a client per protocol,
 * and register the three consumers plus one command into pi.
 * Judgment logic lives in gate.ts / policy.ts, networking in jev.ts, tools in tools.ts.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { type ResolvedProvider, type PermitConfig, loadConfig, resolveProvider } from "./src/config.ts";
import {
  type JevClient,
  type JevJson,
  type JevJsonObject,
  type UsageRecord,
  createJevClient,
  credentialPath,
  loadUsage,
  readLogRecords,
  resolveApiKey,
  verifyKey,
  writeStoredApiKey,
} from "./src/jev.ts";
import { Breaker, type ExtensionApiLike, type GateContextLike, registerGate } from "./src/gate.ts";

export interface CommandApiLike {
  registerCommand(
    name: string,
    spec: {
      readonly description: string;
      handler(args: string, ctx: GateContextLike): Promise<void> | void;
    },
  ): void;
}

export const COMMAND_NAME = "jev-permit";

export const USAGE = "Usage: /jev-permit login | pause [30m] | resume | stats | explain | reload";

/** `30m` / `2h` / `45` (no unit means minutes). Falls back when it cannot be parsed. */
export function parseDurationMs(text: string, fallbackMs = 30 * 60_000): number {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(text.trim());
  if (match === null) return fallbackMs;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return fallbackMs;
  const unit = (match[2] ?? "m").toLowerCase();
  const factor = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Math.max(1_000, Math.round(value * factor));
}

/**
 * This package's own config and logs: writing them must not be judged by the gate
 * (otherwise the agent cannot edit its own config again).
 * The secrets directory is NOT included — credentials are written by `/jev-permit login`,
 * which is a command, not a tool call.
 */
export function exemptPaths(agentDir: string): string[] {
  return [join(agentDir, "pi-jev-permit")];
}

// ---------------------------------------------------------------- reports

/** Log records come back from disk, so every field is checked one by one; under noUncheckedIndexedAccess index access returns JevJson | undefined */
function str(value: JevJson | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: JevJson | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface ConditionBucket {
  satisfied: number;
  rejected: number;
  unclear: number;
  sum: number;
  n: number;
}

export function formatStats(records: readonly JevJsonObject[], usage: UsageRecord): string {
  const layers = new Map<string, { total: number; allowed: number; blocked: number }>();
  const conditions = new Map<string, ConditionBucket>();
  let decisions = 0;

  for (const record of records) {
    if (str(record["kind"]) !== "decision") continue;
    decisions += 1;

    const layer = str(record["layer"]) ?? "unknown";
    const bucket = layers.get(layer) ?? { total: 0, allowed: 0, blocked: 0 };
    bucket.total += 1;
    if (str(record["status"]) === "allowed") bucket.allowed += 1;
    else bucket.blocked += 1;
    layers.set(layer, bucket);

    const list = record["conditions"];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const item = raw as JevJsonObject;
      const id = str(item["id"]) ?? "?";
      const entry = conditions.get(id) ?? { satisfied: 0, rejected: 0, unclear: 0, sum: 0, n: 0 };
      const verdict = str(item["verdict"]);
      if (verdict === "satisfied") entry.satisfied += 1;
      else if (verdict === "rejected") entry.rejected += 1;
      else entry.unclear += 1;
      const p = num(item["p"]);
      if (p !== null) {
        entry.sum += p;
        entry.n += 1;
      }
      conditions.set(id, entry);
    }
  }

  const lines = [
    `Jev usage (UTC ${usage.date})`,
    `  requests ${usage.requests} · input ${usage.inputTokens} tokens · output ${usage.outputTokens} tokens · est. $${usage.usd.toFixed(6)}`,
    "",
    `Decision distribution (${decisions} decisions in the log)`,
  ];
  if (decisions === 0) lines.push("  (no decisions recorded yet)");
  for (const [layer, bucket] of [...layers].sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`  ${layer}: ${bucket.total} (allowed ${bucket.allowed} / blocked ${bucket.blocked})`);
  }

  if (conditions.size > 0) {
    lines.push("", "Condition readings (the closer p is to 1, the more certain it is)");
    for (const [id, entry] of conditions) {
      const avg = entry.n > 0 ? entry.sum / entry.n : Number.NaN;
      const shown = Number.isFinite(avg) ? avg.toFixed(2) : "n/a";
      lines.push(
        `  ${id}: satisfied ${entry.satisfied} / rejected ${entry.rejected} / unclear ${entry.unclear}   avg p=${shown}`,
      );
    }
    lines.push(
      '  ↑ A high "unclear" share means this condition barely decides anything — drop it or retune its threshold.',
    );
  }
  return lines.join("\n");
}

export function formatRecentDecisions(records: readonly JevJsonObject[], limit = 3): string {
  const decisions = records.filter((record) => str(record["kind"]) === "decision").slice(-limit);
  if (decisions.length === 0) return "No decisions recorded yet.";

  const lines: string[] = [];
  for (const record of decisions) {
    const parts = [
      str(record["ts"]) ?? "",
      `${str(record["status"]) === "allowed" ? "allowed" : "blocked"} · ${str(record["tool"]) ?? "?"} · ${str(record["layer"]) ?? "?"}`,
      str(record["reason"]) ?? "",
    ];
    const latency = num(record["latencyMs"]);
    if (latency !== null) parts.push(`${latency}ms`);
    lines.push(`  ${parts.filter((part) => part.length > 0).join(" · ")}`);

    const summary = str(record["summary"]);
    if (summary !== null && summary.length > 0) lines.push(`    command: ${summary}`);
    const policyReasons = record["policyReasons"];
    if (Array.isArray(policyReasons) && policyReasons.length > 0) {
      const readable = policyReasons.map((item) => str(item) ?? "").filter((item) => item.length > 0);
      lines.push(`    why it reached the judgment layer: ${readable.join("; ")}`);
    }

    const list = record["conditions"];
    if (!Array.isArray(list) || list.length === 0) continue;
    const readings: string[] = [];
    for (const raw of list) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const item = raw as JevJsonObject;
      const p = num(item["p"]);
      const threshold = num(item["threshold"]);
      readings.push(
        `${str(item["id"]) ?? "?"} ${p === null ? "n/a" : p.toFixed(2)}/${threshold ?? "?"} ${str(item["verdict"]) ?? ""}`,
      );
    }
    lines.push(`    ${readings.join(" · ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- entry

export default function piJevPermit(pi: ExtensionApiLike & CommandApiLike): void {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const breaker = new Breaker({ breakerAfter: 3, cooldownMs: 60_000 });

  let currentConfig: PermitConfig | null = null;
  let lastWarnings: string[] = [];

  const loadFor = (ctx: { cwd: string; trusted: boolean }): PermitConfig => {
    const result = loadConfig({ agentDir, cwd: ctx.cwd, trusted: ctx.trusted });
    currentConfig = result.config;
    lastWarnings = result.warnings;
    return result.config;
  };

  const configNow = (): PermitConfig => currentConfig ?? loadFor({ cwd: process.cwd(), trusted: false });

  /**
   * The gate's access mode. `gate.provider` overrides the global one field by field — when an
   * override only sets a preset, the timeout and the rest still come from the global config.
   *
   * The package used to route two extra consumers (jev_evaluate, ask_advisor) to their own
   * endpoint; they were removed as dead weight, so the gate is the only consumer left.
   */
  const makeClient = (config: PermitConfig): JevClient | null => {
    const override = config.gate.provider;
    const provider = resolveProvider(override === undefined ? config.provider : { ...config.provider, ...override });
    const key = resolveApiKey(agentDir, provider.protocol);
    if (key === null) return null;
    return createJevClient({
      agentDir,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: key.key,
      timeoutMs: provider.timeoutMs,
      maxRetries: provider.maxRetries,
      budget: config.budget,
    });
  };

  registerGate(pi, {
    agentDir,
    breaker,
    loadConfig: (ctx) => loadFor(ctx),
    makeClient,
    exemptPaths: exemptPaths(agentDir),
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Manage pi-jev-permit: login / pause / resume / stats / explain / reload",
    handler: async (args, ctx) => {
      const notify = (message: string, level: "info" | "warning" | "error" = "info"): void => {
        ctx.ui?.notify?.(message, level);
      };
      const [sub = "", ...rest] = args.trim().split(/\s+/).filter((part) => part.length > 0);
      const config = configNow();

      switch (sub) {
        case "login": {
          // The gate may point at a different protocol than the global default, so look config up by
          // protocol: no argument logs into the default; with one, find the consumer that uses it.
          const candidates: { label: string; provider: ResolvedProvider }[] = [
            { label: "default", provider: resolveProvider(config.provider) },
            { label: "gate", provider: resolveProvider(config.gate.provider ?? config.provider) },
          ];
          const requested = rest[0];
          const chosen =
            requested === undefined
              ? candidates[0]
              : candidates.find((candidate) => candidate.provider.protocol === requested);
          if (chosen === undefined) {
            const known = [...new Set(candidates.map((candidate) => candidate.provider.protocol))];
            notify(
              `No consumer uses ${requested} (available: ${known.join(", ")}); change provider.preset in the config first`,
              "warning",
            );
            return;
          }
          const provider = chosen.provider;
          const key = await ctx.ui?.input?.(
            `${provider.protocol} API key (${provider.baseUrl})`,
            `for ${chosen.label}; paste the key and press Enter`,
          );
          if (typeof key !== "string" || key.trim().length === 0) {
            notify("No key entered, nothing changed", "info");
            return;
          }
          // Verify before storing: a stored-but-unverified key turns one typo into "everything is blocked"
          const verification = await verifyKey({
            protocol: provider.protocol,
            baseUrl: provider.baseUrl,
            apiKey: key.trim(),
            model: provider.model,
          });
          if (!verification.ok) {
            notify(`key failed verification (${verification.reason}): ${verification.detail}`, "error");
            return;
          }
          writeStoredApiKey(agentDir, provider.protocol, key.trim());
          notify(
            `Saved the ${provider.protocol} key (for ${chosen.label}): ${credentialPath(agentDir, provider.protocol)} (0600)`,
            "info",
          );
          return;
        }

        case "pause": {
          const ms = parseDurationMs(rest[0] ?? "");
          breaker.pause(ms);
          ctx.ui?.setStatus?.("jev-permit", `jev-permit PAUSED ${Math.ceil(ms / 60_000)}m`);
          notify(
            `Judgment paused for ${Math.ceil(ms / 60_000)} minutes: all calls pass, and it resumes automatically (better than turning the gate off, because you cannot forget to turn it back on)`,
            "warning",
          );
          return;
        }

        case "resume": {
          breaker.resume();
          notify("Judgment resumed", "info");
          return;
        }

        case "stats": {
          notify(formatStats(readLogRecords(agentDir), loadUsage(agentDir, Date.now())), "info");
          return;
        }

        case "explain": {
          notify(formatRecentDecisions(readLogRecords(agentDir)), "info");
          return;
        }

        case "reload": {
          const reloaded = loadFor({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted?.() ?? false });
          const provider = resolveProvider(reloaded.provider);
          const gate = reloaded.gate;
          notify(
            [
              `Config reloaded: ${provider.protocol} at ${provider.baseUrl} (model ${provider.model})`,
              `Gate: records ${gate.records} · allowlist ${gate.allow.length} · deny ${gate.deny.length} · transparent wrappers ${gate.transparentWrappers.join(", ") || "none"}`,
              lastWarnings.length === 0 ? "No config warnings." : `Config warnings:\n  ${lastWarnings.join("\n  ")}`,
            ].join("\n"),
            lastWarnings.length === 0 ? "info" : "warning",
          );
          return;
        }

        default:
          notify(USAGE);
      }
    },
  });
}
