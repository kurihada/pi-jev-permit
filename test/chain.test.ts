/**
 * Splitting / normalization / tokenizing / pattern matching -- pure functions, no pi, no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchCommandPattern, normalizeSegment, splitChain, tokenize } from "../src/policy.ts";

// ---------------------------------------------------------------- splitChain

test("splitChain: split on ; && || | & and newlines", () => {
  assert.deepEqual(splitChain("ls -la").map((s) => s.raw), ["ls -la"]);
  assert.deepEqual(splitChain("a; b").map((s) => s.raw), ["a", "b"]);
  assert.deepEqual(splitChain("a && b").map((s) => s.raw), ["a", "b"]);
  assert.deepEqual(splitChain("a || b").map((s) => s.raw), ["a", "b"]);
  assert.deepEqual(splitChain("a | b").map((s) => s.raw), ["a", "b"]);
  assert.deepEqual(splitChain("a\nb").map((s) => s.raw), ["a", "b"]);
  assert.deepEqual(splitChain("   ").map((s) => s.raw), []);
});

test("splitChain: separators inside quotes are not split", () => {
  assert.deepEqual(splitChain(`echo "a;b"`).map((s) => s.raw), [`echo "a;b"`]);
  assert.deepEqual(splitChain(`echo 'a|b'`).map((s) => s.raw), [`echo 'a|b'`]);
  assert.deepEqual(splitChain(`echo "a\\"b"`).map((s) => s.raw), [`echo "a\\"b"`]);
});

test("splitChain: 2>&1 / >&2 is an fd dup, not a split", () => {
  assert.deepEqual(splitChain("ls -la 2>&1").map((s) => s.raw), ["ls -la 2>&1"]);
  assert.deepEqual(splitChain("foo >&2").map((s) => s.raw), ["foo >&2"]);
  // a real background operator still splits
  assert.deepEqual(splitChain("a & b").map((s) => s.raw), ["a", "b"]);
});

test("splitChain: command substitution / backtick / heredoc / subshell / unterminated quote -> taint", () => {
  for (const cmd of ["echo $(pwd)", "echo `pwd`", "cat <<EOF", "(cd /x && ls)", "echo 'unclosed"]) {
    const segs = splitChain(cmd);
    assert.ok(
      segs.length === 0 || segs.every((s) => s.tainted),
      `should be tainted: ${cmd}`,
    );
  }
  assert.equal(splitChain("ls -la").every((s) => s.tainted), false);
});

// ---------------------------------------------------------------- normalizeSegment

test("normalizeSegment: a pure assignment segment is inert (the rtk-prefix fix)", () => {
  const r = normalizeSegment("export RTK_DB_PATH='/var/folders/x/history.db'", ["rtk"]);
  assert.equal(r.lazy, true);
  assert.equal(r.command, "");
  assert.equal(r.unsafe, false);
  assert.equal(normalizeSegment("FOO=", []).lazy, true);
});

test("normalizeSegment: an assignment with dynamic content is not inert, and is marked unsafe", () => {
  for (const seg of ["export X=$(rm -rf /)", "X=`rm -rf /`", "FOO='a;rm -rf /'", "F=1|2", "V=a>b"]) {
    const r = normalizeSegment(seg, []);
    assert.ok(r.unsafe || !r.lazy, `should not be a safe inert assignment: ${seg}`);
  }
});

test("normalizeSegment: strips transparent wrappers", () => {
  assert.equal(normalizeSegment("rtk ls -l /tmp", ["rtk"]).command, "ls -l /tmp");
  assert.equal(normalizeSegment("rtk rtk git status", ["rtk"]).command, "git status");
  // a name not declared as a transparent wrapper is kept as-is (only rtk by default)
  assert.equal(normalizeSegment("faker ls", ["rtk"]).command, "faker ls");
});

test("normalizeSegment: leading assignment + a real command (FOO=1 cmd)", () => {
  assert.equal(normalizeSegment("FOO=1 ls -la", []).command, "ls -la");
  assert.equal(normalizeSegment("export FOO=1 ls -la", []).command, "ls -la");
});

// ---------------------------------------------------------------- tokenize / matching

test("tokenize: marks tokens that start with a quote (a quoted token cannot be an option)", () => {
  const t = tokenize(`rm -rf "$d/pi-warden.md"`);
  assert.deepEqual(
    t.map((x) => [x.text, x.quoted]),
    [
      ["rm", false],
      ["-rf", false],
      ["$d/pi-warden.md", true],
    ],
  );
});

test("matchCommandPattern: anchored, * spans spaces, everything else escaped", () => {
  assert.equal(matchCommandPattern("ls *", "ls -la /tmp"), true);
  assert.equal(matchCommandPattern("ls *", "lsof"), false, "must be anchored");
  assert.equal(matchCommandPattern("git -C * status", "git -C /a/b status"), true);
  assert.equal(matchCommandPattern("ls", "ls -la"), false, "without * it is an exact match");
  assert.equal(matchCommandPattern("a.b", "axb"), false, "the dot must be escaped");
  assert.equal(matchCommandPattern("*rm -rf*", "cd /x && rm -rf y"), true);
});
