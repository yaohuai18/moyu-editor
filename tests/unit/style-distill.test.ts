import { afterEach, describe, expect, it, vi } from "vitest";
import { AiError, runStyleDistill } from "@/lib/ai";

/**
 * 文风蒸馏（P1-2）。
 *
 * 这组测试守住三件事：
 *   1. 提示词里写明了「只依据样本、不编造」——这是产品底线；
 *   2. 模型输出脏一点（类型错、禁用词给成一串、重复项）也能被清洗成可用结果；
 *   3. 全空结果按「空响应」处理，不让用户白花一次额度还看到一张空草稿。
 */

function stubProvider(payload: unknown) {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(payload) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

function setEnv() {
  process.env.AI_API_KEY = "sk-test";
  process.env.AI_MODEL = "deepseek-chat";
}

describe("runStyleDistill", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL;
  });

  it("正常输出 → 五个字段可用，禁用词去重限长", async () => {
    setEnv();

    stubProvider({
      tone: " 冷峻克制 ",
      viewpoint: "第三人称限知",
      sentenceStyle: "短句为主，动作描写具体",
      forbiddenWords: ["不由得", "心中一震", " 不由得 ", "", "瞳孔骤缩"],
      summary: "语言克制。",
    });

    const result = await runStyleDistill({
      projectTitle: "测试书",
      samples: "第一章正文……",
    });

    expect(result.tone).toBe("冷峻克制");
    expect(result.viewpoint).toBe("第三人称限知");
    expect(result.sentenceStyle).toContain("短句");
    expect(result.forbiddenWords).toEqual(["不由得", "心中一震", "瞳孔骤缩"]);
    expect(result.summary).toBe("语言克制。");
  });

  it("禁用词给成顿号分隔的一串 → 拆开并去重", async () => {
    setEnv();

    stubProvider({
      tone: "轻快",
      forbiddenWords: "不由得、心中一震，瞳孔骤缩；不由得",
    });

    const result = await runStyleDistill({ samples: "正文" });

    expect(result.forbiddenWords).toEqual(["不由得", "心中一震", "瞳孔骤缩"]);
  });

  it("字段类型不对（数字/对象）→ 当没给，不抛错", async () => {
    setEnv();

    stubProvider({
      tone: 123,
      viewpoint: { wrong: true },
      sentenceStyle: null,
      forbiddenWords: 42,
      summary: ["数组"],
    });

    // 全空 → 视为空响应
    await expect(
      runStyleDistill({ samples: "正文" })
    ).rejects.toBeInstanceOf(AiError);

    vi.unstubAllGlobals();
    setEnv();

    // 部分可用 → 脏字段忽略，好字段保留
    stubProvider({ tone: "冷峻", viewpoint: 999 });

    const result = await runStyleDistill({ samples: "正文" });

    expect(result.tone).toBe("冷峻");
    expect(result.viewpoint).toBeUndefined();
  });

  it("五个字段全空 → 按空响应报错（用户不该白花额度）", async () => {
    setEnv();

    stubProvider({ tone: "", viewpoint: "", forbiddenWords: [], summary: "" });

    await expect(runStyleDistill({ samples: "正文" })).rejects.toMatchObject({
      code: "AI_EMPTY_RESPONSE",
    });
  });

  it("返回非 JSON → 格式错误", async () => {
    setEnv();

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "好的，我来分析这篇文风…" } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    await expect(runStyleDistill({ samples: "正文" })).rejects.toMatchObject({
      code: "AI_INVALID_FORMAT",
    });
  });

  it("没配密钥 → 直接 503 语义，不发请求", async () => {
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL;

    const fetchMock = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    await expect(runStyleDistill({ samples: "正文" })).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("提示词：写明只依据样本、不编造、禁用词数量范围", async () => {
    setEnv();

    const fetchMock = stubProvider({ tone: "冷峻" });

    await runStyleDistill({
      projectTitle: "测试书",
      genre: "都市",
      samples: "这是样本正文。",
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const sent = JSON.parse(init?.body as string);
    const systemPrompt = sent.messages.find(
      (m: { role: string }) => m.role === "system"
    ).content as string;
    const userPrompt = sent.messages.find(
      (m: { role: string }) => m.role === "user"
    ).content as string;

    expect(systemPrompt).toContain("只依据样本");
    expect(systemPrompt).toContain("不要编造");
    expect(systemPrompt).toContain("4-12 个");
    expect(userPrompt).toContain("这是样本正文。");
    expect(userPrompt).toContain("测试书");
  });
});
