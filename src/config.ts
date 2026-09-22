/**
 * pi-jev-permit / config.ts
 *
 * Config schema + presets + load / merge / validate.
 *
 * Design contract (see PLAN.md §4):
 *   - all rules live in config, code only carries the mechanics
 *   - on validation failure, **drop that field and record a warning**; never guess, never silently
 *     default (upstream lesson: a silent default hides config mistakes)
 *   - a preset expands into protocol + baseUrl + model; explicitly written fields override the preset
 *   - a project-level config only applies when the project is trusted
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- providers

export type Protocol = "systemone" | "decisions";

export const DECISIONS_PATH = "/api/alpha/decisions";
export const SYSTEMONE_PATH = "/v1/systemone";

export function protocolPath(p: Protocol): string {
  return p === "decisions" ? DECISIONS_PATH : SYSTEMONE_PATH;
}

/**
 * Presets encode pitfalls already hit:
 *   - a private gateway only accepts `typesafe/jev-1.13` (jev-latest → 403, typesafe/jev-latest → 400)
 *   - the two protocols return identically-shaped bodies, so one parser is shared; only the
 *     URL / key verification / model name differ
 *   - `gateway` deliberately carries **no** endpoint: a private gateway has no public address to
 *     put in a published package, so `provider.baseUrl` is required alongside it
 */
export const PRESETS = {
  typesafe: { protocol: "systemone", baseUrl: "https://api.typesafe.ai", model: "jev-1.13.0" },
  gateway: { protocol: "decisions", baseUrl: undefined, model: "typesafe/jev-1.13" },
  openrouter: { protocol: "decisions", baseUrl: "https://openrouter.ai", model: "typesafe/jev-1.13" },
} as const satisfies Record<string, { protocol: Protocol; baseUrl?: string | undefined; model: string }>;

export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

/** The model name each protocol uses on its default endpoint (for key verification, where no config is available). */
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

// ---------------------------------------------------------------- config shape

export type RecordMode = "full" | "status" | "off";
export type UnavailableMode = "degraded" | "block";

export interface GateConfig {
  provider?: ProviderConfig;
  records: RecordMode;
  allow: string[];
  deny: string[];
  extraReadOnly: string[];
  transparentWrappers: string[];
  /** Additional protected-path patterns; the built-in table lives in policy.ts and **cannot be disabled via config**. */
  protectedPaths: string[];
}

export interface Thresholds {
  /**
   * Block line for the two hazard questions: at or above it the call is refused.
   *
   * One number for both, rather than one per question, because they are the same judgement at
   * different severities and a single knob is what made the old design's behaviour legible.
   */
  allow: number;
  /**
   * Authorization line: below it, a hazardous call has no defence and is refused, however loud the
   * user's instruction was. Defaults to `allow - 0.2`.
   */
  authorization?: number;
}

export interface OnUnavailable {
  mode: UnavailableMode;
  breakerAfter: number;
  cooldownMs: number;
}

export interface PermitConfig {
  enabled: boolean;
  provider: ProviderConfig;
  gate: GateConfig;
  thresholds: Thresholds;
  onUnavailable: OnUnavailable;
}

// ---------------------------------------------------------------- defaults

export const DEFAULT_CONFIG: PermitConfig = {
  enabled: true,
  provider: { preset: "typesafe", timeoutMs: 4000, maxRetries: 1 },
  gate: {
    records: "status",
    allow: [],
    deny: [],
    extraReadOnly: [],
    transparentWrappers: ["rtk"],
    protectedPaths: [],
  },
  /**
   * Only allow what the model **clearly thinks should be allowed**: one probability, one threshold.
   *
   * 0.6 is the measured starting point: asking the single question "is this consistent with what
   * the user is working on" gave 0.77–0.98 when covered and 0.06–0.15 when not. Now that three
   * considerations are folded into one question, the boundary sits a bit more toward the middle,
   * so during the observation window use `/jev-permit stats` to read the distribution before
   * retuning (it is the only knob).
   */
  thresholds: {
    allow: 0.6,
  },
  onUnavailable: { mode: "degraded", breakerAfter: 3, cooldownMs: 60000 },
};

// ---------------------------------------------------------------- validation bounds

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
  config: PermitConfig;
  /** The effective global config path */
  globalPath: string;
  /** The effective project config path (null when not trusted) */
  projectPath: string | null;
  warnings: string[];
}

/** The value domain at the JSON boundary: functions move only between these two types, never returning a bare `unknown`. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------- small helpers

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJson(path: string, warnings: string[]): JsonObject | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // a missing file is the normal case
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      warnings.push(`${path}: top-level value is not a JSON object, ignored`);
      return null;
    }
    return parsed;
  } catch (err) {
    warnings.push(`${path}: JSON parse failed (${(err as Error).message}), ignored`);
    return null;
  }
}

/**
 * Deep-merge two JSON objects: objects recurse, everything else (including arrays) is replaced
 * whole — in config an array is "the full value of this key", never appended to.
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
  if (v === undefined) return fallback; // absent is not an error: a missing field silently uses the default
  if (typeof v === "boolean") return v;
  warnings.push(`${field}: expected boolean, got ${JSON.stringify(v)}, using default ${fallback}`);
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
  warnings.push(`${field}: expected an integer in ${min}..${max}, got ${JSON.stringify(v)}, using default ${fallback}`);
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
  warnings.push(`${field}: expected ${allowed.join(" | ")}, got ${JSON.stringify(v)}, using default ${fallback}`);
  return fallback;
}

function coercePatterns(v: unknown, field: string, warnings: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    warnings.push(`${field}: expected an array of strings, got ${JSON.stringify(v)}, ignored`);
    return [];
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || item.length === 0) {
      warnings.push(`${field}: skipping non-string or empty pattern ${JSON.stringify(item)}`);
      continue;
    }
    if (item.length > LIMITS.maxPatternLength) {
      warnings.push(`${field}: pattern too long, skipped (>${LIMITS.maxPatternLength}): ${item.slice(0, 40)}...`);
      continue;
    }
    out.push(item);
  }
  if (out.length > LIMITS.maxPatternEntries) {
    warnings.push(`${field}: more than ${LIMITS.maxPatternEntries} entries, truncated`);
    return out.slice(0, LIMITS.maxPatternEntries);
  }
  return out;
}

function coerceThreshold(v: unknown, field: string, warnings: string[], fallback: number): number {
  // a threshold must stay in (0.5, 1]
  if (v === undefined) return fallback;
  if (typeof v === "number" && Number.isFinite(v) && v > LIMITS.minThreshold && v <= LIMITS.maxThreshold) {
    return v;
  }
  warnings.push(
    `${field}: expected ${LIMITS.minThreshold} < threshold <= ${LIMITS.maxThreshold}, ` +
      `got ${JSON.stringify(v)}, using default ${fallback}`,
  );
  return fallback;
}

function coerceProvider(v: unknown, field: string, warnings: string[]): ProviderConfig | undefined {
  if (v === undefined) return undefined;
  if (!isPlainObject(v)) {
    warnings.push(`${field}: expected an object, ignored`);
    return undefined;
  }
  const out: ProviderConfig = {};
  if (v.preset !== undefined) {
    if (typeof v.preset === "string" && (PRESET_NAMES as string[]).includes(v.preset)) {
      out.preset = v.preset as PresetName;
    } else {
      warnings.push(
        `${field}.preset: unknown preset ${JSON.stringify(v.preset)} (available: ${PRESET_NAMES.join(", ")}), ignored`,
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
      warnings.push(`${field}.baseUrl: expected an http(s) URL, got ${JSON.stringify(v.baseUrl)}, ignored`);
    }
  }
  if (v.model !== undefined) {
    if (typeof v.model === "string" && v.model.length > 0) out.model = v.model;
    else warnings.push(`${field}.model: expected a non-empty string, ignored`);
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
  const preset = out.preset === undefined ? undefined : PRESETS[out.preset];
  if (preset !== undefined && preset.baseUrl === undefined && out.baseUrl === undefined) {
    warnings.push(
      `${field}: preset ${out.preset} carries no endpoint of its own (a private gateway has no public address to ship), so ${field}.baseUrl is required`,
    );
  }
  return out;
}

/** Expand a preset: explicit fields win; when neither is given, fall back to the official TypeSafe preset. */
export function resolveProvider(cfg: ProviderConfig | undefined, budgeted?: Partial<ResolvedProvider>): ResolvedProvider {
  const merged: ProviderConfig = { ...DEFAULT_CONFIG.provider, ...(cfg ?? {}) };
  const preset = merged.preset ? PRESETS[merged.preset] : undefined;
  return {
    protocol: merged.protocol ?? preset?.protocol ?? "systemone",
    // No endpoint fallback beyond the preset: for a decisions endpoint with none configured, an
    // empty baseUrl is the honest answer. Falling back to TypeSafe would send a gateway key to the
    // wrong host, which is a failure that costs an afternoon.
    baseUrl: merged.baseUrl ?? preset?.baseUrl ?? "",
    model: merged.model ?? preset?.model ?? PRESETS.typesafe.model,
    timeoutMs: merged.timeoutMs ?? DEFAULT_CONFIG.provider.timeoutMs!,
    maxRetries: merged.maxRetries ?? 1,
    ...budgeted,
  };
}

// ---------------------------------------------------------------- loading

export interface LoadOptions {
  agentDir: string;
  cwd: string;
  trusted: boolean;
}

/**
 * Read the global + project config, deep-merge, validate, and return a usable config.
 * Any invalid field only affects itself (dropped + warning); one bad value never takes the whole gate down.
 */
export function loadConfig(opts: LoadOptions): LoadResult {
  const warnings: string[] = [];
  const globalPath = join(opts.agentDir, "pi-jev-permit.json");
  const projectPath = join(opts.cwd, ".pi", "pi-jev-permit.json");

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
  const thrRaw = isPlainObject(raw.thresholds) ? raw.thresholds : {};
  const unavRaw = isPlainObject(raw.onUnavailable) ? raw.onUnavailable : {};

  const config: PermitConfig = {
    enabled: coerceBool(raw.enabled, "enabled", warnings, defaults.enabled),
    provider: coerceProvider(raw.provider, "provider", warnings) ?? { ...defaults.provider },
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
    },
    thresholds: {
      allow: coerceThreshold(thrRaw.allow, "thresholds.allow", warnings, defaults.thresholds.allow),
      ...(thrRaw.authorization === undefined
        ? {}
        : {
            authorization: coerceThreshold(
              thrRaw.authorization,
              "thresholds.authorization",
              warnings,
              defaults.thresholds.allow - 0.2,
            ),
          }),
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
