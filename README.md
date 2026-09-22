# pi-jev-permit

The single place in pi where **Jev** (TypeSafe's System One decision model) is used: one core and one consumer — a permission gate that judges every `bash` / `write` / `edit` call before it runs.

Jev returns **numbers, not prose**: one probability per question, plus the model name and token counts.

Two earlier consumers, `jev_evaluate` and `ask_advisor`, were removed. They were thin wrappers over the same call, had never been invoked in live use, and cost a permanent entry in every prompt's tool list; asking Jev a question the agent could answer itself is not worth that.

## First run

1. **Install and restart.** `pi install npm:pi-jev-permit` — or `pi install /path/to/pi-jev-permit` when you are working on the source — then quit and relaunch pi: extensions load at startup and the command list is fixed for the session.
2. **Get a key.** The official route is the TypeSafe console: `console.typesafe.ai` → **API Keys**.
3. **Only if you bill a gateway or a router**, point the package at it *before* logging in, in `~/.pi/agent/pi-jev-permit.json`:

   ```json
   { "provider": { "preset": "gateway", "baseUrl": "https://your-gateway.example.com" } }
   ```

   Official TypeSafe users need no config at all; the default preset is `typesafe`.
4. **Log in.** `/jev-permit login` targets the protocol of the global provider; `/jev-permit login decisions` or `systemone` picks one explicitly. The key is verified against the endpoint the gate actually uses *before* it is stored, then written 0600 to `~/.pi/agent/secrets/pi-jev-permit-<protocol>-api-key`.
5. **Check it.** Run anything that is not read-only and read the line above the editor — it names the model the call was judged by. `/jev-permit stats` shows the same traffic afterwards.

With no key the package still works: read-only commands take the local fast path, and everything else is blocked with a message telling you to log in. That is deliberate — silence is never consent.

## How a call is judged

```text
0. hard deny      fixed list, raw argv, never reaches the model
1. your rules     gate.allow / gate.deny, matched per shell segment
2. read-only      every segment is known read-only -> local, zero network
3. Jev            one question: should this call be allowed?
```

Layer 0 is not configurable and is checked on the raw text before anything else. Layers 1 and 2 cost nothing (no network). Layer 3 asks exactly one question — **should this call be allowed to run** — and the considerations it weighs are **ranked**, not merely conjoined:

1. **Authorisation.** A direct, specific instruction in `latest_user_message` is decisive: the call is allowed even when it is otherwise risky or hard to undo — a user asking for a git history rewrite is authorisation, not a reason to refuse. Without such an instruction the call must still fit the work in `user_intent`, or be a routine step of it.
2. **Credentials.** A call that sends secrets anywhere, or reads a credential file into the conversation, is refused — and an instruction does **not** override it; only a human pausing the gate can.
3. **Irreversibility** — data outside its target, uncommitted work, repository history — weighs rather than vetoes: it lowers the probability for a call nobody asked for, and does not block one the user explicitly asked for.

Allowed when `p >= thresholds.allow` (default `0.6`). Everything else — including "unclear" and "no answer" — is blocked: **silence is never consent.** A block is not a dead end: `/jev-permit allow` grants one retry of one refused call, and it reaches exactly as far as the model's own refusals — never a hard deny, never a deny rule, never a credential.

The newest user message travels separately as `latest_user_message`, because the intent window alone is a conversation rather than an instruction. A blocked call then gets exactly one follow-up question — unauthorised, credential risk, or irreversible risk — so the block message names the reason instead of leaving three different next moves to guess from.

Three details matter more than they look:

- **Segments, not strings.** `cd /repo && npm test` is decomposed into segments and each is matched on its own, so an allow rule can actually express it (a whole-string matcher cannot: one `;` would disable every rule). Transparent wrappers (`rtk`) are stripped and a leading `VAR=value` assignment is treated as inert, so a wrapped read-only command still takes the fast path. Hard deny, by contrast, always looks at the raw text.
- **Redaction before anything leaves the machine.** Secrets in the command text (PEM blocks, JWTs, `sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `api_key=…`) become `<redacted>`. File contents, diffs and tool output are never sent; a write/edit contributes only its path.

## The widget above the input box

```text
jev-permit allow bash · ls -la /tmp        <- verdict + tool + the call being judged
  fast path · 0ms                          <- how it was decided (route/model · reading · latency)
jev-permit deny bash · npm publish
  typesafe/jev-1.13 · allow 0.04 · 792ms
  not clearly allowed (p=0.04 < 0.6)       <- only when blocked
```

The command text is redacted and truncated to 80 characters before it is displayed; a write/edit shows the path only. `records: "off"` silences the widget, `"full"` additionally appends one entry per decision to the transcript.

## Configuration

Global `~/.pi/agent/pi-jev-permit.json`, project `<cwd>/.pi/pi-jev-permit.json` (only for a trusted project). Changes take effect on the next judgment; `/jev-permit reload` re-reads and reports warnings.

```jsonc
{
  "provider": { "preset": "gateway", "baseUrl": "https://your-gateway.example.com", "timeoutMs": 4000, "maxRetries": 1 },
  "budget": { "requestsPerDay": 2000, "usdPerDay": 1.0 },
  "gate": {
    "records": "status",                 // status | full | off
    "allow": ["cd *", "git commit *"],   // matched per segment
    "deny": ["sudo *", "chmod 777 *"],
    "transparentWrappers": ["rtk"],
    "protectedPaths": ["/etc/", "~/.ssh/"]
  },
  "thresholds": { "allow": 0.6 },
  "onUnavailable": { "mode": "degraded", "breakerAfter": 3, "cooldownMs": 60000 }
}
```

Presets: `typesafe` (official `/v1/systemone`), `gateway` and `openrouter` (the decisions contract at `/api/alpha/decisions`). `gateway` ships **no endpoint** — a private gateway has no public address to put in a published package, so `baseUrl` is required next to it; `openrouter` carries its own. The two protocols differ only in URL, key verification and model id — the request and response bodies are the same JSON, so one parser serves both. `gate.provider` may override the global provider field by field, which is how the gate can bill a different account than the global default.

Invalid values are dropped with a warning rather than silently defaulted; a missing field keeps its default (absent is not the same as wrong).

## Commands

| command | what it does |
| --- | --- |
| `/jev-permit allow [id]` | opens a picker over the calls the model refused this session (falls back to the same list as text when the TUI has no picker); with an id it authorises **one retry** of that exact call — bound to the tool and the redacted command, valid 60 seconds, spent by the retry. **The agent is then told, so it retries by itself** — that notice carries a `customType`, which keeps it out of the gate's intent window and stops it from counting as a second authorisation. It cannot cover a hard deny (never listed) or a credential refusal (marked `pause only`) |
| `/jev-permit login [systemone\|decisions]` | verifies a key against the endpoint the gate actually uses, then stores it `0600` in that protocol's own slot |
| `/jev-permit pause [30m]` | allows everything until the deadline, then recovers by itself |
| `/jev-permit resume` | ends a pause |
| `/jev-permit stats` | usage, plus how the judged calls actually scored |
| `/jev-permit explain` | the last few decisions: command, layer, reason, readings |
| `/jev-permit reload` | re-reads the config and reports warnings |

## When Jev is unavailable

| state | layers 1–2 | layer 3 | widget |
| --- | --- | --- | --- |
| `ok` | normal | asks Jev | the last verdict |
| `degraded` | **still pass** | blocked, with the reason | `jev-permit DEGRADED` |
| `paused` | pass | pass | `jev-permit PAUSED 30m` |

After three consecutive failures the gate degrades: the model layer blocks, but the read-only fast path and your allow rules keep working, so a broken key or a dead endpoint does not stop ordinary work. A failed judgment is **never** treated as approval.

## When the model keeps refusing

One yes/no probability over a long, opaque command is where this class of model is weakest. On this machine's traffic, benign 300-character shell loops landed at `p 0.45–0.59` while a genuinely off-task `pkill` landed at `0.27–0.40`, so a run of false refusals in a turn is ordinary behaviour rather than a signal that the commands were wrong.

After **three refusals in a row, or ten of the last fifty reviews**, the circuit breaker trips for the rest of that turn: the remaining calls are not sent to the model at all and are allowed with layer `circuit breaker` in the widget. The numbers are Codex Auto-review's — the implementation this pattern comes from, and the one `@erichll/pi-auto-review` ports.

What a tripped breaker still enforces:

| still enforced | why |
| --- | --- |
| layer 0 hard deny | it is decided before anything reaches the model |
| your `gate.deny` rules | your policy, not the model's judgement |
| credentials and protected paths | otherwise "get refused twice, then read the key" would be a working attack |

The trip expires with the turn, not with the session: the turn key is the number of user messages in the branch, so the moment you say anything, judging resumes. Only the **model** layer counts toward it — a hard deny or one of your deny rules is your policy working, and a fast path never asks the model at all. `/jev-permit pause` remains the other lever, and the only one that covers a credential refusal.

## Design notes

The package replaces `pi-jev-auto-mode`, which judged the whole command string. Five measured problems drove the rewrite:

1. **Allow rules could not match a chain.** Any `;` or `&&` disabled every allow pattern, so `cd x && npm test` could never be allowlisted — that is why `rtk`'s `export RTK_DB_PATH=…; rtk …` wrapper broke the fast path entirely.
2. **One card per judgment** flooded the transcript (120+ in a day).
3. **Rules lived in code** — 33 dangerous patterns, 8 hard denies and the read-only table were constants.
4. **A dead Jev blocked everything**, including `ls`.
5. **`rm` was judged on the raw string**, so a filename containing `-r` tripped a hard deny.

Four problems only showed up in live use, each caught by an end-to-end run against the real endpoint rather than by a unit test:

1. **A threshold that could never fire.** `no_secret_egress` was set to `0.97`, whose reject line is `p <= 0.03` — a region the model never produces (reading a private key scored `0.10`). The rule was effectively dead and a credential read passed the gate.
2. **The intent window kept the oldest messages.** `intent_coverage` was truncated from the front, so in a long conversation the most recent authorisation was dropped and the gate blocked work the user had just approved.
3. **`rtk` translates verbs, not just prefixes**: `tail -2 f` becomes `rtk read f`. Stripping the wrapper left an unrecognised command name, so a purely read-only chain was sent to the model. Hard deny now looks through transparent wrappers too.
4. **`ctx.ui.setStatus` writes to the footer** and did not render at all here; `ctx.ui.setWidget` defaults to just above the editor, which is where the status belongs.

The single-question form of layer 3 followed from the same measurement: the model's per-condition readings for a compound decision are not separable by threshold tuning, so one number with one knob is easier to reason about and to calibrate from the log. It also set the ceiling — with nothing to decompose, a long command the model cannot reason through gets a hedge instead of an answer. That is what the circuit breaker above is for, and why "too many mundane calls are being reviewed" is answered by widening the local layers rather than by lowering the threshold (`p 0.45–0.50` holds both the benign and the genuinely destructive commands, so no threshold separates them).

## Development

```bash
node --test --experimental-strip-types test/chain.test.ts test/policy.test.ts test/config.test.ts \
  test/jev.test.ts test/gate.test.ts test/intent.test.ts test/rtk-compat.test.ts test/status.test.ts test/authorization.test.ts
node_modules/.bin/tsc --noEmit -p tsconfig.json
```

`src/policy.ts` is pure (no IO, no clock, no network) so the safety-sensitive predicates can be exercised without pi. `test/diagnose.ts` runs one command through the layers and prints what each segment resolved to; `test/e2e.ts` exercises the whole pipeline against the real endpoint with a stored key.
