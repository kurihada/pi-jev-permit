/**
 * 切段 / 归一化 / 分词 / 模式匹配 —— 纯函数，不需要 pi、不需要网络。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchCommandPattern, normalizeSegment, splitChain, tokenize } from "../src/policy.ts";

// ---------------------------------------------------------------- splitChain

test("splitChain：按 ; && || | & 换行 切段", () => {
  assert.deepEqual(splitChain("ls -la").map((s) => s.raw), ["ls -la"]);
  assert.deepEqual(splitChain("a; b").map((s) => s.raw), ["a", "b"]);
  assert.deepEqual(splitChain("a && b").map((s) => s.raw), ["a", "b"]);
  assert.deepEqual(splitChain("a || b").map((s) => s.raw), ["a", "b"]);
  assert.deepEqual(splitChain("a | b").map((s) => s.raw), ["a", "b"]);
  assert.deepEqual(splitChain("a\nb").map((s) => s.raw), ["a", "b"]);
  assert.deepEqual(splitChain("   ").map((s) => s.raw), []);
});

test("splitChain：引号内的分隔符不切", () => {
  assert.deepEqual(splitChain(`echo "a;b"`).map((s) => s.raw), [`echo "a;b"`]);
  assert.deepEqual(splitChain(`echo 'a|b'`).map((s) => s.raw), [`echo 'a|b'`]);
  assert.deepEqual(splitChain(`echo "a\\"b"`).map((s) => s.raw), [`echo "a\\"b"`]);
});

test("splitChain：2>&1 / >&2 是 fd 复制，不切段", () => {
  assert.deepEqual(splitChain("ls -la 2>&1").map((s) => s.raw), ["ls -la 2>&1"]);
  assert.deepEqual(splitChain("foo >&2").map((s) => s.raw), ["foo >&2"]);
  // 真正的后台符仍然切段
  assert.deepEqual(splitChain("a & b").map((s) => s.raw), ["a", "b"]);
});

test("splitChain：命令替换 / 反引号 / heredoc / 子 shell / 不闭合引号 → taint", () => {
  for (const cmd of ["echo $(pwd)", "echo `pwd`", "cat <<EOF", "(cd /x && ls)", "echo 'unclosed"]) {
    const segs = splitChain(cmd);
    assert.ok(
      segs.length === 0 || segs.every((s) => s.tainted),
      `应标记 tainted: ${cmd}`,
    );
  }
  assert.equal(splitChain("ls -la").every((s) => s.tainted), false);
});

// ---------------------------------------------------------------- normalizeSegment

test("normalizeSegment：纯赋值段是惰性的（rtk 前缀的解）", () => {
  const r = normalizeSegment("export RTK_DB_PATH='/var/folders/x/history.db'", ["rtk"]);
  assert.equal(r.lazy, true);
  assert.equal(r.command, "");
  assert.equal(r.unsafe, false);
  assert.equal(normalizeSegment("FOO=", []).lazy, true);
});

test("normalizeSegment：含动态内容的赋值不是惰性，且标 unsafe", () => {
  for (const seg of ["export X=$(rm -rf /)", "X=`rm -rf /`", "FOO='a;rm -rf /'", "F=1|2", "V=a>b"]) {
    const r = normalizeSegment(seg, []);
    assert.ok(r.unsafe || !r.lazy, `不应是安全惰性赋值: ${seg}`);
  }
});

test("normalizeSegment：剥掉透明包装器", () => {
  assert.equal(normalizeSegment("rtk ls -l /tmp", ["rtk"]).command, "ls -l /tmp");
  assert.equal(normalizeSegment("rtk rtk git status", ["rtk"]).command, "git status");
  // 没声明为透明包装器的，原样保留（默认只认 rtk）
  assert.equal(normalizeSegment("faker ls", ["rtk"]).command, "faker ls");
});

test("normalizeSegment：前置赋值 + 真命令（FOO=1 cmd）", () => {
  assert.equal(normalizeSegment("FOO=1 ls -la", []).command, "ls -la");
  assert.equal(normalizeSegment("export FOO=1 ls -la", []).command, "ls -la");
});

// ---------------------------------------------------------------- tokenize / 匹配

test("tokenize：标出引号开头的 token（引号开头的不可能是选项）", () => {
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

test("matchCommandPattern：锚定、* 跨空格、其余字符转义", () => {
  assert.equal(matchCommandPattern("ls *", "ls -la /tmp"), true);
  assert.equal(matchCommandPattern("ls *", "lsof"), false, "必须锚定");
  assert.equal(matchCommandPattern("git -C * status", "git -C /a/b status"), true);
  assert.equal(matchCommandPattern("ls", "ls -la"), false, "不带 * 就是精确匹配");
  assert.equal(matchCommandPattern("a.b", "axb"), false, "点号要转义");
  assert.equal(matchCommandPattern("*rm -rf*", "cd /x && rm -rf y"), true);
});
