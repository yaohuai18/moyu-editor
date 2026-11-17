import { z } from "zod";
import { countWords } from "@/lib/wordCount";
import { AI_MAX_INPUT_CHARS, AI_MAX_INPUT_WORDS } from "@/lib/ai-limits";
import {
  CLICHE_CHECKLIST,
  CLICHE_POLISH_RULES,
  DIAGNOSE_TYPE_NAMES,
} from "@/lib/ai-cliches";

/**
 * 兜底护栏：这个模块一旦被客户端组件 import，浏览器里会立刻炸。
 * 因为 API Key 只从 process.env 读（Next 也只会把 NEXT_PUBLIC_* 注入客户端），
 * 真被 import 了 Key 也拿不到，但那是「悄悄错」，不如直接报错。
 */
if (typeof window !== "undefined") {
  throw new Error(
    "src/lib/ai.ts 只能在服务端使用，请勿在任何 'use client' 组件里 import"
  );
}

/**
 * 统一的 AI 服务封装。
 *
 * 设计约束（改动前先读）：
 * 1. **只允许服务端 import**。API Key 只在这里读 `process.env.AI_API_KEY`，
 *    任何客户端组件（带 "use client" 的文件）都不许 import 本文件，
 *    否则 Key 会被打进浏览器 bundle。
 * 2. 所有对 AI 服务商的 HTTP 细节（地址、请求体、错误码、JSON 兜底）
 *    都收在本文件里。接口路由只负责鉴权、限流、校验和把结果转成响应。
 * 3. 返回的是**结构化结果**而不是一段裸文本：
 *    - diagnose → { mode, issues: [...] }，界面靠 severity/quote 渲染问题卡片
 *    - polish   → { mode, revisedText, changes }，界面靠它做修改稿对比
 *    如果哪天要换成非 OpenAI 兼容的服务商，只改 `callProvider` 一个函数。
 */

export type AiEditMode = "diagnose" | "polish";

export type AiEditInput = {
  content: string;
  mode: AiEditMode;
  projectTitle?: string | null;
  projectDescription?: string | null;
  genre?: string | null;
  tone?: string | null;
  viewpoint?: string | null;
  sentenceStyle?: string | null;
  /** 风格档案里的禁用词（如「不由得、心中一震」），会写进提示词让模型避开 */
  forbiddenWords?: string | null;
};

export type AiDiagnoseIssue = {
  type: string;
  quote: string;
  explanation: string;
  suggestion: string;
  severity: "low" | "medium" | "high";
};

export type AiDiagnoseResult = {
  mode: "diagnose";
  issues: AiDiagnoseIssue[];
  /**
   * 模板化程度评分（0-100，越低越自然）。
   *
   * 可选：模型没给分或给的不是数字时为 undefined，前端不显示分数条。
   * 越界值（比如模型手滑给 120）在 runAiEdit 里钳制到 [0,100] 并取整，
   * 不让一个越界数字把整次诊断判成格式错误。
   */
  score?: number;
  /** 一句话总评（可选，模型没给就不显示） */
  summary?: string;
};

export type AiPolishResult = {
  mode: "polish";
  revisedText: string;
  changes: string[];
};

export type AiEditResult = AiDiagnoseResult | AiPolishResult;

export { AI_MAX_INPUT_CHARS, AI_MAX_INPUT_WORDS };

/**
 * 按「字数」口径统计输入长度（去空白后的字符数），
 * 直接复用前端同款 `src/lib/wordCount.ts`，避免两边口径漂移。
 */
export { countWords };

// ===== 错误 =====

export type AiErrorCode =
  | "AI_NOT_CONFIGURED" // 服务端没配 Key / 模型
  | "AI_PROVIDER_ERROR" // 上游返回非 2xx
  | "AI_EMPTY_RESPONSE" // 上游返回空内容
  | "AI_INVALID_FORMAT"; // 上游返回的东西解析不出来 / 不符合约定结构

export class AiError extends Error {
  readonly code: AiErrorCode;
  /** 上游 HTTP 状态码，排查时有用 */
  readonly upstreamStatus?: number;

  constructor(code: AiErrorCode, options?: { upstreamStatus?: number }) {
    super(code);
    this.name = "AiError";
    this.code = code;
    this.upstreamStatus = options?.upstreamStatus;
  }
}

/**
 * 把 AiError 翻译成给用户看的 { status, message }。
 * 不是 AiError 就返回 null，交给调用方当作「未知错误」处理。
 *
 * 有这一层，路由里就不会再出现一堆 `error.message === "XXX"` 的字符串比较。
 */
export function describeAiError(
  error: unknown
): { status: number; message: string } | null {
  if (!(error instanceof AiError)) {
    return null;
  }

  switch (error.code) {
    case "AI_NOT_CONFIGURED":
      return { status: 503, message: "AI 服务尚未配置，请联系管理员检查服务端密钥" };
    case "AI_EMPTY_RESPONSE":
      return { status: 502, message: "AI 没有返回有效内容，请重试" };
    case "AI_INVALID_FORMAT":
      return { status: 502, message: "AI 返回格式无法解析，请重试" };
    case "AI_PROVIDER_ERROR":
    default:
      return {
        status: 502,
        message: error.upstreamStatus
          ? `AI 服务请求失败（${error.upstreamStatus}），请检查配置或稍后重试`
          : "AI 服务请求失败，请稍后重试",
      };
  }
}

// ===== 提示词 =====

/**
 * 把作品风格档案拼成提示词里的一段。
 * 没填的项直接不出现，避免塞一堆「未提供」把模型带偏。
 */
function buildStyleContext(input: AiEditInput) {
  const lines = [
    input.projectTitle && `作品：${input.projectTitle}`,
    input.projectDescription && `简介：${input.projectDescription}`,
    input.genre && `类型：${input.genre}`,
    input.tone && `语气：${input.tone}`,
    input.viewpoint && `叙事视角：${input.viewpoint}`,
    input.sentenceStyle && `句式风格：${input.sentenceStyle}`,
    input.forbiddenWords &&
      `禁用词（除非剧情必须，尽量不用）：${input.forbiddenWords}`,
  ].filter(Boolean);

  return lines.length ? lines.join("\n") : "（作者尚未填写作品信息）";
}

const BASE_RULES = `你是一名中文小说编辑助手。

编辑原则：
1. 尊重作者原意，不擅自改变剧情事实。
2. 不新增关键人物、事件或设定。
3. 不把文本改得过度工整或模板化。
4. 保留人物说话方式和叙事视角。
5. 优先处理明显问题，不进行无意义的大规模改写。
6. 不讨论或承诺绕过任何 AI 检测。
7. 输出必须严格符合要求的 JSON，不要输出 Markdown 代码块。`;

function buildSystemPrompt(mode: AiEditMode) {
  if (mode === "diagnose") {
    return `${BASE_RULES}

当前任务是诊断小说文本，指出叙事、节奏、人物、视角、语言和逻辑方面的问题。

重点检查：
- 空泛或重复表达
- 句式过于单一
- 情绪表达直接、缺少具体动作
- 对话缺少人物差异
- 叙事节奏突然变快或变慢
- 不必要的套话
- 逻辑衔接不清
- 模板化表达（按下面的清单逐条比对，命中且空泛才报告）

模板化表达检查清单（检查线索，不是词语黑名单；单次命中不等于问题，要回到上下文判断）：
${CLICHE_CHECKLIST}

只报告有实际帮助的问题，最多报告 8 项；叙事/人物/逻辑类问题与模板化表达类问题都要覆盖。
issue 的 type 从以下固定命名中选择：${DIAGNOSE_TYPE_NAMES}
返回格式：
{
  "score": 0 到 100 的整数，表示模板化程度（0=几乎无模板痕迹，100=通篇模板化；按清单命中的密度与严重度综合估算，不要与问题条数简单挂钩）,
  "summary": "一句话总评，不超过 40 字",
  "issues": [
    {
      "type": "问题类型",
      "quote": "原文中的短句或片段",
      "explanation": "问题说明",
      "suggestion": "修改方向",
      "severity": "low或medium或high"
    }
  ]
}`;
  }

  return `${BASE_RULES}

当前任务是在保留原意、人物关系、情节事实和叙事视角的前提下，对小说文本进行轻度润色。

要求：
- 尽量保留原文长度和段落结构。
- 只改善表达、节奏、动作细节和对话自然度。
- 不改变剧情、人物关系、叙事视角和时间顺序。
- 如果原文已经自然，不要强行修改。
- 返回完整修改稿，而不是片段。
- 最多总结 6 条主要修改。

${CLICHE_POLISH_RULES}

返回格式：
{
  "revisedText": "完整的修改稿",
  "changes": ["修改说明1", "修改说明2"]
}`;
}

function buildUserPrompt(input: AiEditInput) {
  return `作品信息：
${buildStyleContext(input)}

待处理文本：
---
${input.content}
---
`;
}

// ===== 上游调用 =====

const diagnosisSchema = z.object({
  /**
   * score / summary 都是 optional，且类型收 unknown —— 这是**有意的向后兼容**：
   * 老模型、老假上游、以及模型手滑把分数写成字符串（"45分"）时，
   * 都由 normalizeScore / 下面的类型判断兜底成「没给分」，
   * 绝不能因为一个可选字段的脏值把整次诊断判成格式错误（用户白花一次额度）。
   */
  score: z.unknown().optional(),
  summary: z.unknown().optional(),
  issues: z.array(
    z.object({
      type: z.string(),
      quote: z.string(),
      explanation: z.string(),
      suggestion: z.string(),
      severity: z.enum(["low", "medium", "high"]),
    })
  ),
});

const polishSchema = z.object({
  revisedText: z.string(),
  changes: z.array(z.string()),
});

/** DeepSeek 的 deepseek-chat 单次输出上限是 8192 token，超了会被直接拒掉 */
function resolveMaxTokens() {
  const fromEnv = Number(process.env.AI_MAX_TOKENS);
  const value = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 8000;

  return Math.min(Math.floor(value), 8192);
}

/** 剥掉模型爱加的 ```json 围栏，只留正文 */
function extractJson(text: string) {
  const trimmed = text.trim();

  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  return trimmed;
}

type ProviderResult = {
  ok: boolean;
  status: number;
  content: string | null;
};

async function callProvider(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  jsonMode: boolean;
}): Promise<ProviderResult> {
  const body: Record<string, unknown> = {
    model: options.model,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    messages: [
      { role: "system", content: options.systemPrompt },
      { role: "user", content: options.userPrompt },
    ],
  };

  if (options.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const response = await fetch(
    `${options.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;

  return {
    ok: response.ok,
    status: response.status,
    content: typeof content === "string" ? content : null,
  };
}

/**
 * 把模型给的评分钳到 [0,100] 并取整。
 *
 * 为什么不在 zod 里用 .min(0).max(100)：模型偶尔会手滑给 105 或 -1，
 * 严格校验会把「整次诊断」判成格式错误，用户白花一次额度却什么都没拿到。
 * 一个越界的分数是小事，钳一下就好；分数本身不可用（缺字段 / 非数字）时
 * 返回 undefined，界面不显示分数条。
 */
function normalizeScore(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.min(100, Math.max(0, Math.round(value)));
}

// ===== 对外入口 =====

/**
 * 跑一次 AI 编辑。失败一律抛 AiError，调用方用 describeAiError 转成响应。
 *
 * 注意：**输入长度在这里不再校验**，由接口层的 zod + 字数检查负责，
 * 因为那是「用户犯了错」(400)，不是「AI 服务出错」(5xx)。
 */
export async function runAiEdit(input: AiEditInput): Promise<AiEditResult> {
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;
  const baseUrl = process.env.AI_BASE_URL || "https://api.deepseek.com";

  if (!apiKey || !model) {
    throw new AiError("AI_NOT_CONFIGURED");
  }

  const callOptions = {
    baseUrl,
    apiKey,
    model,
    systemPrompt: buildSystemPrompt(input.mode),
    userPrompt: buildUserPrompt(input),
    temperature: input.mode === "diagnose" ? 0.2 : 0.65,
    maxTokens: resolveMaxTokens(),
  };

  // 首选 JSON 模式（模型被约束在 JSON 里，返回格式最稳）；
  // 万一服务商不支持这个参数，自动退回普通模式，靠 extractJson 兜底。
  let result = await callProvider({ ...callOptions, jsonMode: true });

  if (!result.ok && result.status === 400) {
    result = await callProvider({ ...callOptions, jsonMode: false });
  }

  if (!result.ok) {
    console.error("AI provider error:", result.status, result.content?.slice(0, 300));

    throw new AiError("AI_PROVIDER_ERROR", { upstreamStatus: result.status });
  }

  if (!result.content) {
    throw new AiError("AI_EMPTY_RESPONSE");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(extractJson(result.content));
  } catch {
    console.error("AI returned non-JSON content:", result.content.slice(0, 400));

    throw new AiError("AI_INVALID_FORMAT");
  }

  if (input.mode === "diagnose") {
    const diagnosis = diagnosisSchema.safeParse(parsed);

    if (!diagnosis.success) {
      console.error("AI diagnosis shape mismatch:", diagnosis.error.issues);

      throw new AiError("AI_INVALID_FORMAT");
    }

    /** 空字符串 / 纯空白 / 非字符串的 summary 当没给，避免界面出现空段落 */
    const summary =
      typeof diagnosis.data.summary === "string"
        ? diagnosis.data.summary.trim()
        : "";

    return {
      mode: "diagnose",
      issues: diagnosis.data.issues,
      score: normalizeScore(diagnosis.data.score),
      summary: summary || undefined,
    };
  }

  const polish = polishSchema.safeParse(parsed);

  if (!polish.success) {
    console.error("AI polish shape mismatch:", polish.error.issues);

    throw new AiError("AI_INVALID_FORMAT");
  }

  if (!polish.data.revisedText.trim()) {
    throw new AiError("AI_EMPTY_RESPONSE");
  }

  return {
    mode: "polish",
    revisedText: polish.data.revisedText,
    changes: polish.data.changes,
  };
}

// ===== 文风蒸馏（P1-2）=====

/**
 * 从作者已有章节里提炼「作品风格档案」草稿。
 *
 * 产品语义（改动前先读）：这一步只**建议**，绝不直接写库。
 * 蒸馏出来的东西是给作者过目的草稿，作者在设置页确认/修改后
 * 再走原有的保存接口 —— AI 不能悄悄改一个人的文风设定。
 */

export type StyleDistillInput = {
  projectTitle?: string | null;
  genre?: string | null;
  /** 已拼好的章节样本（含小标题）。取样与截断由调用方（路由层）负责 */
  samples: string;
};

export type StyleDistillResult = {
  /** 基调，如「冷峻克制」；样本不足时缺省 */
  tone?: string;
  /** 叙事视角，如「第三人称限知」 */
  viewpoint?: string;
  /** 句式风格描述 */
  sentenceStyle?: string;
  /** 从样本里抓到的、作者容易重复成口头禅的程式化表达（4-12 个） */
  forbiddenWords: string[];
  /** 一句话总评 */
  summary?: string;
};

const DISTILL_SYSTEM_PROMPT = `你是一名中文小说编辑，任务是从作者已有的章节样本中归纳「作品风格档案」。

只依据样本里反复出现的实际写法归纳。不要套用通用写作理论，不要编造样本中不存在的特征。
如果样本不足以判断某个维度，该字段返回空字符串，不要硬编。

分析维度：
1. tone：基调，2-12 字，如「冷峻克制」「市井幽默」
2. viewpoint：叙事视角，如「第三人称限知」「第一人称」
3. sentenceStyle：句式风格，不超过 50 字，写可执行的特征（句长节奏、常见句式、对话占比等）
4. forbiddenWords：从样本里找出作者容易重复成口头禅的程式化表达（如「不由得」「心中一震」「瞳孔骤缩」），4-12 个。
   只收样本中真实出现过的词句，不要凭空造；这是给作者的自查清单，用来提醒克制，不是判定标准
5. summary：一句话总评，不超过 50 字

输出必须严格符合要求的 JSON，不要输出 Markdown 代码块：
{
  "tone": "...",
  "viewpoint": "...",
  "sentenceStyle": "...",
  "forbiddenWords": ["...", "..."],
  "summary": "..."
}`;

function buildDistillUserPrompt(input: StyleDistillInput) {
  const meta = [
    input.projectTitle && `作品：${input.projectTitle}`,
    input.genre && `类型：${input.genre}`,
  ].filter(Boolean);

  return `${
    meta.length ? meta.join("\n") + "\n\n" : ""
  }以下是作者已发布的章节样本（可能经过截断）：
---
${input.samples}
---
`;
}

/** 只接受字符串，去空白、限长；空值返回 undefined */
function toStyleText(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

/**
 * 禁用词清洗：接受数组或分隔符字符串，去空去重、限 12 个、每个限 12 字。
 * 模型偶尔会给「不由得、心中一震」这种一串的写法，也一并兼容。
 */
function normalizeForbiddenWords(value: unknown) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[、,，;；\n]/)
      : [];

  const seen = new Set<string>();
  const words: string[] = [];

  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }

    const word = item.trim().slice(0, 12);

    if (!word || seen.has(word)) {
      continue;
    }

    seen.add(word);
    words.push(word);

    if (words.length >= 12) {
      break;
    }
  }

  return words;
}

const styleDistillSchema = z.object({
  /**
   * 与诊断的 score/summary 同一策略：字段全部收 unknown，
   * 由下面的归一化函数保证类型 —— 模型把数组写成字符串也不至于让整次蒸馏失败。
   */
  tone: z.unknown().optional(),
  viewpoint: z.unknown().optional(),
  sentenceStyle: z.unknown().optional(),
  forbiddenWords: z.unknown().optional(),
  summary: z.unknown().optional(),
});

/** 蒸馏输出上限：档案字段都是短文本，给多了纯属浪费 */
function resolveDistillMaxTokens() {
  const fromEnv = Number(process.env.AI_DISTILL_MAX_TOKENS);
  const value = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 1200;

  return Math.min(Math.floor(value), 4096);
}

export async function runStyleDistill(
  input: StyleDistillInput
): Promise<StyleDistillResult> {
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;
  const baseUrl = process.env.AI_BASE_URL || "https://api.deepseek.com";

  if (!apiKey || !model) {
    throw new AiError("AI_NOT_CONFIGURED");
  }

  const callOptions = {
    baseUrl,
    apiKey,
    model,
    systemPrompt: DISTILL_SYSTEM_PROMPT,
    userPrompt: buildDistillUserPrompt(input),
    // 比诊断略高一点：要在写法上做归纳，纯 0 温度容易只抓字面
    temperature: 0.3,
    maxTokens: resolveDistillMaxTokens(),
  };

  let result = await callProvider({ ...callOptions, jsonMode: true });

  if (!result.ok && result.status === 400) {
    result = await callProvider({ ...callOptions, jsonMode: false });
  }

  if (!result.ok) {
    console.error(
      "AI distill provider error:",
      result.status,
      result.content?.slice(0, 300)
    );

    throw new AiError("AI_PROVIDER_ERROR", { upstreamStatus: result.status });
  }

  if (!result.content) {
    throw new AiError("AI_EMPTY_RESPONSE");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(extractJson(result.content));
  } catch {
    console.error("AI distill returned non-JSON:", result.content.slice(0, 400));

    throw new AiError("AI_INVALID_FORMAT");
  }

  const parsedStyle = styleDistillSchema.safeParse(parsed);

  if (!parsedStyle.success) {
    console.error("AI distill shape mismatch:", parsedStyle.error.issues);

    throw new AiError("AI_INVALID_FORMAT");
  }

  const distilled: StyleDistillResult = {
    tone: toStyleText(parsedStyle.data.tone, 30),
    viewpoint: toStyleText(parsedStyle.data.viewpoint, 30),
    sentenceStyle: toStyleText(parsedStyle.data.sentenceStyle, 120),
    forbiddenWords: normalizeForbiddenWords(parsedStyle.data.forbiddenWords),
    summary: toStyleText(parsedStyle.data.summary, 120),
  };

  // 五个字段全空 = 模型什么也没归纳出来，等于白调一次，按空响应处理
  const hasContent =
    distilled.tone ||
    distilled.viewpoint ||
    distilled.sentenceStyle ||
    distilled.forbiddenWords.length > 0 ||
    distilled.summary;

  if (!hasContent) {
    throw new AiError("AI_EMPTY_RESPONSE");
  }

  return distilled;
}
