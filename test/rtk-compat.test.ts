/**
 * Compatibility with pi-rtk-optimizer: rtk does **not just add a prefix, it translates the verb**.
 *
 * Caught live: `tail -2 <file>` is rewritten to `rtk read <file>`; stripping only the `rtk`
 * wrapper leaves "a command name we never wrote" -> judged not read-only -> sent to layer 3.
 * This class of problem (any extension that renames commands) can only be absorbed on the gate
 * side, so the paths are pinned here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BashPolicy, decideBash, readOnlyProblem } from "../src/policy.ts";

const POLICY: BashPolicy = { allow: [], deny: [], extraReadOnly: [], transparentWrappers: ["rtk"] };

const wrapped = (command: string): string => `export RTK_DB_PATH='/tmp/history.db'; ${command}`;

test("rtk wrapper + inert assignment: the whole thing takes the read-only fast path, no network", () => {
  for (const command of [
    "rtk ls -la /tmp",
    "rtk wc -l /tmp/x.log",
    "rtk grep -n foo /tmp/x.log",
    "rtk tail -5 /tmp/x.log",
    "rtk read /tmp/x.log",
  ]) {
    const result = decideBash(wrapped(command), POLICY);
    assert.equal(result.decision.kind, "allow", command);
    assert.equal(result.decision.layer, "readonly", command);
  }
});

test("rtk's verb translation must not become a backdoor around the credential check", () => {
  // `read` is both a shell builtin and rtk's name for tail -- adding it to the read-only list
  // means adding it to the credential-sensitive set too
  assert.notEqual(readOnlyProblem("read /Users/xd/.ssh/id_rsa"), null);
  assert.notEqual(readOnlyProblem("read /Users/xd/.pi/agent/secrets/x-api-key"), null);
  assert.notEqual(readOnlyProblem("read $FILE"), null, "an argument with an unresolved variable is not allowed either");

  const result = decideBash(wrapped("rtk read /Users/xd/.ssh/id_rsa"), POLICY);
  assert.equal(result.decision.kind, "ask", "a credential file is still judged");
});

test("a non-read-only rtk-wrapped command is still judged", () => {
  const result = decideBash(wrapped("rtk rm -rf /tmp/x"), POLICY);
  assert.equal(result.decision.kind, "ask", "rm is not read-only, still goes to layer 3");
});

test("hard deny must see through transparent wrappers (otherwise rtk weakens the untouchable hard-deny layer)", () => {
  const result = decideBash(wrapped("rtk rm -rf /"), POLICY);
  assert.equal(result.decision.kind, "deny");
  assert.equal(result.decision.layer, "harddeny");

  const branch = decideBash(wrapped("rtk git push --force origin main"), POLICY);
  assert.equal(branch.decision.kind, "deny");
});
