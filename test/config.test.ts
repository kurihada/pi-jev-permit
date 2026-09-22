/**
 * Config loading / merging / validation.
 * This is the only layer that touches IO; the rule is "drop an invalid field + warn", so one
 * typo never takes the whole gate down.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, PRESETS, loadConfig, mergeObjects, resolveProvider } from "../src/config.ts";

function scaffold(): { agentDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-jev-permit-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  return { agentDir, cwd };
}

// ---------------------------------------------------------------- preset expansion

test("resolveProvider: defaults to the official TypeSafe", () => {
  const p = resolveProvider({});
  assert.equal(p.protocol, "systemone");
  assert.equal(p.baseUrl, PRESETS.typesafe.baseUrl);
  assert.equal(p.model, "jev-1.13.0");
});

test("resolveProvider: a preset expands into protocol + baseUrl + model", () => {
  const p = resolveProvider({ preset: "openrouter" });
  assert.equal(p.protocol, "decisions");
  assert.equal(p.baseUrl, "https://openrouter.ai");
  assert.equal(p.model, "typesafe/jev-1.13");
  assert.equal(p.timeoutMs, 4000);
});

test("resolveProvider: the gateway preset carries no endpoint, so the config supplies one", () => {
  const p = resolveProvider({ preset: "gateway", baseUrl: "https://gateway.test" });
  assert.equal(p.protocol, "decisions");
  assert.equal(p.baseUrl, "https://gateway.test");
  assert.equal(p.model, "typesafe/jev-1.13");

  // Nothing configured: empty rather than falling back to TypeSafe, which would send a private
  // gateway's key to the wrong host - a failure that costs an afternoon to diagnose.
  assert.equal(resolveProvider({ preset: "gateway" }).baseUrl, "");
});

test("resolveProvider: explicit fields override the preset", () => {
  const p = resolveProvider({ preset: "openrouter", model: "typesafe/jev-latest", timeoutMs: 9000 });
  assert.equal(p.model, "typesafe/jev-latest");
  assert.equal(p.timeoutMs, 9000);
  assert.equal(p.baseUrl, "https://openrouter.ai");
});

// ---------------------------------------------------------------- merge

test("mergeObjects: objects recurse, arrays replace whole", () => {
  const merged = mergeObjects(
    { gate: { allow: ["ls *"], records: "status" }, thresholds: { allow: 0.7 } },
    { gate: { allow: ["cat *"] } },
  );
  assert.deepEqual(merged.gate, { allow: ["cat *"], records: "status" }, "arrays replace, not append");
  assert.deepEqual(merged.thresholds, { allow: 0.7 });
});

// ---------------------------------------------------------------- loading

test("no config files -> defaults, no warnings", () => {
  const { agentDir, cwd } = scaffold();
  const r = loadConfig({ agentDir, cwd, trusted: true });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.enabled, DEFAULT_CONFIG.enabled);
  assert.deepEqual(r.config.gate.transparentWrappers, ["rtk"]);
  assert.deepEqual(r.config.provider, DEFAULT_CONFIG.provider);
  assert.equal(r.projectPath, null);
});

test("the global config applies, and the gate can override the access method", () => {
  const { agentDir, cwd } = scaffold();
  writeFileSync(
    join(agentDir, "pi-jev-permit.json"),
    JSON.stringify({
      provider: { preset: "typesafe", timeoutMs: 3000 },
      gate: { provider: { preset: "gateway", baseUrl: "https://g.test" }, records: "status", allow: ["ls *"] },
      // a leftover `tools` block from when jev_evaluate and ask_advisor existed
      tools: { provider: { preset: "typesafe" } },
    }),
  );
  const r = loadConfig({ agentDir, cwd, trusted: true });
  assert.deepEqual(r.warnings, [], "a leftover tools block is simply not read any more, and is not an error");
  assert.equal(resolveProvider(r.config.provider).baseUrl, "https://api.typesafe.ai");
  assert.equal(resolveProvider(r.config.gate.provider).protocol, "decisions", "the gate overrides to the gateway");
  assert.deepEqual(r.config.gate.allow, ["ls *"]);
});

test("an invalid value only affects itself and produces a warning", () => {
  const { agentDir, cwd } = scaffold();
  writeFileSync(
    join(agentDir, "pi-jev-permit.json"),
    JSON.stringify({
      provider: { preset: "nope", timeoutMs: 999999 },
      gate: { records: "yes", allow: ["ls *", 42, ""], deny: "sudo *" },
      thresholds: { allow: 0.2 },
      onUnavailable: { mode: "whatever" },
    }),
  );
  const r = loadConfig({ agentDir, cwd, trusted: true });
  assert.equal(resolveProvider(r.config.provider).baseUrl, PRESETS.typesafe.baseUrl, "invalid preset -> falls back to the default");
  assert.equal(r.config.provider.timeoutMs, 4000, "out-of-range timeout -> default");
  assert.equal(r.config.gate.records, "status", "invalid enum -> default");
  assert.deepEqual(r.config.gate.allow, ["ls *"], "bad array entries are dropped, good ones kept");
  assert.deepEqual(r.config.gate.deny, [], "a wrong type is dropped whole");
  assert.equal(r.config.thresholds.allow, 0.6, "0.2 is below the lower bound -> rejected, falls back to the default");
  assert.equal(r.config.onUnavailable.mode, "degraded");
  assert.ok(r.warnings.length >= 5, `should produce several warnings, got ${r.warnings.length}`);
});

test("the project config applies only when trusted", () => {
  const { agentDir, cwd } = scaffold();
  writeFileSync(
    join(agentDir, "pi-jev-permit.json"),
    JSON.stringify({ gate: { records: "off", transparentWrappers: ["rtk"] } }),
  );
  writeFileSync(
    join(cwd, ".pi", "pi-jev-permit.json"),
    JSON.stringify({ gate: { records: "full", transparentWrappers: [] } }),
  );

  const untrusted = loadConfig({ agentDir, cwd, trusted: false });
  assert.equal(untrusted.config.gate.records, "off", "untrusted -> project config ignored");
  assert.equal(untrusted.projectPath, null);

  const trusted = loadConfig({ agentDir, cwd, trusted: true });
  assert.equal(trusted.config.gate.records, "full", "trusted -> deep merge, project overrides global");
  assert.deepEqual(trusted.config.gate.transparentWrappers, [], "arrays replace whole");
  assert.equal(trusted.projectPath, join(cwd, ".pi", "pi-jev-permit.json"));
});

test("bad JSON only produces a warning and leaves other config alone", () => {
  const { agentDir, cwd } = scaffold();
  writeFileSync(join(cwd, ".pi", "pi-jev-permit.json"), "{ not json");
  const r = loadConfig({ agentDir, cwd, trusted: true });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /JSON parse failed/);
  assert.equal(r.config.enabled, true);
});

test("the threshold has a lower bound: below 0.5 is rejected and falls back", () => {
  const { agentDir, cwd } = scaffold();
  writeFileSync(join(agentDir, "pi-jev-permit.json"), JSON.stringify({ thresholds: { allow: 0.2 } }));
  const r = loadConfig({ agentDir, cwd, trusted: true });
  assert.equal(r.config.thresholds.allow, DEFAULT_CONFIG.thresholds.allow);
  assert.match(r.warnings.join("\n"), /0\.5 < threshold/);
});
