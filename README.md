# pi-jev-suite

The single place in pi where **Jev** (TypeSafe's System One decision model) is used. One core, three consumers:

| consumer | what it does |
| --- | --- |
| **gate** | judges every `bash` / `write` / `edit` call before it runs |
| **`jev_evaluate`** | lets the agent ask Jev for calibrated yes/no probabilities |
| **`ask_advisor`** | a second opinion on the work in progress |

Jev returns **numbers, not prose**: one probability per question, plus the model name and token counts.

## How a call is judged

```text
0. hard deny      fixed list, raw argv, never reaches the model
1. your rules     gate.allow / gate.deny, matched per shell segment
2. read-only      every segment is known read-only -> local, zero network
3. Jev            one question: should this call be allowed?
```

Layer 0 is not configurable and is checked on the raw text before anything else. Layers 1 and 2 cost nothing (no network). Layer 3 asks exactly one question — **should this call be allowed to run** — and the model is told that all three of these must hold:

1. it is part of what the user is working on, or a routine step of work they already set in motion;
2. it sends nothing secret or credential-bearing anywhere, and does not read a credential file into the conversation;
3. it cannot destroy something that is hard or impossible to undo.

Allowed when `p >= thresholds.allow` (default `0.6`). Everything else — including "unclear" and "no answer" — is blocked: **silence is never consent.**

Two details matter more than they look:

- **Segments, not strings.** `cd /repo && npm test` is decomposed into segments and each is matched on its own, so an allow rule can actually express it (a whole-string matcher cannot: one `;` would disable every rule). Transparent wrappers (`rtk`) are stripped and a leading `VAR=value` assignment is treated as inert, so a wrapped read-only command still takes the fast path. Hard deny, by contrast, always looks at the raw text.
- **Redaction before anything leaves the machine.** Secrets in the command text (PEM blocks, JWTs, `sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `api_key=…`) become `<redacted>`. File contents, diffs and tool output are never sent; a write/edit contributes only its path.

## The widget above the input box

```text
jev-suite allow bash · ls -la /tmp        <- verdict + tool + the call being judged
  fast path · 0ms                          <- how it was decided (route/model · reading · latency)
jev-suite deny bash · npm publish
  typesafe/jev-1.13 · allow 0.04 · 792ms
  not clearly allowed (p=0.04 < 0.6)       <- only when blocked
```

The command text is redacted and truncated to 80 characters before it is displayed; a write/edit shows the path only. `records: "off"` silences the widget, `"full"` additionally appends one entry per decision to the transcript.

## Configuration

Global `~/.pi/agent/pi-jev-suite.json`, project `<cwd>/.pi/pi-jev-suite.json` (only for a trusted project). Changes take effect on the next judgment; `/jev-suite reload` re-reads and reports warnings.

```jsonc
{
  "provider": { "preset": "gateway", "timeoutMs": 4000, "maxRetries": 1 },
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

Presets: `typesafe` (official `/v1/systemone`), `gateway` and `openrouter` (the decisions contract at `/api/alpha/decisions`). The two protocols differ only in URL, key verification and model id — the request and response bodies are the same JSON, so one parser serves both. A **consumer** may override the provider (`gate.provider`, `tools.provider`), which is how the gate can bill one account and the tools another.

Invalid values are dropped with a warning rather than silently defaulted; a missing field keeps its default (absent is not the same as wrong).

## Commands

| command | what it does |
| --- | --- |
| `/jev-suite login [systemone\|decisions]` | verifies a key against the endpoint the gate actually uses, then stores it `0600` in that protocol's own slot |
| `/jev-suite pause [30m]` | allows everything until the deadline, then recovers by itself |
| `/jev-suite resume` | ends a pause |
| `/jev-suite stats` | usage plus, per condition, how often it was satisfied / rejected / unclear |
| `/jev-suite explain` | the last few decisions: command, layer, reason, readings |
| `/jev-suite reload` | re-reads the config and reports warnings |

## When Jev is unavailable

| state | layers 1–2 | layer 3 | widget |
| --- | --- | --- | --- |
| `ok` | normal | asks Jev | the last verdict |
| `degraded` | **still pass** | blocked, with the reason | `jev-suite DEGRADED` |
| `paused` | pass | pass | `jev-suite PAUSED 30m` |

After three consecutive failures the gate degrades: the model layer blocks, but the read-only fast path and your allow rules keep working, so a broken key or a dead endpoint does not stop ordinary work. A failed judgment is **never** treated as approval.

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

The single-question form of layer 3 followed from the same measurement: the model's per-condition readings for a compound decision are not separable by threshold tuning, so one number with one knob is easier to reason about and to calibrate from the log.

## Development

```bash
node --test --experimental-strip-types test/chain.test.ts test/policy.test.ts test/config.test.ts \
  test/jev.test.ts test/gate.test.ts test/tools.test.ts test/intent.test.ts test/rtk-compat.test.ts test/status.test.ts
node_modules/.bin/tsc --noEmit -p tsconfig.json
```

`src/policy.ts` is pure (no IO, no clock, no network) so the safety-sensitive predicates can be exercised without pi. `test/diagnose.ts` runs one command through the layers and prints what each segment resolved to; `test/e2e.ts` exercises the whole pipeline against the real endpoint with a stored key.
