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
3. repeat         the same command was already judged and allowed this turn
4. Jev            three questions, and a table decides
```

Layer 0 is not configurable and is checked on the raw text before anything else. Layers 1 to 3 cost nothing — no network, no request.

### Layer 4 asks three questions, not one

Splitting them is the design. A single "should this be allowed" probability has to average *how dangerous* together with *how authorised*, and the measured result on this machine's own traffic was **100 refusals out of 125 commands** under a clearly authorising instruction — 44 of them landing between 0.40 and 0.59, which is a model saying "I cannot tell" rather than answering.

| question | asks |
| --- | --- |
| `q_critical` | would it expose a credential, or destroy something that exists nowhere else? |
| `q_risk` | would it cause damage that is costly to undo, move data off the machine, interrupt something that is running, or change far more than the object it names? |
| `q_auth` | do the user's own words ask for this call, or for the work it is a step of? |

The table, in `combine()`: `q_critical` at or above `thresholds.allow` blocks on its own; `q_risk` blocks only when `q_auth` is below `thresholds.authorization` (default `allow - 0.2`); everything else passes. Both hazard questions carry the calibration rules that keep ordinary work out of them — a long, unfamiliar or partially-shown command is not evidence of risk by itself, a path outside the working directory is not a reason, and a deletion counts as bounded only when its target can be **seen** to be narrow.

A response missing any of the three is a block: **an unanswered question is never consent.** Credentials stay un-overridable by an instruction — only a human pausing the gate reaches that class.

A block is not a dead end: `/jev-permit allow` grants one retry of one refused call, and it reaches exactly as far as the model's own refusals — never a hard deny, never a deny rule, never a credential.

The newest user message travels separately as `latest_user_message`, because the intent window alone is a conversation rather than an instruction. A blocked call then gets exactly one follow-up question — unauthorised, credential risk, or irreversible risk — so the block message names the reason instead of leaving three different next moves to guess from.

## What is judged

| surface | tools | how |
| --- | --- | --- |
| command | `bash`, `bash_bg`, `monitor` | the command pipeline above |
| write | `write`, `edit` | by the path they touch |
| read | `read`, `grep`, `find`, … | allowed, no record — there is no decision in a read |
| **uncovered** | anything else | allowed, and the tool's **name** is recorded once per session and shown once |

That last row is the important one. Pi's `tool_call` event fires for **every** tool an extension or an MCP server registers, so "a tool I did not think of" needs an answer rather than a hole. It used to be a three-name whitelist, and `bash_bg` — which runs a shell command — ran through it unjudged *and* unrecorded. The default is `record` deliberately: the first step with an unknown tool is to find out that it exists.

- **Segments, not strings.** `cd /repo && npm test` is decomposed into segments and each is matched on its own, so an allow rule can actually express it (a whole-string matcher cannot: one `;` would disable every rule). Transparent wrappers (`rtk`) are stripped and a leading `VAR=value` assignment is treated as inert, so a wrapped read-only command still takes the fast path. Hard deny, by contrast, always looks at the raw text.
- **Redaction before anything leaves the machine.** Secrets in the command text (PEM blocks, JWTs, `sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `api_key=…`) become `<redacted>`. File contents, diffs and tool output are never sent; a write/edit contributes only its path.
- **The history, and what a repeat is.** An *identical* command that the model already allowed in the same turn skips it (N=2), because repeating an answer is not a new question. It is the one deliberately fail-open layer, so it is narrow on purpose: identical command only, model allows only, same turn only, cleared by a refusal, and never a credential or protected path. Counts of what has already happened also travel to Jev as evidence — never as authorisation.

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
| `/jev-permit shadow [30m]` | judges everything, enforces the model's refusals never, and records what it would have refused — see [Shadow mode](#shadow-mode) |
| `/jev-permit enforce` | ends a shadow window early |
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

## Shadow mode

`/jev-permit shadow [30m]` keeps judging **every** call and stops enforcing the model's refusals. What it is for is the answer to a question a static policy cannot answer: *what would this refuse on real traffic right now?* — collected while nothing is interrupted, and on the real sequences rather than on a sampled command list.

Vercel ships the same idea in `@ai-sdk/policy-opa`, with the reason stated plainly: **"Do not ship a new policy straight to enforce. The first version almost always denies things you did not mean to."** Their rollout is write the rules, run them shadowed, look at only the `denied` events, fix, then enforce.

What a window covers, and what it does not:

| | pause | shadow |
| --- | --- | --- |
| asks the model | no | **yes** |
| produces a verdict | no | **yes** — readings, model and latency all recorded |
| enforces layer 4's refusals | no | **no** |
| enforces layer 0, your deny rules, `unavailable` | **no** | **yes** |
| enforces the breaker | **no** | **no** — see below |
| cost | nothing | the normal one judgement per call |

A credential refusal is never shadowed: that is the class an instruction may not override, and a window is not an instruction. Nothing is recorded as authorisable either, because nothing was refused — a shadow refusal is a line in the log, not an entry in `/jev-permit allow`.

**The breaker is suspended for the duration of a window**, and nothing is counted towards it. A window exists to keep the model being asked while its answers are watched, and a tripped breaker is the one state that stops that — so three shadowed refusals, which is precisely the kind of run a window is opened to look at, would otherwise blind it. For the same reason entering a window clears a trip that was already active, and leaves no count behind for the moment it ends: a window is for observing, not for accumulating.

The window ends by itself for the same reason the pause does: something that ends by itself cannot be forgotten.

One limit worth stating: shadow is **one-sided**. It shows false refusals, which is what makes ordinary work stop. It cannot show a call that should have been blocked and was not, because it never blocks — that question is what `test/replay.ts` is for.

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
