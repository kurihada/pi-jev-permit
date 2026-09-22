/**
 * Layer 0 and the variables a command sets for itself.
 *
 * Measured false positive: `T=/tmp/pi-mt-inspect; rm -rf $T; mkdir -p $T; …` was hard-denied, because
 * layer 0 will not delete a target it cannot resolve — and layer 0 accepts no grant, so there was no
 * way through it, not even `/jev-permit allow`.
 *
 * Reading the assignment makes that a deletion of a named directory, which is what it is. These tests
 * are mostly about the three limits that keep it honest: earlier only, plain literals only, and never
 * inside single quotes. A substitution that invented information would be worse than the false
 * positive it replaces, because it would be a hole in the one layer nothing else can override.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BashPolicy, decideBash, resolveLiteralAssignments } from "../src/policy.ts";

const POLICY: BashPolicy = { allow: [], deny: [], extraReadOnly: [], transparentWrappers: ["rtk"] };
const hardDenied = (command: string, policy: BashPolicy = POLICY): boolean =>
  decideBash(command, policy).decision.layer === "harddeny";

test("the measured case: a target the same command named is not an unresolved one", () => {
  const command =
    "T=/tmp/pi-mt-inspect; rm -rf $T; mkdir -p $T; cd $T && npm pack @indexyz/pi-model-trace-api";
  assert.equal(hardDenied(command), false, "it is a named directory, not an opaque target");
  assert.equal(decideBash(command, POLICY).decision.kind, "ask", "so it goes to the model like any other call");
});

test("an unresolved target is still unresolved", () => {
  assert.equal(hardDenied("rm -rf $T"), true);
  assert.equal(hardDenied("OTHER=/tmp/x; rm -rf $T"), true, "a different variable says nothing about this one");
  assert.equal(hardDenied("rm -rf $HOME"), true);
});

test("reading the assignment also catches the dangerous case it was hiding", () => {
  assert.equal(hardDenied("T=/; rm -rf $T"), true);
  assert.equal(hardDenied("T=/; rm -rf ${T}"), true, "the braced form is the same variable");
  assert.equal(hardDenied("T=/tmp/x; T=/; rm -rf $T"), true, "the last assignment before the delete wins");
  assert.equal(hardDenied("T=$HOME; rm -rf $T"), true, "a value that is itself a variable stays opaque");
});

test("only plain literals are substituted", () => {
  assert.equal(hardDenied("T=$(rm -rf /); rm -rf $T"), true, "a subshell is not a literal");
  assert.equal(hardDenied("X='a; rm -rf /'; rm -rf $X"), true, "a value carrying a separator is not one either");
  assert.equal(hardDenied("X=`rm -rf /`; rm -rf $X"), true);
  assert.equal(hardDenied('X="/tmp/a|b"; rm -rf $X'), true, "quoted, the separator is part of the value");
  // Unquoted it is a separator to the shell as well, so the value really is `/tmp/a` and the delete
  // really does name an ordinary directory. The splitting is the shell's, not a shortcut of ours.
  assert.equal(hardDenied("X=/tmp/a|b; rm -rf $X"), false);
});

test("an assignment that comes later says nothing about an earlier delete", () => {
  // At the moment `rm -rf $T` runs, `$T` is empty — so the substitution must not reach forward.
  assert.equal(hardDenied("rm -rf $T; T=/tmp/x"), true);
});

test("quotes are respected: double quotes expand, single quotes do not", () => {
  assert.equal(hardDenied('T=/tmp/x; rm -rf "$T"'), false, "a double-quoted expansion is still the value");
  assert.equal(
    resolveLiteralAssignments("T=/tmp/x; echo '$T'"),
    "T=/tmp/x; echo '$T'",
    "inside single quotes it is literal text, so there is nothing to resolve",
  );
});

test("export is the same assignment", () => {
  assert.equal(hardDenied("export T=/tmp/pi-mt-inspect; rm -rf $T"), false);
  assert.equal(hardDenied("export T=/; rm -rf $T"), true);
});

test("nothing else about the pipeline moved", () => {
  // The substitution feeds layer 0 only: the raw text is what the other layers and the log see.
  const result = decideBash("T=/tmp/x; rm -rf $T", POLICY);
  assert.equal(result.segments[1]?.raw, "rm -rf $T", "the segment keeps what the agent typed");
  assert.equal(resolveLiteralAssignments("ls -la /tmp"), "ls -la /tmp", "a command with no assignment is untouched");
});
