/**
 * 与 pi-rtk-optimizer 的兼容：rtk **不只是给命令加前缀，它会把动词翻译掉**。
 *
 * 上线实测抓到的：`tail -2 <file>` 被改写成 `rtk read <file>`，
 * 只剥掉 `rtk` 包装器会剩下一个「我从没写过的命令名」→ 判成不在只读表 → 送第③层。
 * 这一类问题（任何重命名命令的扩展）只能在门禁侧吸收，所以这里把几条路径都钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BashPolicy, decideBash, readOnlyProblem } from "../src/policy.ts";

const POLICY: BashPolicy = { allow: [], deny: [], extraReadOnly: [], transparentWrappers: ["rtk"] };

const wrapped = (command: string): string => `export RTK_DB_PATH='/tmp/history.db'; ${command}`;

test("rtk 包装 + 惰性赋值：整条走只读快路径，不打网络", () => {
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

test("rtk 的动词翻译不能变成绕过凭据检查的后门", () => {
  // `read` 同时是 shell 内建与 rtk 给 tail 用的名字 —— 加进只读表就必须同时加进凭据敏感集合
  assert.notEqual(readOnlyProblem("read /Users/xd/.ssh/id_rsa"), null);
  assert.notEqual(readOnlyProblem("read /Users/xd/.pi/agent/secrets/x-api-key"), null);
  assert.notEqual(readOnlyProblem("read $FILE"), null, "参数含未解析变量也不放行");

  const result = decideBash(wrapped("rtk read /Users/xd/.ssh/id_rsa"), POLICY);
  assert.equal(result.decision.kind, "ask", "凭据文件仍然要判定");
});

test("rtk 包装的非只读命令仍要判定", () => {
  const result = decideBash(wrapped("rtk rm -rf /tmp/x"), POLICY);
  assert.equal(result.decision.kind, "ask", "rm 不是只读，仍走第③层");
});

test("硬拦必须看穿透明包装器（否则 rtk 会削弱到不了的硬拦层）", () => {
  const result = decideBash(wrapped("rtk rm -rf /"), POLICY);
  assert.equal(result.decision.kind, "deny");
  assert.equal(result.decision.layer, "harddeny");

  const branch = decideBash(wrapped("rtk git push --force origin main"), POLICY);
  assert.equal(branch.decision.kind, "deny");
});
