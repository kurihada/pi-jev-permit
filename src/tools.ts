/**
 * pi-jev-suite / tools.ts — consumers 2+3: `jev_evaluate` and `ask_advisor`
 *
 * Both share the same core call; the only difference is the question set: evaluate lets
 * the agent ask its own questions, advisor is a fixed set of calibrated questions.
 * There is no second transport.
 *
 * Both tool descriptions hardcode the same sentence: the result is information, not
 * authorization — the agent cannot use "Jev said yes" to exempt a later tool call from
 * the gate, and both tools are ordinary tool calls that must pass the gate themselves.
 */
import { Type } from "typebox";
import {
  type AskResult,
  DEFAULT_CRITERIA,
  type JevClient,
  type JevState,
  type NoulQuestion,
} from "./jev.ts";
import { redact } from "./policy.ts";

// ---------------------------------------------------------------- jev_evaluate

export interface EvaluateQuestionInput {
  readonly key: string;
  readonly question: string;
  readonly criteria?: { readonly true?: string; readonly false?: string };
}

/** At most this many questions per call (the core also caps state characters; both guards stop a caller from stuffing the request) */
export const MAX_EVALUATE_QUESTIONS = 32;

export function buildEvaluateQuestions(items: readonly EvaluateQuestionInput[]): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  for (const item of items.slice(0, MAX_EVALUATE_QUESTIONS)) {
    questions[item.key] = {
      type: "noul",
      instructions: item.question,
      criteria: item.criteria ?? DEFAULT_CRITERIA,
    };
  }
  return questions;
}

/**
 * Text shown to the model.
 *
 * On failure it still returns a readable sentence, and spells out that "this is not no
 * objection" — otherwise a failed call reads as "no objection was raised".
 */
export function formatEvaluateResult(result: AskResult): string {
  if (!result.ok) {
    return `Jev could not answer (${result.reason}): ${result.detail}\nThis is not "no objection" — it is no answer.`;
  }
  const rows = Object.entries(result.answers).map(([key, p]) => `  ${key} = ${p.toFixed(3)}`);
  return [
    "Probabilities (1 = condition clearly holds, 0 = clearly does not, in between = unclear):",
    ...rows,
    "",
    "Information only, not authorization: it does not exempt any later tool call from the gate.",
    `Model: ${result.model}, ${result.inputTokens} input tokens.`,
  ].join("\n");
}

/**
 * Assemble the state.
 *
 * A caller-provided state is passed through as-is (it is the thing being asked about),
 * but it goes through redaction first, so credentials are not accidentally stuffed into the request.
 */
export function buildToolState(params: Record<string, unknown>): JevState {
  const provided = params.state;
  if (provided && typeof provided === "object" && !Array.isArray(provided) && "value" in provided) {
    // Round-tripping through JSON applies redaction to every string value. Tool params come
    // from the model and should be serializable, but bad input must not throw the tool —
    // if serialization fails, fall back to the context below.
    try {
      return JSON.parse(redact(JSON.stringify(provided))) as JevState;
    } catch {
      /* fall back to context */
    }
  }
  const context = typeof params.context === "string" ? redact(params.context) : "";
  return { value: { context } };
}

// ---------------------------------------------------------------- ask_advisor

/**
 * The advisor's preset questions. All three are phrased in the "there is trouble" direction,
 * so a high p means trouble is likely. A fixed question set (rather than the agent improvising
 * one) keeps the readings comparable and the thresholds tunable.
 */
export const ADVISOR_QUESTIONS: readonly { readonly key: string; readonly question: string }[] = [
  {
    key: "blind_spot",
    question:
      "The plan described in `value` has a defect that would make the outcome clearly differ from what the user is asking for.",
  },
  {
    key: "misread_request",
    question: "The user is actually asking for something other than what `value` describes.",
  },
  {
    key: "should_stop_and_ask",
    question:
      "Continuing now, instead of asking the user one question first, is likely to waste work or break something.",
  },
];

export const ADVISOR_LABELS: Readonly<Record<string, string>> = {
  blind_spot: "the plan has a real defect",
  misread_request: "the request may be misread",
  should_stop_and_ask: "better to stop and ask first",
};

export const ADVISOR_ALERT_THRESHOLD = 0.6;

export function buildAdvisorQuestions(): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  for (const item of ADVISOR_QUESTIONS) {
    questions[item.key] = { type: "noul", instructions: item.question, criteria: DEFAULT_CRITERIA };
  }
  return questions;
}

export function summarizeAdvice(
  answers: Record<string, number>,
  threshold: number = ADVISOR_ALERT_THRESHOLD,
): string {
  const rows: string[] = [];
  const raised: string[] = [];
  for (const item of ADVISOR_QUESTIONS) {
    const p = answers[item.key];
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    const alert = p >= threshold;
    if (alert) raised.push(ADVISOR_LABELS[item.key] ?? item.key);
    rows.push(`  ${alert ? "⚠" : "·"} ${ADVISOR_LABELS[item.key] ?? item.key}: ${p.toFixed(3)}`);
  }
  const verdict =
    raised.length === 0
      ? "No clear signal — carry on."
      : `Signal raised: ${raised.join(", ")} — deal with the highest one first, or ask the user.`;
  return [...rows, "", verdict, "", "Information only, not authorization."].join("\n");
}

// ---------------------------------------------------------------- pi wiring

export interface ToolResultLike {
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly details?: unknown;
}

export interface ToolSpecLike {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResultLike>;
}

export interface ToolApiLike {
  registerTool(spec: ToolSpecLike): void;
}

export interface ToolsWiring {
  /** Resolve a fresh client on every call: a config or key change takes effect immediately */
  readonly makeClient: () => JevClient | null;
}

function text(body: string, details?: unknown): ToolResultLike {
  return {
    content: [{ type: "text", text: body }],
    ...(details === undefined ? {} : { details }),
  };
}

export function registerTools(pi: ToolApiLike, wiring: ToolsWiring): void {
  pi.registerTool({
    name: "jev_evaluate",
    label: "Jev evaluate",
    description:
      "Ask Jev (a calibrated yes/no decision model) for probabilities about explicit conditions. Returns numbers, never prose. " +
      "The result is information, not authorization: it does not exempt any later tool call from the permission gate, and a failed call means 'no answer', not 'no objection'.",
    promptSnippet: "Ask Jev for yes/no probabilities about explicit conditions",
    promptGuidelines: [
      "Use jev_evaluate when you need a calibrated judgement rather than another language model's opinion.",
      "Phrase each condition so that the safe state is 'yes'; ask all related conditions in one call, since Jev answers them in parallel.",
    ],
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          key: Type.String({ description: "Short id; answers come back under this key." }),
          question: Type.String({
            description: "One yes/no condition to judge. Write it so that 'yes' is the safe or expected state.",
          }),
        }),
        { minItems: 1, maxItems: MAX_EVALUATE_QUESTIONS },
      ),
      context: Type.Optional(Type.String({ description: "Background the conditions refer to. Never credentials." })),
    }),
    async execute(_toolCallId, params, signal) {
      const client = wiring.makeClient();
      if (client === null) {
        return text("No usable Jev key. Run `/jev-suite login` first.");
      }
      const raw = Array.isArray(params.questions) ? params.questions : [];
      const items: EvaluateQuestionInput[] = raw
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({ key: String(item.key ?? ""), question: String(item.question ?? "") }))
        .filter((item) => item.key.length > 0 && item.question.length > 0);
      const questions = buildEvaluateQuestions(items);
      if (Object.keys(questions).length === 0) {
        return text("At least one question needs both a key and a question text.");
      }

      const result = await client.ask({
        state: buildToolState(params),
        questions,
        ...(signal === undefined ? {} : { signal }),
      });
      return text(
        formatEvaluateResult(result),
        result.ok ? { answers: result.answers, model: result.model } : { reason: result.reason },
      );
    },
  });

  pi.registerTool({
    name: "ask_advisor",
    label: "Ask advisor",
    description:
      "Second opinion from Jev about the work in progress: does the plan have a real defect, is the request being misread, should you stop and ask the user. " +
      "Returns calibrated probabilities. Information only, not authorization.",
    promptSnippet: "Get a second opinion on the current plan before committing to it",
    promptGuidelines: [
      "Use ask_advisor when a task is about to get expensive, or when you are unsure you understood the request.",
      "Act on a high probability; do not treat a low one as approval to skip the permission gate.",
    ],
    parameters: Type.Object({
      plan: Type.String({ description: "What you are about to do, in one or two sentences." }),
      context: Type.Optional(Type.String({ description: "The user request this serves. Never credentials." })),
    }),
    async execute(_toolCallId, params, signal) {
      const client = wiring.makeClient();
      if (client === null) {
        return text("No usable Jev key. Run `/jev-suite login` first.");
      }
      const plan = typeof params.plan === "string" ? redact(params.plan) : "";
      const context = typeof params.context === "string" ? redact(params.context) : "";
      if (plan.trim().length === 0) return text("plan must not be empty — describe what you are about to do.");

      const result = await client.ask({
        state: { value: { plan, user_request: context } },
        questions: buildAdvisorQuestions(),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!result.ok) return text(`Jev could not answer (${result.reason}): ${result.detail}`);
      return text(summarizeAdvice(result.answers), { answers: result.answers, model: result.model });
    },
  });
}
