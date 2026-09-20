/**
 * pi-jev-suite —— pi 里唯一的 Jev 出口。
 *
 * 入口只做三件事：读配置、按协议构造 client、把三个消费方与一条命令注册进 pi。
 * 判定逻辑在 gate.ts / policy.ts，网络在 jev.ts，工具在 tools.ts。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { type ResolvedProvider, type SuiteConfig, loadConfig, resolveProvider } from "./src/config.ts";
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
import { type ToolApiLike, registerTools } from "./src/tools.ts";

export interface CommandApiLike {
  registerCommand(
    name: string,
    spec: {
      readonly description: string;
      handler(args: string, ctx: GateContextLike): Promise<void> | void;
    },
  ): void;
}

export const COMMAND_NAME = "jev-suite";

export const USAGE = "用法：/jev-suite login | pause [30m] | resume | stats | explain | reload";

/** `30m` / `2h` / `45`（不带单位按分钟）。认不出来就用兜底值。 */
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
 * 本包自己的配置与日志：写它们不该被门禁判定（否则又会「连自己的配置都改不了」）。
 * **不含 secrets 目录** —— 凭据由 `/jev-suite login` 写，那是命令而不是工具调用。
 */
export function exemptPaths(agentDir: string): string[] {
  return [join(agentDir, "pi-jev-suite")];
}

// ---------------------------------------------------------------- 报表

/** 日志是从磁盘读回来的，字段一律逐个确认；在 noUncheckedIndexedAccess 下索引访问返回 JevJson | undefined */
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
    `Jev 用量（UTC ${usage.date}）`,
    `  请求 ${usage.requests} · 输入 ${usage.inputTokens} token · 输出 ${usage.outputTokens} token · 估算 $${usage.usd.toFixed(6)}`,
    "",
    `判定分布（日志里 ${decisions} 条 decision）`,
  ];
  if (decisions === 0) lines.push("  （还没有判定记录）");
  for (const [layer, bucket] of [...layers].sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`  ${layer}：${bucket.total}（放行 ${bucket.allowed} / 拦下 ${bucket.blocked}）`);
  }

  if (conditions.size > 0) {
    lines.push("", "条件读数（p 越接近 1 越肯定）");
    for (const [id, entry] of conditions) {
      const avg = entry.n > 0 ? entry.sum / entry.n : Number.NaN;
      const shown = Number.isFinite(avg) ? avg.toFixed(2) : "n/a";
      lines.push(
        `  ${id}：满足 ${entry.satisfied} / 否定 ${entry.rejected} / 未明确 ${entry.unclear}   平均 p=${shown}`,
      );
    }
    lines.push("  ↑「未明确」占比高 = 这条基本没参与决策，可以砍掉或调阈值");
  }
  return lines.join("\n");
}

export function formatRecentDecisions(records: readonly JevJsonObject[], limit = 3): string {
  const decisions = records.filter((record) => str(record["kind"]) === "decision").slice(-limit);
  if (decisions.length === 0) return "还没有判定记录。";

  const lines: string[] = [];
  for (const record of decisions) {
    const parts = [
      str(record["ts"]) ?? "",
      `${str(record["status"]) === "allowed" ? "放行" : "拦下"} · ${str(record["tool"]) ?? "?"} · ${str(record["layer"]) ?? "?"} 层`,
      str(record["reason"]) ?? "",
    ];
    const latency = num(record["latencyMs"]);
    if (latency !== null) parts.push(`${latency}ms`);
    lines.push(`  ${parts.filter((part) => part.length > 0).join(" · ")}`);

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

// ---------------------------------------------------------------- 入口

export default function piJevSuite(pi: ExtensionApiLike & ToolApiLike & CommandApiLike): void {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const breaker = new Breaker({ breakerAfter: 3, cooldownMs: 60_000 });

  let currentConfig: SuiteConfig | null = null;
  let lastWarnings: string[] = [];

  const loadFor = (ctx: { cwd: string; trusted: boolean }): SuiteConfig => {
    const result = loadConfig({ agentDir, cwd: ctx.cwd, trusted: ctx.trusted });
    currentConfig = result.config;
    lastWarnings = result.warnings;
    return result.config;
  };

  const configNow = (): SuiteConfig => currentConfig ?? loadFor({ cwd: process.cwd(), trusted: false });

  /**
   * 每个消费方各自解析接入方式：`gate.provider` / `tools.provider` 覆盖全局。
   * 合并是**字段级**的 —— 覆盖里只写了一个 preset 时，超时等仍来自全局配置。
   */
  const clientFor = (config: SuiteConfig, which: "gate" | "tools"): JevClient | null => {
    const override = which === "gate" ? config.gate.provider : config.tools.provider;
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
    makeClient: (config) => clientFor(config, "gate"),
    exemptPaths: exemptPaths(agentDir),
  });

  registerTools(pi, {
    makeClient: () => {
      const config = configNow();
      return config.tools.enabled ? clientFor(config, "tools") : null;
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "管理 pi-jev-suite：login / pause / resume / stats / explain / reload",
    handler: async (args, ctx) => {
      const notify = (message: string, level: "info" | "warning" | "error" = "info"): void => {
        ctx.ui?.notify?.(message, level);
      };
      const [sub = "", ...rest] = args.trim().split(/\s+/).filter((part) => part.length > 0);
      const config = configNow();

      switch (sub) {
        case "login": {
          // 两个消费方可以走不同协议（门禁走网关、工具走官方），所以按协议找配置：
          // 不指定就登默认那条，指定了就找走该协议的消费方。
          const candidates: { label: string; provider: ResolvedProvider }[] = [
            { label: "默认", provider: resolveProvider(config.provider) },
            { label: "门禁", provider: resolveProvider(config.gate.provider ?? config.provider) },
            { label: "工具", provider: resolveProvider(config.tools.provider ?? config.provider) },
          ];
          const requested = rest[0];
          const chosen =
            requested === undefined
              ? candidates[0]
              : candidates.find((candidate) => candidate.provider.protocol === requested);
          if (chosen === undefined) {
            const known = [...new Set(candidates.map((candidate) => candidate.provider.protocol))];
            notify(
              `配置里没有走 ${requested} 的消费方（当前有：${known.join(", ")}）；先改配置里的 provider.preset`,
              "warning",
            );
            return;
          }
          const provider = chosen.provider;
          const key = await ctx.ui?.input?.(
            `${provider.protocol} 的 API key（${provider.baseUrl}）`,
            `供${chosen.label}使用，粘贴 key 后回车`,
          );
          if (typeof key !== "string" || key.trim().length === 0) {
            notify("没有输入 key，未做改动", "info");
            return;
          }
          // 先验再存：存一个没验证过的 key 会把一个错字变成"什么都拦"
          const verification = await verifyKey({
            protocol: provider.protocol,
            baseUrl: provider.baseUrl,
            apiKey: key.trim(),
            model: provider.model,
          });
          if (!verification.ok) {
            notify(`key 没通过验证（${verification.reason}）：${verification.detail}`, "error");
            return;
          }
          writeStoredApiKey(agentDir, provider.protocol, key.trim());
          notify(
            `已保存 ${provider.protocol} 的 key（供${chosen.label}使用）：${credentialPath(agentDir, provider.protocol)}（0600）`,
            "info",
          );
          return;
        }

        case "pause": {
          const ms = parseDurationMs(rest[0] ?? "");
          breaker.pause(ms);
          ctx.ui?.setStatus?.("jev-suite", `jev-suite PAUSED ${Math.ceil(ms / 60_000)}m`);
          notify(
            `已暂停判定 ${Math.ceil(ms / 60_000)} 分钟：期间所有调用放行，到期自动恢复（比直接关掉门禁好，不会忘了开回来）`,
            "warning",
          );
          return;
        }

        case "resume": {
          breaker.resume();
          notify("已恢复判定", "info");
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
              `已重新读取配置：${provider.protocol} at ${provider.baseUrl}（模型 ${provider.model}）`,
              `门禁：记录 ${gate.records} · 白名单 ${gate.allow.length} 条 · 拦截 ${gate.deny.length} 条 · 透明包装器 ${gate.transparentWrappers.join(", ") || "无"}`,
              lastWarnings.length === 0 ? "配置没有告警。" : `配置告警：\n  ${lastWarnings.join("\n  ")}`,
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
