/**
 * Diagnose: run one command through the gate's algorithm step by step and
 * print, per segment, which layer it lands on and why.
 *
 * Usage:
 *   node --experimental-strip-types test/diagnose.ts "<command text>"
 *
 * It reproduces **the text the gate actually sees**: if an extension such as
 * pi-rtk-optimizer rewrote the command, paste the rewritten form here
 * (otherwise you will think the fast path is broken when the wrapper just
 * was not stripped).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { decideBash, normalizeSegment, readOnlyProblem, splitChain } from "../src/policy.ts";

const command = process.argv.slice(2).join(" ");
if (command.trim().length === 0) {
  console.error('Usage: node --experimental-strip-types test/diagnose.ts "<command text>"');
  process.exit(2);
}

const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const { config } = loadConfig({ agentDir, cwd: process.cwd(), trusted: false });
const policy = {
  allow: config.gate.allow,
  deny: config.gate.deny,
  extraReadOnly: config.gate.extraReadOnly,
  transparentWrappers: config.gate.transparentWrappers,
};

console.log(`Command: ${command}`);
console.log(`Transparent wrappers: ${policy.transparentWrappers.join(", ") || "(none)"}`);
console.log(`Allowlist: ${policy.allow.join(" | ") || "(empty)"}`);
console.log("");

for (const segment of splitChain(command)) {
  const normalized = normalizeSegment(segment.raw, policy.transparentWrappers);
  const verdict = normalized.lazy
    ? "(lazy assignment, skipped)"
    : normalized.unsafe
      ? `unsafe assignment → tainted`
      : (readOnlyProblem(normalized.command) ?? "clearly read-only ✔");
  console.log(`segment raw=${JSON.stringify(segment.raw)}`);
  console.log(
    `   tainted=${segment.tainted} lazy=${normalized.lazy} unsafe=${normalized.unsafe}`,
  );
  console.log(`   normalized=${JSON.stringify(normalized.command)}`);
  console.log(`   → ${verdict}`);
}

const result = decideBash(command, policy);
console.log("");
console.log(`Decision: ${result.decision.kind} / ${result.decision.layer}`);
console.log(`Reason: ${result.decision.reason}`);
