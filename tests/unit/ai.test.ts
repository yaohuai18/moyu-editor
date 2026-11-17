import { afterEach, describe, expect, it, vi } from "vitest";
import { AiError, describeAiError, runAiEdit } from "@/lib/ai";
import {
  CLICHE_CHECKLIST,
  CLICHE_POLISH_RULES,
  DIAGNOSE_TYPE_NAMES,
} from "@/lib/ai-cliches";

/** 起一个假上游，返回诊断形状的合法 JSON（可传自定义载荷），并记录请求体 */
function stubDiagnoseProvider(payload?: unknown) {
  const content = payload ?? {
    issues: [
      {
        type: "模板化表达",
        quote: "这不仅是一个功能，更是一种全新的协作方式。",
        explanation: "假对比抬高语气，后半句没有新信息。",
        suggestion: "直接陈述功能本身。",
        severity: "medium",
      },
    ],
  };

  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(content),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

/** 起一个假上游，返回润色形状的合法 JSON，并记录请求体 */
function stubPolishProvider() {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  revisedText: "改好的正文。",
                  changes: ["删掉假对比"],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

function getSystemPrompt(fetchMock: ReturnType<typeof vi.fn>) {
  const [, init] = fetchMock.mock.calls[0] ?? [];

  expect(init?.body).toBeTruthy();

  const sent = JSON.parse(init?.body as string);

  return sent.messages.find((m: { role: string }) => m.role === "system")
    .content as string;
}

/**
 * AI 错误翻译。
 *
 * 用户看到的每一句 AI 报错都从这里出。要求：
 *   1. 状态码分得清「是我们没配好（503）」和「上游抽风（502）」；
 *   2. 提示语必须是中文、能看懂、**不含 API Key 或上游原始报文**；
 *   3. 不是 AI 的错误就返回 null，交给别的分支处理（别抢别人的活）。
 */
describe("describeAiError", () => {
  it("没配密钥 → 503，并且提示找管理员而不是让用户重试", () => {
    const result = describeAiError(new AiError("AI_NOT_CONFIGURED"));

    expect(result?.status).toBe(503);
    expect(result?.message).toContain("尚未配置");
  });

  it("上游返回错误 → 502，带上游状态码方便排查", () => {
    const result = describeAiError(
      new AiError("AI_PROVIDER_ERROR", { upstreamStatus: 401 })
    );

    expect(result?.status).toBe(502);
    expect(result?.message).toContain("401");
  });

  it("上游没给状态码时也要有一句能看懂的话", () => {
    const result = describeAiError(new AiError("AI_PROVIDER_ERROR"));

    expect(result?.status).toBe(502);
    expect(result?.message).toContain("稍后重试");
  });

  it("上游返回空内容 / 格式不对 → 502，提示重试", () => {
    expect(describeAiError(new AiError("AI_EMPTY_RESPONSE"))?.status).toBe(502);
    expect(describeAiError(new AiError("AI_INVALID_FORMAT"))?.status).toBe(502);
  });

  it("不是 AI 错误就返回 null（不越界接管别的异常）", () => {
    expect(describeAiError(new Error("随便一个错"))).toBeNull();
    expect(describeAiError("字符串")).toBeNull();
    expect(describeAiError(null)).toBeNull();
  });

  it("任何情况下都不把密钥带进提示语", () => {
    process.env.AI_API_KEY = "sk-must-never-appear";

    const messages = [
      describeAiError(new AiError("AI_NOT_CONFIGURED"))?.message,
      describeAiError(new AiError("AI_PROVIDER_ERROR", { upstreamStatus: 500 }))?.message,
      describeAiError(new AiError("AI_INVALID_FORMAT"))?.message,
    ].join(" ");

    expect(messages).not.toContain("sk-must-never-appear");

    delete process.env.AI_API_KEY;
  });
});

describe("runAiEdit 提示词组装", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL;
  });

  /** 起一个假上游：返回合法 JSON，并记录收到的请求体 */
  function stubProvider() {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    revisedText: "改好的正文。",
                    changes: ["说明一条"],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );

    vi.stubGlobal("fetch", fetchMock);

    return fetchMock;
  }

  it("风格档案里的禁用词会写进发给模型的提示词", async () => {
    process.env.AI_API_KEY = "sk-test";
    process.env.AI_MODEL = "deepseek-chat";

    const fetchMock = stubProvider();

    const result = await runAiEdit({
      content: "原文。",
      mode: "polish",
      projectTitle: "测试书",
      forbiddenWords: "不由得、心中一震",
    });

    expect(result.mode).toBe("polish");

    const [, init] = fetchMock.mock.calls[0] ?? [];

    expect(init?.body).toBeTruthy();

    const sent = JSON.parse(init?.body as string);
    const userPrompt = sent.messages.find(
      (m: { role: string }) => m.role === "user"
    ).content;

    expect(userPrompt).toContain("禁用词");
    expect(userPrompt).toContain("不由得、心中一震");
  });

  it("没填禁用词时，提示词里不出现禁用词段", async () => {
    process.env.AI_API_KEY = "sk-test";
    process.env.AI_MODEL = "deepseek-chat";

    const fetchMock = stubProvider();

    await runAiEdit({
      content: "原文。",
      mode: "polish",
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];

    expect(init?.body).toBeTruthy();

    const sent = JSON.parse(init?.body as string);
    const userPrompt = sent.messages.find(
      (m: { role: string }) => m.role === "user"
    ).content;

    expect(userPrompt).not.toContain("禁用词");
  });
});

/**
 * 模板化表达检查清单（P0）。
 *
 * 这组测试守住三件事：
 *   1. 清单真的进了提示词（诊断全量、润色精简），不是写了没人用；
 *   2. 清单本身不膨胀（< 700 字），防止 token 成本悄悄上涨；
 *   3. 对外口径不跑偏：不出现「检测」「绕过」等承诺性表述。
 */
describe("模板化表达检查清单", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL;
  });

  it("诊断提示词带全量清单与固定 type 命名", async () => {
    process.env.AI_API_KEY = "sk-test";
    process.env.AI_MODEL = "deepseek-chat";

    const fetchMock = stubDiagnoseProvider();

    const result = await runAiEdit({ content: "原文。", mode: "diagnose" });

    expect(result.mode).toBe("diagnose");

    const systemPrompt = getSystemPrompt(fetchMock);

    expect(systemPrompt).toContain("模板化表达检查清单");
    // 六组代表性关键词各点名一个，防清单被整体删掉或结构崩坏
    expect(systemPrompt).toContain("假对比");
    expect(systemPrompt).toContain("强凑三段式");
    expect(systemPrompt).toContain("赋能");
    expect(systemPrompt).toContain("套话收尾");
    expect(systemPrompt).toContain("层叠的「的」");
    // type 命名规范进提示词
    expect(systemPrompt).toContain(DIAGNOSE_TYPE_NAMES);
    // 判定边界必须在，防止模型拿关键词生搬硬套
    expect(systemPrompt).toContain("命中且空泛");
  });

  it("润色提示词带精简规则，且不塞全量清单", async () => {
    process.env.AI_API_KEY = "sk-test";
    process.env.AI_MODEL = "deepseek-chat";

    const fetchMock = stubPolishProvider();

    await runAiEdit({ content: "原文。", mode: "polish" });

    const systemPrompt = getSystemPrompt(fetchMock);

    expect(systemPrompt).toContain(CLICHE_POLISH_RULES);
    expect(systemPrompt).toContain("保持作者原有声音");
    // 精简版是「轻度润色」，不应把诊断用的整份检查清单塞进来
    expect(systemPrompt).not.toContain("模板化表达检查清单");
  });

  it("清单本身：非空、够用、不膨胀、无重复行", () => {
    expect(CLICHE_CHECKLIST.trim().length).toBeGreaterThan(200);
    expect(CLICHE_CHECKLIST.length).toBeLessThan(700);

    const lines = CLICHE_CHECKLIST.split("\n").filter((line) => line.trim());

    expect(lines.length).toBeGreaterThan(10);

    const unique = new Set(lines.map((line) => line.trim()));

    expect(unique.size).toBe(lines.length);

    expect(CLICHE_POLISH_RULES.trim().length).toBeGreaterThan(50);
    expect(CLICHE_POLISH_RULES.length).toBeLessThan(300);
  });

  it("合规口径：清单不出现承诺绕检测的表述", () => {
    const all = CLICHE_CHECKLIST + CLICHE_POLISH_RULES + DIAGNOSE_TYPE_NAMES;

    expect(all).not.toContain("绕过");
    expect(all).not.toContain("检测器");
    expect(all).not.toContain("AIGC");
  });
});

/**
 * 诊断评分（P1-1）。
 *
 * 这组测试的核心是**向后兼容**：多要一个 score 字段，
 * 绝不能让「老格式响应」或「模型手滑的脏分数」把整次诊断判死。
 *   - 带分 → 原样透出（取整、钳制）
 *   - 不带分 → score undefined，问题清单照常返回
 *   - 越界分 → 钳到 0/100，而不是抛 AI_INVALID_FORMAT
 */
describe("诊断评分", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL;
  });

  const baseIssue = {
    type: "模板化表达",
    quote: "这不仅是一个功能，更是一种全新的协作方式。",
    explanation: "假对比抬高语气。",
    suggestion: "直接陈述。",
    severity: "medium",
  };

  function run(payload: unknown) {
    process.env.AI_API_KEY = "sk-test";
    process.env.AI_MODEL = "deepseek-chat";

    stubDiagnoseProvider(payload);

    return runAiEdit({ content: "原文。", mode: "diagnose" });
  }

  it("带 score 与 summary → 原样透出，summary 去掉首尾空白", async () => {
    const result = await run({
      score: 45,
      summary: "  三处假对比，两处套话收尾。  ",
      issues: [baseIssue],
    });

    expect(result.mode).toBe("diagnose");

    if (result.mode !== "diagnose") throw new Error("unreachable");

    expect(result.score).toBe(45);
    expect(result.summary).toBe("三处假对比，两处套话收尾。");
    expect(result.issues).toHaveLength(1);
  });

  it("老格式（没有 score / summary）→ 照常返回，分数为空", async () => {
    const result = await run({ issues: [baseIssue] });

    if (result.mode !== "diagnose") throw new Error("unreachable");

    expect(result.score).toBeUndefined();
    expect(result.summary).toBeUndefined();
    expect(result.issues).toHaveLength(1);
  });

  it("分数越界 → 钳制到 0/100 并取整，不判格式错误", async () => {
    const high = await run({ score: 105.7, issues: [baseIssue] });

    if (high.mode !== "diagnose") throw new Error("unreachable");

    expect(high.score).toBe(100);

    vi.unstubAllGlobals();

    const low = await run({ score: -3, issues: [baseIssue] });

    if (low.mode !== "diagnose") throw new Error("unreachable");

    expect(low.score).toBe(0);
  });

  it("score 不是数字 / summary 是空白 → 当没给，不影响问题清单", async () => {
    const result = await run({
      score: "很高",
      summary: "   ",
      issues: [baseIssue],
    });

    if (result.mode !== "diagnose") throw new Error("unreachable");

    expect(result.score).toBeUndefined();
    expect(result.summary).toBeUndefined();
    expect(result.issues).toHaveLength(1);
  });

  it("诊断提示词里要了 score 与 summary，并说明分值方向", async () => {
    process.env.AI_API_KEY = "sk-test";
    process.env.AI_MODEL = "deepseek-chat";

    const fetchMock = stubDiagnoseProvider();

    await runAiEdit({ content: "原文。", mode: "diagnose" });

    const systemPrompt = getSystemPrompt(fetchMock);

    expect(systemPrompt).toContain('"score"');
    expect(systemPrompt).toContain('"summary"');
    expect(systemPrompt).toContain("模板化程度");
  });
});
