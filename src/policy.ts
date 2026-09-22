/**
 * pi-jev-permit / policy.ts
 *
 * Pure-function layer: split into segments -> hard deny -> config matching -> read-only check.
 * No IO, no network, no clock, no randomness -- it must run outside pi (`node --test`).
 *
 * Design principle (see PLAN.md §2):
 *   **Static analysis is only for allowing the obviously-safe. Anything uncertain goes to the Jev layer.**
 *
 * The fundamental difference from pi-jev-auto-mode: the unit of judgement is a **segment**
 * (the argv after splitting), not the whole command string. That is why allow/deny patterns are
 * no longer disabled by characters like `;` `&&` `|` `$`.
 */

// ---------------------------------------------------------------- Types

export interface Segment {
  /** Raw segment text (before normalization). */
  raw: string;
  /** Contains content that cannot be statically parsed (command substitution / backtick / heredoc / subshell / unterminated quote / unsafe assignment). */
  tainted: boolean;
  /** Normalized command: leading assignments and transparent wrappers stripped; empty for a pure-assignment segment. */
  command: string;
  /** Pure-assignment segment (inert, not treated as a command). */
  lazy: boolean;
}

export interface Token {
  /** Text with the outer quotes removed. */
  text: string;
  /** Whether the raw token started with a quote (a quoted token cannot be a command-line option). */
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

// ---------------------------------------------------------------- Splitting

const SHELL_SEPARATORS = new Set([";", "&", "|", "\n"]);

/**
 * Split on `;` `&&` `||` `|` `&` and newlines, respecting quotes and backslash escapes.
 *
 * `tainted` is one-way: rather than half-parse, a whole segment goes to Jev.
 * What sets taint: `$( )`, backticks, `<<` heredoc, an unquoted `(`/`)`, an unterminated quote.
 *
 * `ponytail:` this is a hand-written state machine, not a shell parser. Ceiling: heredoc /
 * eval / complex nesting are all tainted. Upgrade path: a real shell tokenizer (e.g. shell-quote).
 * Current policy: when uncertain, do not allow.
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
      // `2>&1` / `>&2` is a file-descriptor dup, not a command separator
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

  if (quote !== null) tainted = true; // unterminated quote
  flush();
  return out;
}

// ---------------------------------------------------------------- Normalization

export function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    if ((first === "'" || first === '"') && text.endsWith(first)) return text.slice(1, -1);
  }
  return text;
}

/** Any character in the value that "might run something else" -> not an inert assignment. */
export function isSafeAssignmentValue(value: string): boolean {
  return !/[$`()|&<>\\;'"]/.test(unquote(value));
}

const ASSIGNMENT_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(\S*)/;

/**
 * Strip leading assignments (`VAR=value`, optionally with `export`) and transparent wrappers.
 *
 * This is the rtk fix: in `export RTK_DB_PATH='...'; rtk ls -l` the **first** segment is a pure
 * assignment -> inert, judged by nothing; the second segment `rtk ls -l` becomes `ls -l` once
 * the wrapper is stripped.
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

// ---------------------------------------------------------------- Tokenizing

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

// ---------------------------------------------------------------- Pattern matching

/**
 * Config pattern -> regex: `*` matches any characters (spaces included), every other character
 * is escaped, the whole thing is anchored. Because matching is against a **single segment**, `*`
 * never crosses a command boundary, so users can write patterns like `git -C * status` or
 * `npm --prefix * run test` that were previously impossible.
 */
export function matchCommandPattern(pattern: string, text: string): boolean {
  const SENTINEL = "\u0000";
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? SENTINEL : `\\${ch}`));
  const body = escaped.split(SENTINEL).join("[\\s\\S]*");
  return new RegExp(`^${body}$`).test(text);
}

// ---------------------------------------------------------------- Hard deny

const ROOT_DIRS = new Set([
  "/", "/Users", "/home", "/System", "/Library", "/Applications",
  "/etc", "/usr", "/var", "/opt", "/private", "/bin", "/sbin", "/Volumes", "/tmp", "/dev",
]);

const DISKUTIL_WRITES = new Set([
  // all lowercase: the comparison already calls toLowerCase()
  "erase", "erasedisk", "erasevolume", "zerodisk", "partitiondisk", "reformat", "secureerase",
]);

const FORK_BOMB = /:\s*\(\s*\)\s*\{.*?:\s*\|\s*:\s*&\s*\}\s*;\s*:/;

export function isRootTarget(target: string): boolean {
  const s = unquote(target);
  if (s === "/" || s === "~" || s === "$HOME" || s === "${HOME}") return true;
  if (ROOT_DIRS.has(s)) return true;
  if (/^\/Users\/[^/]+$/.test(s) || /^\/home\/[^/]+$/.test(s)) return true; // a home directory root
  if (/^~\/[*.]?$/.test(s)) return true;
  return false;
}

/** Fold variable references into `$VAR`, then check whether "only a variable/glob remains" -- i.e. even the base directory is unknowable. */
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
 * Strip git's global options so `git -C <dir> status` is recognized as read-only too.
 * Uses a **table** rather than guessing -- an unrecognized option stays in place, which makes
 * the command not read-only (and thus sent to Jev).
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
 * Hard deny: inspects the **whole segment's raw argv**; a hit blocks and cannot be loosened by config.
 *
 * Difference from upstream: options are judged from a **quote-aware argv**, not guessed by regex
 * over the whole string. `rm -rf "$d/pi-warden.md"` is argv `["rm","-rf","$d/pi-warden.md"]` here --
 * the flag is `-rf`, the target is a path that is neither a system root nor "unknowable", so it
 * is **not** hard-denied.
 */
const COMMAND_PREFIXES = new Set([
  "sudo", "doas", "command", "nohup", "nice", "time", "env", "stdbuf", "ionice", "setsid", "exec", "xcrun",
]);

/** Options that take a value for these prefixes (the `-u root` in `sudo -u root …`). */
const PREFIX_FLAGS_WITH_VALUE = new Set([
  "-u", "-g", "-p", "-C", "-U", "-r", "-t", "-n", "--user", "--group", "--prompt", "--chdir", "--chroot",
]);

const ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Find the position of "the command that actually runs" in argv.
 *
 * Without this, `sudo rm -rf /` / `env FOO=1 rm -rf /` would bypass hard deny (token[0] is
 * sudo/env, not rm). Upstream's whole-string regex actually masked this case -- judging by argv
 * must not regress.
 */
export function effectiveCommandIndex(tokens: readonly Token[], wrappers: readonly string[] = []): number {
  let i = 0;
  for (let guard = 0; guard < 8 && i < tokens.length; guard++) {
    const token = tokens[i]!;
    if (!token.quoted && ASSIGNMENT_TOKEN.test(token.text)) {
      i++;
      continue;
    }
    // transparent wrappers are skipped like command prefixes: otherwise `rtk rm -rf /` hides rm from hard deny
    if (token.quoted || !(COMMAND_PREFIXES.has(token.text.toLowerCase()) || wrappers.includes(token.text))) {
      break;
    }
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

export function hardDenySegment(raw: string, wrappers: readonly string[] = []): string | null {
  const tokens = tokenize(raw);
  if (tokens.length === 0) return null;
  const idx = effectiveCommandIndex(tokens, wrappers);
  const cmd = (tokens[idx]?.text ?? "").toLowerCase();
  const rest = tokens.slice(idx + 1);

  if (cmd === "rm") {
    const recursive = rest.some((t) => !t.quoted && /^-[a-zA-Z]*[rR]/.test(t.text));
    if (recursive) {
      const targets = rest.filter((t) => t.quoted || !t.text.startsWith("-")).map((t) => t.text);
      for (const t of targets) {
        if (isRootTarget(t)) return `recursive delete of a root directory: ${t}`;
      }
      if (targets.length > 0 && targets.every((t) => isOpaqueTarget(t))) {
        return "recursive delete target cannot be statically determined";
      }
    }
    return null;
  }

  if (cmd.startsWith("mkfs") || cmd.startsWith("wipefs")) return `formatting / wiping signature: ${cmd}`;
  if (cmd === "dd" && rest.some((t) => /^of=\/dev\//.test(t.text))) return "dd writes to a raw device";
  if (cmd === "diskutil" && DISKUTIL_WRITES.has((rest[0]?.text ?? "").toLowerCase())) return "macOS disk erase / partition";

  if (cmd === "git") {
    const afterGlobals = stripGitGlobalOptions(tokens.slice(idx));
    if (afterGlobals[0]?.text === "push") {
      const args = afterGlobals.slice(1);
      const forced = args.some(
        (t) => !t.quoted && ["-f", "--force", "--force-with-lease", "--force-if-includes"].includes(t.text),
      );
      const targets = args.filter((t) => !t.text.startsWith("-")).map((t) => t.text);
      if (forced && targets.some((t) => PROTECTED_BRANCHES.has(normalizeRefspec(t)))) return "force push to a protected branch";
    }
  }

  return null;
}

export function hardDenyReason(segments: readonly Segment[], wrappers: readonly string[] = []): string | null {
  for (const seg of segments) {
    const reason = hardDenySegment(seg.raw, wrappers);
    if (reason) return reason;
  }
  return null;
}

/**
 * Whole-command hard deny. A fork bomb is shredded by splitting (`:` `|` `&` `;` are all
 * separators), so this one must look at the raw text before splitting.
 */
export function hardDenyCommand(
  command: string,
  segments: readonly Segment[],
  wrappers: readonly string[] = [],
): string | null {
  if (FORK_BOMB.test(command)) return "fork bomb";
  return hardDenyReason(segments, wrappers);
}

// ---------------------------------------------------------------- Read-only check

const READ_ONLY_COMMANDS = new Set([
  "pwd", "cd", "ls", "tree", "cat", "bat", "head", "tail", "less", "more",
  // `read` is a shell builtin (reads stdin into a variable, no side effects) and also the name
  // pi-rtk-optimizer uses for `tail`: rtk does not just add a prefix, it translates the verb
  // (tail -> `rtk read`) -- stripping only the wrapper leaves a command name we never wrote.
  "read",
  "wc", "file", "stat", "realpath", "readlink", "basename", "dirname", "du", "df",
  "find", "grep", "rg", "ag", "jq", "diff", "cmp", "sort", "uniq", "cut", "column", "nl",
  "xxd", "od", "strings", "echo", "printf", "which", "whoami", "hostname", "uname",
  "date", "uptime", "id", "groups", "true", "false", ":",
]);

/** Deliberately excluded: `awk` (can system()/print>), `sed` (-i writes files), `env`/`printenv` (can dump keys from the environment). */
const FIND_WRITE_FLAGS = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"];

/** These commands put file contents into context -> their arguments must not be credential files. */
const CREDENTIAL_SENSITIVE = new Set(["cat", "bat", "head", "tail", "less", "more", "read", "xxd", "od", "strings", "grep", "rg", "ag", "jq"]);

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

/**
 * The reasons the read-only layer emits when a call may put a credential into context.
 *
 * Exported as constants because the circuit breaker has to recognise this class *before* Jev is
 * asked: the breaker covers ordinary work and never credentials. Matching these strings by hand
 * in a second file is how the two copies drift apart, so they live here and are used below.
 */
export const CREDENTIAL_READ_REASON_PREFIX = "reads a credential file:";
export const CREDENTIAL_UNRESOLVED_REASON =
  "argument contains an unresolved variable, cannot confirm it does not read a credential file";

export const CREDENTIAL_REASON_MARKERS: readonly string[] = [
  CREDENTIAL_READ_REASON_PREFIX,
  CREDENTIAL_UNRESOLVED_REASON,
];

/**
 * True for the reasons the circuit breaker is never allowed to cover: credential access and
 * protected paths.
 *
 * A tripped breaker stops sending calls to Jev. These still go to it, because "the model was
 * wrong about the last three calls" says nothing about a secret, and a breaker that swallowed
 * credential checks would be a way to reach a key by being denied twice first.
 */
export function isUnbreakableReason(reason: string): boolean {
  if (reason.startsWith("protected") || reason.startsWith("matched a configured protectedPath")) {
    return true;
  }
  return CREDENTIAL_REASON_MARKERS.some((marker) => reason.includes(marker));
}

/**
 * Does any token of this command name a credential file, whatever the command is?
 *
 * The read-only layer only checks the **readers** it knows (`cat`, `grep`, ...), which is the right
 * question for "is this safe to run without asking". The circuit breaker needs the wider one —
 * could this touch a secret at all — because it is about to stop consulting the model for the rest
 * of the turn, and `rm ~/.ssh/id_rsa` reaches no reader at all while being exactly that.
 */
export function mentionsCredentialPath(command: string): boolean {
  return splitChain(command).some((segment) =>
    tokenize(segment.raw).some((token) => isCredentialPath(token.text)),
  );
}

const REDIRECT_RE = /(\d*)>>?\s*(&[0-9-]+|[^\s;&|<>]*)/g;

/** A redirect that writes a file -> not read-only. Returns the reason, or null. */
export function writesToFile(segment: string): string | null {
  for (const m of segment.matchAll(REDIRECT_RE)) {
    const target = m[2] ?? "";
    if (target === "") return "redirect target cannot be determined";
    if (/^&[0-9-]+$/.test(target)) continue; // 2>&1 / >&2
    if (target === "/dev/null") continue;
    return `redirect writes to ${target}`;
  }
  return null;
}

/** How many of a command's segments redirect into a file. */
export function redirectCount(command: string): number {
  return splitChain(command).filter((segment) => writesToFile(segment.raw) !== null).length;
}

const NETWORK_HEADS =
  /\b(curl|wget|nc|ncat|netcat|ssh|scp|sftp|telnet|rclone|aws|gcloud|gsutil|kubectl|gh|heroku|vercel|fly|flyctl|ngrok|doctl)\b/;
const NETWORK_GIT = /\bgit\s+(push|fetch|clone|pull|remote|ls-remote|submodule)\b/;
const NETWORK_PKG =
  /\b(npm|pnpm|yarn|bun|pip|pip3|uv|poetry|cargo|go|docker|brew)\s+(publish|install|add|ci|i|dlx|exec|download|get|mod|push|pull|login|upgrade|tap|x)\b/;

/**
 * Does this command talk to another machine?
 *
 * Only a hint: it is counted into the history the judgement sees ("this session reached the network
 * twice") and it decides nothing on its own, so a miss costs a hint rather than an allowance. That is
 * why it may be a plain regex — a file named `/tmp/aws.txt` counting as egress is harmless where it
 * would not be if anything were gated on it.
 */
export function touchesNetwork(command: string): boolean {
  return NETWORK_HEADS.test(command) || NETWORK_GIT.test(command) || NETWORK_PKG.test(command);
}

const READONLY_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "blame", "shortlog", "describe", "rev-parse", "rev-list",
  "ls-files", "ls-tree", "cat-file", "count-objects", "verify-pack", "whatchanged", "name-rev",
  "merge-base", "symbolic-ref", "var", "grep", "help", "--version", "version",
]);

/**
 * `ponytail:` only purely read-only git subcommands. `branch` / `tag` / `remote` / `stash` /
 * `worktree` / `config` can both list and mutate, and judging "only listing flags" would need a
 * per-flag whitelist -- this version just sends them to Jev (or the user lists them in
 * `gate.allow`). Ceiling: these commands cost one extra Jev call each by default.
 */
export function gitReadOnlyProblem(tokens: readonly Token[]): string | null {
  const rest = stripGitGlobalOptions(tokens);
  if (rest.length === 0) return "git has no subcommand";
  const sub = rest[0]!.text;
  if (!READONLY_GIT_SUBCOMMANDS.has(sub)) return `git subcommand not in the read-only list: ${sub}`;
  if (rest.slice(1).some((t) => t.text === "--output" || t.text.startsWith("--output="))) {
    return "git --output writes a file";
  }
  return null;
}

/** Returns null = obviously read-only; returns a string = why it cannot be treated as read-only. */
export function readOnlyProblem(segment: string): string | null {
  const redirect = writesToFile(segment);
  if (redirect) return redirect;

  const tokens = tokenize(segment);
  if (tokens.length === 0) return "empty command";
  const cmd = tokens[0]!.text;
  const args = tokens.slice(1).map((t) => t.text);

  if (cmd === "git") return gitReadOnlyProblem(tokens);

  if (!READ_ONLY_COMMANDS.has(cmd)) {
    const versionOnly = args.length > 0 && args.every((a) => VERSION_ONLY_FLAGS.has(a));
    if (VERSION_ONLY_COMMANDS.has(cmd) && versionOnly) return null;
    return `not in the read-only list: ${cmd}`;
  }
  if (cmd === "find" && args.some((a) => FIND_WRITE_FLAGS.includes(a))) return "find with a write / execute flag";
  if (CREDENTIAL_SENSITIVE.has(cmd)) {
    if (args.some((a) => a.includes("$"))) {
      return CREDENTIAL_UNRESOLVED_REASON;
    }
    for (const a of args) {
      if (isCredentialPath(a)) return `${CREDENTIAL_READ_REASON_PREFIX} ${a}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- Pipeline

export function decideBash(command: string, policy: BashPolicy): BashResult {
  const segments = splitChain(command);
  if (segments.length === 0) {
    return { decision: { kind: "allow", layer: "config", reason: "empty command" }, segments };
  }

  // 0. Hard deny (on each segment's raw text)
  const denied = hardDenyCommand(command, segments, policy.transparentWrappers);
  if (denied) return { decision: { kind: "deny", layer: "harddeny", reason: denied }, segments };

  // Normalize
  for (const seg of segments) {
    const norm = normalizeSegment(seg.raw, policy.transparentWrappers);
    seg.command = norm.command;
    seg.lazy = norm.lazy;
    if (norm.unsafe) seg.tainted = true;
  }

  const live = segments.filter((s) => !s.lazy);

  // 1a. deny (matches against both the raw and the normalized form)
  for (const seg of segments) {
    for (const pattern of policy.deny) {
      if (
        matchCommandPattern(pattern, seg.raw) ||
        (seg.command !== "" && matchCommandPattern(pattern, seg.command))
      ) {
        return { decision: { kind: "deny", layer: "config", reason: `matched deny: ${pattern}` }, segments };
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

  // 1b. every command segment covered by allow -> allow
  if (live.length > 0 && live.every(covered)) {
    return { decision: { kind: "allow", layer: "config", reason: "all segments matched allow" }, segments };
  }

  // 2. Read-only layer: every segment is either covered by allow or obviously read-only
  if (live.every((seg) => covered(seg) || readOnly(seg))) {
    return {
      decision: { kind: "allow", layer: "readonly", reason: "all segments are read-only or allowlisted" },
      segments,
    };
  }

  // 3. Jev layer
  const reasons = live
    .filter((seg) => !covered(seg) && !readOnly(seg))
    .map((seg) => {
      if (seg.tainted) return `cannot statically parse: ${seg.raw.slice(0, 80)}`;
      return readOnlyProblem(seg.command) ?? `not cleared: ${seg.command.slice(0, 80)}`;
    });

  return {
    decision: { kind: "ask", layer: "jev", reason: reasons.join("; ") || "not cleared" },
    segments,
  };
}

// ---------------------------------------------------------------- Protected paths

/**
 * Directory segments: a hit on any segment of the path protects it.
 *
 * Two kinds live here: things whose modification changes "what the agent was told"
 * (.git/.pi/.claude/AGENTS.md), and things that hold credentials (.ssh/.aws/.gnupg/.npmrc...).
 */
export const PROTECTED_DIRECTORY_SEGMENTS: readonly string[] = [
  ".git", ".ssh", ".aws", ".gnupg", ".husky", ".pi", ".claude", ".codex", ".kube", ".docker",
];

export const PROTECTED_PATH_FRAGMENTS: readonly string[] = [
  "/.github/workflows/", "/.config/gh/", "/.config/gcloud/", "/.docker/config.json",
];

export const PROTECTED_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env$/,
  /^\.env\.[A-Za-z0-9_-]+$/,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^\.pgpass$/,
  /^\.mcp\.json$/,
  /^credentials(\.json)?$/,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|key|p12|pfx)$/,
  /^\.?(bashrc|zshrc|bash_profile|profile|zprofile)$/,
  /^AGENTS\.md$/i,
  /^CLAUDE\.md$/i,
];

const PROTECTED_ENV_TEMPLATE_EXEMPT = /^\.env\.(example|sample|template|dist)$/;

/** This package's own config and log: **always writable** (otherwise we re-live the "can't even edit our own config" trap). */
export function isExemptPath(absolutePath: string, exempt: readonly string[]): boolean {
  const normalized = absolutePath.replace(/\/+/g, "/");
  return exempt.some((prefix) => {
    const clean = prefix.replace(/\/+$/, "");
    return clean.length > 0 && normalized.startsWith(clean);
  });
}

/**
 * Returns null = not a protected path.
 *
 * `extra` holds additional patterns from config (substring or glob both work).
 * `exempt` holds absolute-path prefixes that are **always allowed** -- this package's own config
 * and log must stay writable, otherwise we re-live the "can't edit our own config" trap (a real
 * problem measured in the old design).
 */
export function protectedPathReason(
  absolutePath: string,
  extra: readonly string[] = [],
  exempt: readonly string[] = [],
): string | null {
  const normalized = absolutePath.replace(/\/+/g, "/");
  if (isExemptPath(normalized, exempt)) return null;

  const segments = normalized.split("/").filter(Boolean);
  const segment = segments.find((part) => PROTECTED_DIRECTORY_SEGMENTS.includes(part.toLowerCase()));
  if (segment !== undefined) return `protected directory segment: ${segment}`;

  const lowered = normalized.toLowerCase();
  const fragment = PROTECTED_PATH_FRAGMENTS.find((part) => lowered.includes(part));
  if (fragment !== undefined) return `protected path: ${fragment}`;

  const base = segments[segments.length - 1] ?? "";
  if (!PROTECTED_ENV_TEMPLATE_EXEMPT.test(base)) {
    const pattern = PROTECTED_FILE_PATTERNS.find((re) => re.test(base));
    if (pattern !== undefined) return `protected file: ${base}`;
  }

  for (const pattern of extra) {
    if (pattern.length === 0) continue;
    if (normalized.includes(pattern) || matchCommandPattern(pattern, normalized)) {
      return `matched a configured protectedPath: ${pattern}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- Redaction

/**
 * Scrub credentials before anything is sent out.
 *
 * This is a **safety net, not a guarantee** -- an unknown credential format will pass through,
 * so it only lowers risk; it is not a reason to "send anything freely".
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(sk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bapikey_[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/g,
  /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret)\s*[=:]\s*["']?[^\s"',)]{8,}/gi,
];

export const REDACTED = "<redacted>";

export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}
