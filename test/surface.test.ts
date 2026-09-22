/**
 * The tool surface: which tools the gate judges, and what happens to the ones nothing covers.
 *
 * This replaced a whitelist of three names. The hole it closes is not theoretical — pi's `tool_call`
 * event fires for every tool, `bash_bg` and `monitor` both carry a shell command, and under the
 * whitelist a call through either was neither judged nor recorded.
 *
 * The property worth pinning hardest is the boring one: a command tool is a command tool. `bash_bg`
 * running a credential read has to be refused exactly like `bash` running it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, type PermitConfig } from "../src/config.ts";
import {
  Breaker,
  type ExtensionApiLike,
  type GateContextLike,
  type GateDeps,
  evaluateToolCall,
  registerGate,
  toolSurface,
} from "../src/gate.ts";
import { type AskResult, EMPTY_USAGE, type JevClient } from "../src/jev.ts";
import type { BashPolicy } from "../src/policy.ts";

const POLICY: BashPolicy = { allow: [], deny: [], extraReadOnly: [], transparentWrappers: ["rtk"] };
const ALLOW = { q_critical: 0.02, q_risk: 0.2, q_auth: 0.9 };
const REFUSE = { q_critical: 0.9, q_risk: 0.9, q_auth: 0.1 };

function client(answers: Record<string, number>, counter: { calls: number }): JevClient {
  return {
    transport: "test",
    usage: () => EMPTY_USAGE("2026-09-21"),
    ask: async (payload): Promise<AskResult> => {
      counter.calls += 1;
      if (!Object.hasOwn(payload.questions, "q_critical")) {
        return { ok: true, answers: { because_outside_task: 0.9 }, model: "test", inputTokens: 1, outputTokens: 0, usd: 0, latencyMs: 1 };
      }
      return { ok: true, answers, model: "test", inputTokens: 10, outputTokens: 1, usd: 0, latencyMs: 5 };
    },
  };
}

function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    cwd: "/repo",
    policy: POLICY,
    protectedPaths: [],
    thresholds: DEFAULT_CONFIG.thresholds,
    client: client(ALLOW, { calls: 0 }),
    breaker: new Breaker({ breakerAfter: 3, cooldownMs: 60_000 }),
    intent: "work on the project",
    isGitRepository: true,
    turnKey: "1",
    ...over,
  };
}

test("classification: commands, writes, known readers, and everything else", () => {
  assert.equal(toolSurface("bash"), "command");
  assert.equal(toolSurface("bash_bg"), "command");
  assert.equal(toolSurface("monitor"), "command");
  assert.equal(toolSurface("write"), "write");
  assert.equal(toolSurface("edit"), "write");
  assert.equal(toolSurface("read"), "read");
  assert.equal(toolSurface("grep"), "read");

  // Unknown by construction: a tool an extension or an MCP server added after this was written.
  assert.equal(toolSurface("ctx_execute"), "uncovered");
  assert.equal(toolSurface("mcp__server__whatever"), "uncovered");
  assert.equal(toolSurface("agent_bg"), "uncovered");
});

test("a command tool goes through the command pipeline, whatever it is called", async () => {
  const counter = { calls: 0 };
  for (const tool of ["bash", "bash_bg", "monitor"]) {
    const verdict = await evaluateToolCall(
      tool,
      { command: "mkdir -p /tmp/x" },
      deps({ client: client(ALLOW, counter) }),
    );
    assert.equal(verdict.kind, "allow", tool);
    assert.equal(verdict.layer, "jev", `${tool} must be judged, not waved through`);
  }
  assert.equal(counter.calls, 3);
});

test("a credential read is refused through any command tool", async () => {
  const command = "cat /Users/xd/.ssh/id_rsa";
  for (const tool of ["bash", "bash_bg", "monitor"]) {
    const verdict = await evaluateToolCall(tool, { command }, deps({ client: client(REFUSE, { calls: 0 }) }));
    assert.equal(verdict.kind, "block", tool);
    assert.equal(verdict.layer, "jev", `${tool} was judged and refused by the model, not waved through`);
  }
});

test("a hard deny is a hard deny through any command tool", async () => {
  const verdict = await evaluateToolCall("bash_bg", { command: "rm -rf /" }, deps());
  assert.equal(verdict.layer, "harddeny");
});

test("an uncovered tool is allowed, and the gate says so instead of pretending to judge it", async () => {
  const counter = { calls: 0 };
  const verdict = await evaluateToolCall("ctx_execute", { code: "print(1)" }, deps({ client: client(ALLOW, counter) }));
  assert.equal(verdict.kind, "allow");
  assert.match(verdict.reason, /uncovered: nothing for the gate to decide/);
  assert.equal(counter.calls, 0, "nothing was sent: there is no command and no path to judge");
});

test("an uncovered tool is reported once per session, by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-permit-surface-"));
  try {
    let handler: ((event: { toolName: string; input: Record<string, unknown> }, ctx: GateContextLike) => Promise<unknown>) | undefined;
    const pi: ExtensionApiLike = {
      on: (_event, next) => {
        handler = next as typeof handler;
      },
    };
    const widgets: string[][] = [];
    const ctx = {
      cwd: "/repo",
      ui: { setWidget: (_key: string, lines: string[]) => widgets.push(lines) },
      sessionManager: { getBranch: () => [] },
    } as unknown as GateContextLike;
    const config: PermitConfig = { ...DEFAULT_CONFIG, gate: { ...DEFAULT_CONFIG.gate, records: "status" } };

    registerGate(pi, {
      agentDir: dir,
      breaker: new Breaker({ breakerAfter: 3, cooldownMs: 60_000, now: () => 0 }),
      loadConfig: () => config,
      makeClient: () => null,
    });
    assert.ok(handler !== undefined, "the gate must register a tool_call handler");

    await handler({ toolName: "ctx_execute", input: { code: "1" } }, ctx);
    await handler({ toolName: "ctx_execute", input: { code: "2" } }, ctx);
    await handler({ toolName: "read", input: { path: "/repo/x" } }, ctx);

    const log = readFileSync(join(dir, "pi-jev-permit-log.jsonl"), "utf8").trim().split("\n");
    assert.equal(log.length, 1, "one line per uncovered tool name, not one per call");
    const record = JSON.parse(log[0] ?? "{}") as Record<string, unknown>;
    assert.equal(record["layer"], "uncovered");
    assert.equal(record["status"], "allowed");
    assert.equal(record["tool"], "ctx_execute");
    assert.equal(widgets.length, 1, "and it is shown once, not on every call");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
