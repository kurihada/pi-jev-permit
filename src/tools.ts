/**
 * pi-jev-suite / tools.ts —— 消费方 2+3：`jev_evaluate` 与 `ask_advisor`
 *
 * 两者共用**同一个 core 调用**，区别只有问题集：evaluate 由 agent 自己出题，
 * advisor 是预设的一组校准问题。没有第二套传输。
 *
 * 两个工具的描述里都写死了同一句话：**返回值只是信息，不构成授权** ——
 * agent 不能拿"Jev 说可以"去让下一次工具调用免于门禁判定；而且这两个工具
 * 本身就是普通工具调用，自己也要过门禁。
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

/** 一次最多问这些个（core 还有 state 字符上限，两层一起挡调用方塞爆请求） */
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
 * 给模型看的文本。
 *
 * 失败时也要给一句能读懂的话，并且明确"这不是没问题" ——
 * 否则一个失败的调用会被读成"没有反对意见"。
 */
export function formatEvaluateResult(result: AskResult): string {
  if (!result.ok) {
    return `Jev 没能回答（${result.reason}）：${result.detail}\n这不是「没问题」，只是没有答案。`;
  }
  const rows = Object.entries(result.answers).map(([key, p]) => `  ${key} = ${p.toFixed(3)}`);
  return [
    "概率（1 = 条件明确成立，0 = 明确不成立，中间值 = 说不清）：",
    ...rows,
    "",
    "这只是信息，不构成任何授权：它不会让下一次工具调用免于门禁判定。",
    `模型：${result.model}，输入 ${result.inputTokens} token。`,
  ].join("\n");
}

/**
 * 组装状态。
 *
 * 调用方给的 state 原样透传（那是它自己要问的东西），但**先过一遍脱敏** ——
 * 免得把凭据顺手塞进请求里。
 */
export function buildToolState(params: Record<string, unknown>): JevState {
  const provided = params.state;
  if (provided && typeof provided === "object" && !Array.isArray(provided) && "value" in provided) {
    // 走一趟 JSON 是为了让脱敏作用到每个字符串值。工具参数来自模型，理论上都可序列化，
    // 但坏输入不能让工具抛出去 —— 序列化失败就用下面的 context 兜底。
    try {
      return JSON.parse(redact(JSON.stringify(provided))) as JevState;
    } catch {
      /* 落回 context */
    }
  }
  const context = typeof params.context === "string" ? redact(params.context) : "";
  return { value: { context } };
}

// ---------------------------------------------------------------- ask_advisor

/**
 * 顾问的预设问题。三个都是「有麻烦」方向的陈述，所以 **p 高 = 麻烦可能存在**。
 * 用一组固定问题而不是让 agent 临场编，是为了让读数可比、阈值能调。
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
  blind_spot: "方案有明显缺陷",
  misread_request: "可能理解错了需求",
  should_stop_and_ask: "应该先停下来问一句",
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
    rows.push(`  ${alert ? "⚠" : "·"} ${ADVISOR_LABELS[item.key] ?? item.key}：${p.toFixed(3)}`);
  }
  const verdict =
    raised.length === 0
      ? "没有明显信号，可以继续。"
      : `有信号：${raised.join("、")} —— 先处理掉概率最高的那条，或者直接问用户。`;
  return [...rows, "", verdict, "", "这只是信息，不构成授权。"].join("\n");
}

// ---------------------------------------------------------------- pi 接线

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
  /** 每次调用都重新取 client：配置或 key 变了立刻生效 */
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
        return text("没有可用的 Jev key。先在 pi 里跑 `/jev-suite login`。");
      }
      const raw = Array.isArray(params.questions) ? params.questions : [];
      const items: EvaluateQuestionInput[] = raw
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => ({ key: String(item.key ?? ""), question: String(item.question ?? "") }))
        .filter((item) => item.key.length > 0 && item.question.length > 0);
      const questions = buildEvaluateQuestions(items);
      if (Object.keys(questions).length === 0) {
        return text("至少要问一个带 key 与 question 的问题。");
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
        return text("没有可用的 Jev key。先在 pi 里跑 `/jev-suite login`。");
      }
      const plan = typeof params.plan === "string" ? redact(params.plan) : "";
      const context = typeof params.context === "string" ? redact(params.context) : "";
      if (plan.trim().length === 0) return text("plan 不能为空 —— 写清楚你准备做什么。");

      const result = await client.ask({
        state: { value: { plan, user_request: context } },
        questions: buildAdvisorQuestions(),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!result.ok) return text(`Jev 没能回答（${result.reason}）：${result.detail}`);
      return text(summarizeAdvice(result.answers), { answers: result.answers, model: result.model });
    },
  });
}
