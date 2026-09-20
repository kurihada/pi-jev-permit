/**
 * pi-jev-suite / config.ts
 *
 * 配置 schema + 预设 + 加载 / 合并 / 校验。
 *
 * 设计约定（见 PLAN.md §4）：
 *   - 规则全部在配置里，代码里只有机制
 *   - 校验失败**丢弃该字段并记 warning**，不猜、不默认（上游教训：静默默认会掩盖配置错误）
 *   - preset 展开成 protocol + baseUrl + model；显式写的字段覆盖 preset
 *   - 项目级配置只在 project trusted 时生效
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- 接入方式

export type Protocol = "systemone" | "decisions";

export const DECISIONS_PATH = "/api/alpha/decisions";
export const SYSTEMONE_PATH = "/v1/systemone";

export function protocolPath(p: Protocol): string {
  return p === "decisions" ? DECISIONS_PATH : SYSTEMONE_PATH;
}

/**
 * 预设把踩过的坑编进来：
 *   - gateway 只认 `typesafe/jev-1.13`（jev-latest → 403，typesafe/jev-latest → 400）
 *   - 两种协议的响应体同形，所以解析器共用，只有 URL / key 验证 / model 名不同
 */
export const PRESETS = {
  typesafe: { protocol: "systemone", baseUrl: "https://api.typesafe.ai", model: "jev-1.13.0" },
  gateway: { protocol: "decisions", baseUrl: "https://gateway.invalid", model: "typesafe/jev-1.13" },
  openrouter: { protocol: "decisions", baseUrl: "https://openrouter.ai", model: "typesafe/jev-1.13" },
} as const satisfies Record<string, { protocol: Protocol; baseUrl: string; model: string }>;

export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

/** 每种协议在各自默认端点上的 model 名（验证 key 这种拿不到配置的场景用） */
export const DEFAULT_MODEL_BY_PROTOCOL: Record<Protocol, string> = {
  systemone: PRESETS.typesafe.model,
  decisions: PRESETS.gateway.model,
};

export interface ProviderConfig {
  preset?: PresetName;
  protocol?: Protocol;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ResolvedProvider {
  protocol: Protocol;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

// ---------------------------------------------------------------- 配置形状

export type RecordMode = "full" | "status" | "off";
export type UnavailableMode = "degraded" | "block";

export interface GateConfig {
  provider?: ProviderConfig;
  records: RecordMode;
  allow: string[];
  deny: string[];
  extraReadOnly: string[];
  transparentWrappers: string[];
  protectedPaths: string[];
  extraProtectedPaths: string[];
}

export interface ToolsConfig {
  provider?: ProviderConfig;
  /** jev_evaluate / ask_advisor 是否启用 */
  enabled: boolean;
}

export interface Thresholds {
  intent_coverage: number;
  no_secret_egress: number;
  no_irreversible_damage: number;
}

export interface OnUnavailable {
  mode: UnavailableMode;
  breakerAfter: number;
  cooldownMs: number;
}

export interface Budget {
  requestsPerDay: number;
  usdPerDay: number;
}

export interface SuiteConfig {
  enabled: boolean;
  provider: ProviderConfig;
  budget: Budget;
  gate: GateConfig;
  tools: ToolsConfig;
  thresholds: Thresholds;
  onUnavailable: OnUnavailable;
}

// ---------------------------------------------------------------- 默认值

export const DEFAULT_CONFIG: SuiteConfig = {
  enabled: true,
  provider: { preset: "typesafe", timeoutMs: 4000, maxRetries: 1 },
  budget: { requestsPerDay: 2000, usdPerDay: 1.0 },
  gate: {
    records: "status",
    allow: [],
    deny: [],
    extraReadOnly: [],
    transparentWrappers: ["rtk"],
    protectedPaths: [],
    extraProtectedPaths: [],
  },
  tools: { enabled: true },
  thresholds: {
    intent_coverage: 0.6,
    no_secret_egress: 0.97,
    no_irreversible_damage: 0.8,
  },
  onUnavailable: { mode: "degraded", breakerAfter: 3, cooldownMs: 60000 },
};

// ---------------------------------------------------------------- 校验边界

export const LIMITS = {
  maxPatternEntries: 200,
  maxPatternLength: 300,
  minTimeoutMs: 250,
  maxTimeoutMs: 60000,
  maxRetries: 5,
  minThreshold: 0.5,
  maxThreshold: 1,
  maxProtectedPaths: 200,
} as const;

export interface LoadResult {
  config: SuiteConfig;
  /** 生效的全局配置路径 */
  globalPath: string;
  /** 生效的项目配置路径（未 trusted 时为 null） */
  projectPath: string | null;
  warnings: string[];
}

/** JSON 边界上的取值域：任何函数只在这两个类型之间来去，不用 `unknown` 返回值 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------- 小工具

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJson(path: string, warnings: string[]): JsonObject | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // 文件不存在是正常情况
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      warnings.push(`${path}: 顶层不是 JSON 对象，已忽略`);
      return null;
    }
    return parsed;
  } catch (err) {
    warnings.push(`${path}: JSON 解析失败（${(err as Error).message}），已忽略`);
    return null;
  }
}

/**
 * 深合并两个 JSON 对象：对象递归，其余（含数组）整体替换 ——
 * 配置里数组是"这一项的全部值"，不是追加。
 */
export function mergeObjects(base: JsonObject, patch: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const existing = out[k];
    out[k] = isPlainObject(existing) && isPlainObject(v) ? mergeObjects(existing, v) : v;
  }
  return out;
}

function coerceBool(v: unknown, field: string, warnings: string[], fallback: boolean): boolean {
  if (v === undefined) return fallback; // 没写 ≠ 写错：缺字段静默用默认值
  if (typeof v === "boolean") return v;
  warnings.push(`${field}: 期望 boolean，得到 ${JSON.stringify(v)}，已用默认值 ${fallback}`);
  return fallback;
}

function coerceInt(
  v: unknown,
  field: string,
  warnings: string[],
  fallback: number,
  min: number,
  max: number,
): number {
  if (v === undefined) return fallback;
  if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) return v;
  warnings.push(`${field}: 期望 ${min}..${max} 的整数，得到 ${JSON.stringify(v)}，已用默认值 ${fallback}`);
  return fallback;
}

function coerceEnum<T extends string>(
  v: unknown,
  field: string,
  warnings: string[],
  allowed: readonly T[],
  fallback: T,
): T {
  if (v === undefined) return fallback;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  warnings.push(`${field}: 期望 ${allowed.join(" | ")}，得到 ${JSON.stringify(v)}，已用默认值 ${fallback}`);
  return fallback;
}

function coercePatterns(v: unknown, field: string, warnings: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    warnings.push(`${field}: 期望字符串数组，得到 ${JSON.stringify(v)}，已忽略`);
    return [];
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || item.length === 0) {
      warnings.push(`${field}: 跳过非字符串或空模式 ${JSON.stringify(item)}`);
      continue;
    }
    if (item.length > LIMITS.maxPatternLength) {
      warnings.push(`${field}: 模式过长被跳过（>${LIMITS.maxPatternLength}）：${item.slice(0, 40)}…`);
      continue;
    }
    out.push(item);
  }
  if (out.length > LIMITS.maxPatternEntries) {
    warnings.push(`${field}: 条目超过 ${LIMITS.maxPatternEntries}，已截断`);
    return out.slice(0, LIMITS.maxPatternEntries);
  }
  return out;
}

function coerceThreshold(v: unknown, field: string, warnings: string[], fallback: number): number {
  // 阈值必须保留两侧的"未明确"区间，所以只能落在 (0.5, 1]
  if (v === undefined) return fallback;
  if (typeof v === "number" && Number.isFinite(v) && v > LIMITS.minThreshold && v <= LIMITS.maxThreshold) {
    return v;
  }
  warnings.push(
    `${field}: 期望 ${LIMITS.minThreshold} < 阈值 <= ${LIMITS.maxThreshold}（两侧都要留"未明确"区间），` +
      `得到 ${JSON.stringify(v)}，已用默认值 ${fallback}`,
  );
  return fallback;
}

function coerceProvider(v: unknown, field: string, warnings: string[]): ProviderConfig | undefined {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) {
    warnings.push(`${field}: 期望对象，已忽略`);
    return undefined;
  }
  const out: ProviderConfig = {};
  if (v.preset !== undefined) {
    if (typeof v.preset === "string" && (PRESET_NAMES as string[]).includes(v.preset)) {
      out.preset = v.preset as PresetName;
    } else {
      warnings.push(
        `${field}.preset: 未知预设 ${JSON.stringify(v.preset)}（可用：${PRESET_NAMES.join(", ")}），已忽略`,
      );
    }
  }
  if (v.protocol !== undefined) {
    out.protocol = coerceEnum(v.protocol, `${field}.protocol`, warnings, ["systemone", "decisions"] as const, "systemone");
  }
  if (v.baseUrl !== undefined) {
    if (typeof v.baseUrl === "string" && /^https?:\/\//.test(v.baseUrl)) {
      out.baseUrl = v.baseUrl.replace(/\/+$/, "");
    } else {
      warnings.push(`${field}.baseUrl: 期望 http(s) URL，得到 ${JSON.stringify(v.baseUrl)}，已忽略`);
    }
  }
  if (v.model !== undefined) {
    if (typeof v.model === "string" && v.model.length > 0) out.model = v.model;
    else warnings.push(`${field}.model: 期望非空字符串，已忽略`);
  }
  if (v.timeoutMs !== undefined) {
    out.timeoutMs = coerceInt(
      v.timeoutMs,
      `${field}.timeoutMs`,
      warnings,
      DEFAULT_CONFIG.provider.timeoutMs!,
      LIMITS.minTimeoutMs,
      LIMITS.maxTimeoutMs,
    );
  }
  if (v.maxRetries !== undefined) {
    out.maxRetries = coerceInt(v.maxRetries, `${field}.maxRetries`, warnings, 1, 0, LIMITS.maxRetries);
  }
  return out;
}

/** 展开 preset：显式字段优先；两者都没有时用官方 TypeSafe 预设兜底 */
export function resolveProvider(cfg: ProviderConfig | undefined, budgeted?: Partial<ResolvedProvider>): ResolvedProvider {
  const merged: ProviderConfig = { ...DEFAULT_CONFIG.provider, ...(cfg ?? {}) };
  const preset = merged.preset ? PRESETS[merged.preset] : undefined;
  return {
    protocol: merged.protocol ?? preset?.protocol ?? "systemone",
    baseUrl: merged.baseUrl ?? preset?.baseUrl ?? PRESETS.typesafe.baseUrl,
    model: merged.model ?? preset?.model ?? PRESETS.typesafe.model,
    timeoutMs: merged.timeoutMs ?? DEFAULT_CONFIG.provider.timeoutMs!,
    maxRetries: merged.maxRetries ?? 1,
    ...budgeted,
  };
}

// ---------------------------------------------------------------- 加载

export interface LoadOptions {
  agentDir: string;
  cwd: string;
  trusted: boolean;
}

/**
 * 读全局 + 项目配置，深合并，校验，返回可用配置。
 * 任何一项非法都只影响那一项（丢弃 + warning），不让整个门禁起不来。
 */
export function loadConfig(opts: LoadOptions): LoadResult {
  const warnings: string[] = [];
  const globalPath = join(opts.agentDir, "pi-jev-suite.json");
  const projectPath = join(opts.cwd, ".pi", "pi-jev-suite.json");

  let raw: JsonObject = {};
  const globalRaw = readJson(globalPath, warnings);
  if (globalRaw) raw = mergeObjects(raw, globalRaw);

  let activeProject: string | null = null;
  if (opts.trusted) {
    const projectRaw = readJson(projectPath, warnings);
    if (projectRaw) {
      raw = mergeObjects(raw, projectRaw);
      activeProject = projectPath;
    }
  }

  const defaults = DEFAULT_CONFIG;
  const gateRaw = isPlainObject(raw.gate) ? raw.gate : {};
  const toolsRaw = isPlainObject(raw.tools) ? raw.tools : {};
  const budgetRaw = isPlainObject(raw.budget) ? raw.budget : {};
  const thrRaw = isPlainObject(raw.thresholds) ? raw.thresholds : {};
  const unavRaw = isPlainObject(raw.onUnavailable) ? raw.onUnavailable : {};

  const config: SuiteConfig = {
    enabled: coerceBool(raw.enabled, "enabled", warnings, defaults.enabled),
    provider: coerceProvider(raw.provider, "provider", warnings) ?? { ...defaults.provider },
    budget: {
      requestsPerDay: coerceInt(
        budgetRaw.requestsPerDay,
        "budget.requestsPerDay",
        warnings,
        defaults.budget.requestsPerDay,
        1,
        1_000_000,
      ),
      usdPerDay:
        typeof budgetRaw.usdPerDay === "number" && budgetRaw.usdPerDay >= 0
          ? budgetRaw.usdPerDay
          : defaults.budget.usdPerDay,
    },
    gate: {
      provider: coerceProvider(gateRaw.provider, "gate.provider", warnings),
      records: coerceEnum(
        gateRaw.records,
        "gate.records",
        warnings,
        ["full", "status", "off"] as const,
        defaults.gate.records,
      ),
      allow: coercePatterns(gateRaw.allow, "gate.allow", warnings),
      deny: coercePatterns(gateRaw.deny, "gate.deny", warnings),
      extraReadOnly: coercePatterns(gateRaw.extraReadOnly, "gate.extraReadOnly", warnings),
      transparentWrappers: coercePatterns(
        gateRaw.transparentWrappers ?? defaults.gate.transparentWrappers,
        "gate.transparentWrappers",
        warnings,
      ),
      protectedPaths: coercePatterns(gateRaw.protectedPaths, "gate.protectedPaths", warnings),
      extraProtectedPaths: coercePatterns(gateRaw.extraProtectedPaths, "gate.extraProtectedPaths", warnings),
    },
    tools: {
      enabled: coerceBool(toolsRaw.enabled, "tools.enabled", warnings, defaults.tools.enabled),
      provider: coerceProvider(toolsRaw.provider, "tools.provider", warnings),
    },
    thresholds: {
      intent_coverage: coerceThreshold(
        thrRaw.intent_coverage,
        "thresholds.intent_coverage",
        warnings,
        defaults.thresholds.intent_coverage,
      ),
      no_secret_egress: coerceThreshold(
        thrRaw.no_secret_egress,
        "thresholds.no_secret_egress",
        warnings,
        defaults.thresholds.no_secret_egress,
      ),
      no_irreversible_damage: coerceThreshold(
        thrRaw.no_irreversible_damage,
        "thresholds.no_irreversible_damage",
        warnings,
        defaults.thresholds.no_irreversible_damage,
      ),
    },
    onUnavailable: {
      mode: coerceEnum(
        unavRaw.mode,
        "onUnavailable.mode",
        warnings,
        ["degraded", "block"] as const,
        defaults.onUnavailable.mode,
      ),
      breakerAfter: coerceInt(
        unavRaw.breakerAfter,
        "onUnavailable.breakerAfter",
        warnings,
        defaults.onUnavailable.breakerAfter,
        1,
        100,
      ),
      cooldownMs: coerceInt(
        unavRaw.cooldownMs,
        "onUnavailable.cooldownMs",
        warnings,
        defaults.onUnavailable.cooldownMs,
        1000,
        3_600_000,
      ),
    },
  };

  return { config, globalPath, projectPath: activeProject, warnings };
}
