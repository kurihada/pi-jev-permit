/**
 * pi-jev-suite / policy.ts
 *
 * 纯函数层：切段 → 硬拦 → 配置匹配 → 只读判定。
 * 无 IO、无网络、无时钟、无随机 —— 必须能脱离 pi 单独跑（`node --test`）。
 *
 * 设计原则（见 PLAN.md §2）：
 *   **静态分析只用来【放行明显安全的】。任何不确定 → 送去 Jev 层。**
 *
 * 与 pi-jev-auto-mode 的根本差别：判定对象是**段**（切段后的 argv），不是整条命令字符串。
 * 所以配置里的 allow/deny 模式不再被 `;` `&&` `|` `$` 之类字符禁用。
 */

// ---------------------------------------------------------------- 类型

export interface Segment {
  /** 原始段文本（未归一化） */
  raw: string;
  /** 含无法静态解析的内容（命令替换 / 反引号 / heredoc / 子 shell / 引号不闭合 / 不安全赋值） */
  tainted: boolean;
  /** 归一化后的命令：剥掉前置赋值与透明包装器；纯赋值段为空串 */
  command: string;
  /** 纯赋值段（惰性，不算命令） */
  lazy: boolean;
}

export interface Token {
  /** 去掉外层引号后的文本 */
  text: string;
  /** 原始 token 是否以引号开头（引号开头的不可能是命令行选项） */
  quoted: boolean;
}

export type Decision =
  | { kind: "allow"; layer: "config" | "readonly"; reason: string }
  | { kind: "deny"; layer: "harddeny" | "config"; reason: string }
  | { kind: "ask"; layer: "jev"; reason: string };

export interface BashPolicy {
  allow: string[];
  deny: string[];
  extraReadOnly: string[];
  transparentWrappers: string[];
}

export interface BashResult {
  decision: Decision;
  segments: Segment[];
}

// ---------------------------------------------------------------- 切段

const SHELL_SEPARATORS = new Set([";", "&", "|", "\n"]);

/**
 * 按 `;` `&&` `||` `|` `&` 换行切段，尊重引号与反斜杠转义。
 *
 * `tainted` 一旦为真不可逆：宁可整段送 Jev，也不做半吊子解析。
 * 触发 taint 的东西：`$( )`、反引号、`<<` heredoc、未加引号的 `(`/`)`、引号不闭合。
 *
 * `ponytail:` 这是手写状态机，不是 shell 解析器。上限：heredoc / eval / 复杂嵌套一律 taint。
 * 升级路径：换成真正的 shell 词法器（如 shell-quote）。当前策略是"不确定就不放行"。
 */
export function splitChain(command: string): Segment[] {
  const out: Segment[] = [];
  let buf = "";
  let tainted = false;
  let quote: '"' | "'" | null = null;

  const flush = () => {
    const raw = buf.trim();
    if (raw) out.push({ raw, tainted, command: raw, lazy: false });
    buf = "";
    tainted = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (quote === "'") {
      buf += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        buf += ch;
        continue;
      }
      if (ch === "\\") {
        buf += ch;
        if (i + 1 < command.length) buf += command[++i]!;
        continue;
      }
      if (ch === "`" || (ch === "$" && command[i + 1] === "(")) tainted = true;
      buf += ch;
      continue;
    }
    if (ch === "\\") {
      buf += ch;
      if (i + 1 < command.length) buf += command[++i]!;
      continue;
    }
    if (ch === '"') {
      quote = quote === '"' ? null : '"';
      buf += ch;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      buf += ch;
      continue;
    }

    if (ch === "`") {
      tainted = true;
      buf += ch;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      tainted = true;
      buf += ch;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      tainted = true;
      buf += ch;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tainted = true;
      buf += ch;
      continue;
    }

    if (SHELL_SEPARATORS.has(ch)) {
      // `2>&1` / `>&2` 是文件描述符复制，不是命令分隔符
      if (ch === "&" && buf.trimEnd().endsWith(">")) {
        buf += ch;
        while (i + 1 < command.length && /[0-9-]/.test(command[i + 1]!)) buf += command[++i]!;
        continue;
      }
      flush();
      continue;
    }

    buf += ch;
  }

  if (quote !== null) tainted = true; // 引号不闭合
  flush();
  return out;
}

// ---------------------------------------------------------------- 归一化

export function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    if ((first === "'" || first === '"') && text.endsWith(first)) return text.slice(1, -1);
  }
  return text;
}

/** 赋值值里出现任何"可能执行别的东西"的字符 → 不当成惰性赋值 */
export function isSafeAssignmentValue(value: string): boolean {
  return !/[$`()|&<>\\;'"]/.test(unquote(value));
}

const ASSIGNMENT_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(\S*)/;

/**
 * 剥掉前置赋值（`VAR=value`，可带 `export`）与透明包装器。
 *
 * 这就是 rtk 问题的解：`export RTK_DB_PATH='…'; rtk ls -l` 的**第一段**是纯赋值 →
 * 惰性、不参与任何判定；第二段 `rtk ls -l` 剥掉包装器后就是 `ls -l`。
 */
export function normalizeSegment(
  raw: string,
  wrappers: readonly string[],
): { command: string; lazy: boolean; unsafe: boolean } {
  let text = raw.trim();

  for (;;) {
    const m = ASSIGNMENT_RE.exec(text);
    if (!m) break;
    if (!isSafeAssignmentValue(m[2] ?? "")) return { command: text, lazy: false, unsafe: true };
    text = text.slice(m[0].length).trim();
    if (text === "") return { command: "", lazy: true, unsafe: false };
  }

  for (let i = 0; i < 3; i++) {
    const token = /^\S+/.exec(text)?.[0];
    if (token === undefined || !wrappers.includes(token)) break;
    text = text.slice(token.length).trim();
  }

  if (text === "") return { command: "", lazy: true, unsafe: false };
  return { command: text, lazy: false, unsafe: false };
}

// ---------------------------------------------------------------- 分词

export function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  let buf = "";
  let started = false;
  let quoted = false;
  let quote: '"' | "'" | null = null;

  const flush = () => {
    if (started) tokens.push({ text: unquote(buf), quoted });
    buf = "";
    started = false;
    quoted = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;

    if (quote === "'") {
      buf += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      if (!started) {
        started = true;
        quoted = true;
      }
      buf += ch;
      if (i + 1 < segment.length) buf += segment[++i]!;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (!started) {
        started = true;
        quoted = true;
      }
      quote = quote === ch ? null : ch;
      buf += ch;
      continue;
    }
    if (/\s/.test(ch) && quote === null) {
      flush();
      continue;
    }
    if (!started) started = true;
    buf += ch;
  }
  flush();
  return tokens;
}

// ---------------------------------------------------------------- 模式匹配

/**
 * 配置模式 → 正则：`*` 匹配任意字符（含空格），其余字符一律转义，整串锚定。
 * 因为匹配对象是**单个段**，`*` 不会跨越命令边界，所以用户能写出
 * `git -C * status`、`npm --prefix * run test` 这种以前根本写不出来的模式。
 */
export function matchCommandPattern(pattern: string, text: string): boolean {
  const SENTINEL = "\u0000";
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? SENTINEL : `\\${ch}`));
  const body = escaped.split(SENTINEL).join("[\\s\\S]*");
  return new RegExp(`^${body}$`).test(text);
}

// ---------------------------------------------------------------- 硬拦

const ROOT_DIRS = new Set([
  "/", "/Users", "/home", "/System", "/Library", "/Applications",
  "/etc", "/usr", "/var", "/opt", "/private", "/bin", "/sbin", "/Volumes", "/tmp", "/dev",
]);

const DISKUTIL_WRITES = new Set([
  // 全部小写：比较时已 toLowerCase()
  "erase", "erasedisk", "erasevolume", "zerodisk", "partitiondisk", "reformat", "secureerase",
]);

const FORK_BOMB = /:\s*\(\s*\)\s*\{.*?:\s*\|\s*:\s*&\s*\}\s*;\s*:/;

export function isRootTarget(target: string): boolean {
  const s = unquote(target);
  if (s === "/" || s === "~" || s === "$HOME" || s === "${HOME}") return true;
  if (ROOT_DIRS.has(s)) return true;
  if (/^\/Users\/[^/]+$/.test(s) || /^\/home\/[^/]+$/.test(s)) return true; // 家目录根
  if (/^~\/[*.]?$/.test(s)) return true;
  return false;
}

/** 把变量引用折叠成 `$VAR`，再看是否"只剩一个变量/glob" —— 连基目录都看不出 */
export function isOpaqueTarget(target: string): boolean {
  const s = unquote(target)
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "$VAR")
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "$VAR");
  return s === "$VAR" || /^[*?[\]{}]+$/.test(s);
}

const PROTECTED_BRANCHES = new Set(["main", "master"]);

function normalizeRefspec(refspec: string): string {
  let s = refspec.replace(/^\+/, "");
  const colon = s.lastIndexOf(":");
  if (colon >= 0) s = s.slice(colon + 1);
  return s.replace(/^refs\/heads\//, "");
}

const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const GIT_GLOBAL_BARE = new Set([
  "--no-pager", "-p", "--paginate", "--no-replace-objects", "--bare",
  "--literal-pathspecs", "-P", "--no-literal-pathspecs", "--no-optional-locks",
]);

/**
 * 剥掉 git 的全局选项，让 `git -C <dir> status` 也能被识别成只读。
 * 用**表**而不是猜 —— 认不出来的选项会留在原位，导致判不出来（送 Jev）。
 */
export function stripGitGlobalOptions(tokens: readonly Token[]): Token[] {
  let i = 1;
  while (i < tokens.length) {
    const text = tokens[i]!.text;
    if (GIT_GLOBAL_BARE.has(text)) {
      i++;
      continue;
    }
    if (GIT_GLOBAL_WITH_VALUE.has(text)) {
      i += 2;
      continue;
    }
    if (/^(--git-dir|--work-tree|--namespace|--exec-path|-c)=/.test(text) || /^-C.+/.test(text)) {
      i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/**
 * 硬拦：**看整段的原始 argv**，命中即拦，不可配置放宽。
 *
 * 与上游的区别：用**引号感知的 argv** 判断选项，而不是在整条字符串上正则猜。
 * `rm -rf "$d/pi-warden.md"` 在这里是 argv `["rm","-rf","$d/pi-warden.md"]` ——
 * flag 是 `-rf`、目标是路径，不在系统根列表、也不是"完全看不出基目录"，所以**不硬拦**。
 */
const COMMAND_PREFIXES = new Set([
  "sudo", "doas", "command", "nohup", "nice", "time", "env", "stdbuf", "ionice", "setsid", "exec", "xcrun",
]);

/** 前缀自带的取值选项（`sudo -u root …` 里的 `-u root`） */
const PREFIX_FLAGS_WITH_VALUE = new Set([
  "-u", "-g", "-p", "-C", "-U", "-r", "-t", "-n", "--user", "--group", "--prompt", "--chdir", "--chroot",
]);

const ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * 找到"真正要执行的那个命令"在 argv 里的位置。
 *
 * 不做这一步，`sudo rm -rf /` / `env FOO=1 rm -rf /` 会绕过硬拦（token[0] 是 sudo / env，不是 rm）。
 * 上游拿整串正则反而盖住了这种情况 —— 按 argv 判断就不能退化。
 */
export function effectiveCommandIndex(tokens: readonly Token[]): number {
  let i = 0;
  for (let guard = 0; guard < 8 && i < tokens.length; guard++) {
    const token = tokens[i]!;
    if (!token.quoted && ASSIGNMENT_TOKEN.test(token.text)) {
      i++;
      continue;
    }
    if (token.quoted || !COMMAND_PREFIXES.has(token.text.toLowerCase())) break;
    i++;
    while (i < tokens.length) {
      const arg = tokens[i]!;
      if (!arg.quoted && ASSIGNMENT_TOKEN.test(arg.text)) {
        i++;
        continue;
      }
      if (!arg.quoted && arg.text.startsWith("-")) {
        i += PREFIX_FLAGS_WITH_VALUE.has(arg.text) ? 2 : 1;
        continue;
      }
      break;
    }
  }
  return Math.min(i, tokens.length);
}

export function hardDenySegment(raw: string): string | null {
  const tokens = tokenize(raw);
  if (tokens.length === 0) return null;
  const idx = effectiveCommandIndex(tokens);
  const cmd = (tokens[idx]?.text ?? "").toLowerCase();
  const rest = tokens.slice(idx + 1);

  if (cmd === "rm") {
    const recursive = rest.some((t) => !t.quoted && /^-[a-zA-Z]*[rR]/.test(t.text));
    if (recursive) {
      const targets = rest.filter((t) => t.quoted || !t.text.startsWith("-")).map((t) => t.text);
      for (const t of targets) {
        if (isRootTarget(t)) return `递归删除根目录：${t}`;
      }
      if (targets.length > 0 && targets.every((t) => isOpaqueTarget(t))) return "递归删除的目标无法静态确定";
    }
    return null;
  }

  if (cmd.startsWith("mkfs") || cmd.startsWith("wipefs")) return `格式化 / 擦签名：${cmd}`;
  if (cmd === "dd" && rest.some((t) => /^of=\/dev\//.test(t.text))) return "dd 写裸设备";
  if (cmd === "diskutil" && DISKUTIL_WRITES.has((rest[0]?.text ?? "").toLowerCase())) return "macOS 抹盘 / 分区";

  if (cmd === "git") {
    const afterGlobals = stripGitGlobalOptions(tokens.slice(idx));
    if (afterGlobals[0]?.text === "push") {
      const args = afterGlobals.slice(1);
      const forced = args.some(
        (t) => !t.quoted && ["-f", "--force", "--force-with-lease", "--force-if-includes"].includes(t.text),
      );
      const targets = args.filter((t) => !t.text.startsWith("-")).map((t) => t.text);
      if (forced && targets.some((t) => PROTECTED_BRANCHES.has(normalizeRefspec(t)))) return "强推保护分支";
    }
  }

  return null;
}

export function hardDenyReason(segments: readonly Segment[]): string | null {
  for (const seg of segments) {
    const reason = hardDenySegment(seg.raw);
    if (reason) return reason;
  }
  return null;
}

/**
 * 整条命令级别的硬拦。fork bomb 会被切段切碎（`:` `|` `&` `;` 都是分隔符），
 * 所以这一条必须在切段前看原文。
 */
export function hardDenyCommand(command: string, segments: readonly Segment[]): string | null {
  if (FORK_BOMB.test(command)) return "fork bomb";
  return hardDenyReason(segments);
}

// ---------------------------------------------------------------- 只读判定

const READ_ONLY_COMMANDS = new Set([
  "pwd", "cd", "ls", "tree", "cat", "bat", "head", "tail", "less", "more",
  "wc", "file", "stat", "realpath", "readlink", "basename", "dirname", "du", "df",
  "find", "grep", "rg", "ag", "jq", "diff", "cmp", "sort", "uniq", "cut", "column", "nl",
  "xxd", "od", "strings", "echo", "printf", "which", "whoami", "hostname", "uname",
  "date", "uptime", "id", "groups", "true", "false", ":",
]);

/** 拒绝：`awk`（可 system()/print>）、`sed`（-i 写文件）、`env`/`printenv`（能 dump 环境里的 key） */
const FIND_WRITE_FLAGS = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"];

/** 这些命令会把文件内容放进上下文 → 必须确认参数不是凭据文件 */
const CREDENTIAL_SENSITIVE = new Set(["cat", "bat", "head", "tail", "less", "more", "xxd", "od", "strings", "grep", "rg", "ag", "jq"]);

const VERSION_ONLY_FLAGS = new Set(["--version", "-v", "--help", "-h", "version"]);
const VERSION_ONLY_COMMANDS = new Set([
  "node", "npm", "pnpm", "npx", "python3", "python", "go", "cargo", "rustc",
  "git", "gh", "glab", "rtk", "tsc", "biome", "ruff", "uv", "deno", "bun",
  "java", "docker", "kubectl", "gcc", "clang", "make",
]);

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)secrets(\/|$)/,
  /(^|\/)\.pi\/agent\/(pi-typesafe|pi-jev-suite)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pgpass$/,
  /(^|\/)credentials(\.json)?$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)\.env$/,
  /(^|\/)\.env\.[A-Za-z0-9_-]+$/,
];

const ENV_TEMPLATE_EXEMPT = /\.env\.(example|sample|template|dist)\b/;

export function isCredentialPath(path: string): boolean {
  if (ENV_TEMPLATE_EXEMPT.test(path)) return false;
  return CREDENTIAL_PATTERNS.some((re) => re.test(unquote(path)));
}

const REDIRECT_RE = /(\d*)>>?\s*(&[0-9-]+|[^\s;&|<>]*)/g;

/** 写入文件的重定向 → 不是只读。返回原因，没有则返回 null */
export function writesToFile(segment: string): string | null {
  for (const m of segment.matchAll(REDIRECT_RE)) {
    const target = m[2] ?? "";
    if (target === "") return "重定向目标无法确定";
    if (/^&[0-9-]+$/.test(target)) continue; // 2>&1 / >&2
    if (target === "/dev/null") continue;
    return `重定向写入 ${target}`;
  }
  return null;
}

const READONLY_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "blame", "shortlog", "describe", "rev-parse", "rev-list",
  "ls-files", "ls-tree", "cat-file", "count-objects", "verify-pack", "whatchanged", "name-rev",
  "merge-base", "symbolic-ref", "var", "grep", "help", "--version", "version",
]);

/**
 * `ponytail:` 只收纯读取的 git 子命令。`branch` / `tag` / `remote` / `stash` / `worktree` /
 * `config` 既能列也能改，判"只带列举参数"要一层参数白名单 —— 本版直接把它们交给 Jev
 * （或用户自己写进 `gate.allow`）。上限：这些命令默认多花一次 Jev 调用。
 */
export function gitReadOnlyProblem(tokens: readonly Token[]): string | null {
  const rest = stripGitGlobalOptions(tokens);
  if (rest.length === 0) return "git 无子命令";
  const sub = rest[0]!.text;
  if (!READONLY_GIT_SUBCOMMANDS.has(sub)) return `git 子命令不在只读表：${sub}`;
  if (rest.slice(1).some((t) => t.text === "--output" || t.text.startsWith("--output="))) {
    return "git --output 会写文件";
  }
  return null;
}

/** 返回 null = 明显只读；返回字符串 = 为什么不能当只读 */
export function readOnlyProblem(segment: string): string | null {
  const redirect = writesToFile(segment);
  if (redirect) return redirect;

  const tokens = tokenize(segment);
  if (tokens.length === 0) return "空命令";
  const cmd = tokens[0]!.text;
  const args = tokens.slice(1).map((t) => t.text);

  if (cmd === "git") return gitReadOnlyProblem(tokens);

  if (!READ_ONLY_COMMANDS.has(cmd)) {
    const versionOnly = args.length > 0 && args.every((a) => VERSION_ONLY_FLAGS.has(a));
    if (VERSION_ONLY_COMMANDS.has(cmd) && versionOnly) return null;
    return `不在只读表：${cmd}`;
  }
  if (cmd === "find" && args.some((a) => FIND_WRITE_FLAGS.includes(a))) return "find 带写入 / 执行参数";
  if (CREDENTIAL_SENSITIVE.has(cmd)) {
    if (args.some((a) => a.includes("$"))) return "参数含未解析变量，无法确认是否读凭据文件";
    for (const a of args) {
      if (isCredentialPath(a)) return `读凭据文件：${a}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 流水线

export function decideBash(command: string, policy: BashPolicy): BashResult {
  const segments = splitChain(command);
  if (segments.length === 0) {
    return { decision: { kind: "allow", layer: "config", reason: "空命令" }, segments };
  }

  // 0. 硬拦（每段的原始文本）
  const denied = hardDenyCommand(command, segments);
  if (denied) return { decision: { kind: "deny", layer: "harddeny", reason: denied }, segments };

  // 归一化
  for (const seg of segments) {
    const norm = normalizeSegment(seg.raw, policy.transparentWrappers);
    seg.command = norm.command;
    seg.lazy = norm.lazy;
    if (norm.unsafe) seg.tainted = true;
  }

  const live = segments.filter((s) => !s.lazy);

  // 1a. deny（原始形态与归一化形态都匹配）
  for (const seg of segments) {
    for (const pattern of policy.deny) {
      if (
        matchCommandPattern(pattern, seg.raw) ||
        (seg.command !== "" && matchCommandPattern(pattern, seg.command))
      ) {
        return { decision: { kind: "deny", layer: "config", reason: `命中 deny：${pattern}` }, segments };
      }
    }
  }

  const covered = (seg: Segment): boolean => {
    if (seg.tainted || seg.command === "") return false;
    return policy.allow.some(
      (p) => matchCommandPattern(p, seg.raw) || matchCommandPattern(p, seg.command),
    );
  };

  const readOnly = (seg: Segment): boolean => {
    if (seg.tainted || seg.command === "") return false;
    if (policy.extraReadOnly.some((p) => matchCommandPattern(p, seg.command))) return true;
    return readOnlyProblem(seg.command) === null;
  };

  // 1b. 所有命令段都被 allow 覆盖 → 放行
  if (live.length > 0 && live.every(covered)) {
    return { decision: { kind: "allow", layer: "config", reason: "全部段命中 allow" }, segments };
  }

  // 2. 只读层：每段要么被 allow 覆盖、要么明显只读
  if (live.every((seg) => covered(seg) || readOnly(seg))) {
    return { decision: { kind: "allow", layer: "readonly", reason: "全部段只读或已白名单" }, segments };
  }

  // 3. Jev 层
  const reasons = live
    .filter((seg) => !covered(seg) && !readOnly(seg))
    .map((seg) => {
      if (seg.tainted) return `无法静态解析：${seg.raw.slice(0, 80)}`;
      return readOnlyProblem(seg.command) ?? `未放行：${seg.command.slice(0, 80)}`;
    });

  return {
    decision: { kind: "ask", layer: "jev", reason: reasons.join("；") || "未放行" },
    segments,
  };
}
