import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { AI_MAX_INPUT_WORDS } from "@/lib/ai-limits";
import { DAILY_AI_LIMIT } from "@/lib/ai-usage";
import { API_ERROR_CODES } from "@/lib/log";
import {
  HttpClient,
  createChapter,
  createProject,
  deleteProjectQuietly,
  expectFailure,
} from "./helpers";

/**
 * AI 接口：成功、各类失败、限流、额度。
 *
 * 这些用例打的是**假 AI 服务**（scripts/fake-ai-server.mjs），
 * 所以「上游 500」「上游返回空」「上游返回的不是 JSON」这些平时很难复现的情况，
 * 这里都能稳定测出来 —— 而且是免费的。
 *
 * ⚠️ 每个用例用独立账号，否则会被「每分钟 10 次」的限流互相干扰。
 */

/** 造一个专属账号，避免用例之间抢限流和额度 */
async function freshAccount(label: string) {
  const email = `p9-ai-${label}-${Date.now()}-${Math.floor(Math.random() * 1000)}@test.local`;
  const password = "p9-ai-account-123456";
  const client = new HttpClient();

  const registered = await client.post("/api/auth/register", {
    name: `九期AI${label}`,
    email,
    password,
  });

  if (registered.status !== 201) {
    throw new Error(`注册测试账号失败：${registered.status}`);
  }

  if (!(await client.login(email, password))) {
    throw new Error("测试账号登录失败");
  }

  const projectId = await createProject(client, `第九阶段AI-${label}`);
  const chapterId = await createChapter(client, projectId, "待处理章节");

  return { client, projectId, chapterId, email };
}

/** 一段普通正文（不含魔术词，所以假服务会正常回话） */
const PLAIN_TEXT = "雨停了。周砚站在窗前，看着楼下的水洼发呆。";

function aiEdit(
  client: HttpClient,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  return client.post("/api/ai/edit", body);
}

describe("测试环境自检", () => {
  it("连的必须是测试库，避免误写开发数据", () => {
    const url = process.env.DATABASE_URL || "";

    expect(
      url.includes("test"),
      `DATABASE_URL 指向的不是测试库（${url}），请用 npm run test:api 启动`
    ).toBe(true);
  });
});

describe("入参校验（不花钱的那几种失败）", () => {
  let ctx: Awaited<ReturnType<typeof freshAccount>>;

  beforeAll(async () => {
    ctx = await freshAccount("validate");
  });

  afterAll(async () => {
    await deleteProjectQuietly(ctx.client, ctx.projectId);
  });

  it("正文为空 → 400", async () => {
    expectFailure(
      await aiEdit(ctx.client, {
        projectId: ctx.projectId,
        chapterId: ctx.chapterId,
        content: "   ",
        mode: "polish",
      }),
      400,
      API_ERROR_CODES.validation
    );
  });

  it("正文超长 → 400（按去掉空白后的字数卡）", async () => {
    const response = await aiEdit(ctx.client, {
      projectId: ctx.projectId,
      chapterId: ctx.chapterId,
      content: "字".repeat(AI_MAX_INPUT_WORDS + 1),
      mode: "polish",
    });

    expectFailure(response, 400, API_ERROR_CODES.validation);
    expect(String(response.body.error)).toContain(String(AI_MAX_INPUT_WORDS));
  });

  it("mode 只能是 diagnose / polish，乱传 → 400", async () => {
    expectFailure(
      await aiEdit(ctx.client, {
        projectId: ctx.projectId,
        chapterId: ctx.chapterId,
        content: PLAIN_TEXT,
        mode: "随便写个模式",
      }),
      400
    );
  });

  it("请求体不是 JSON → 400 而不是 500", async () => {
    const response = await ctx.client.json("/api/ai/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{这不是JSON",
    });

    expect(response.status).toBe(400);
  });

  it("章节和作品对不上 → 404（防止拿别人的章节 id 配自己的作品 id）", async () => {
    const other = await freshAccount("mismatch");

    try {
      expectFailure(
        await aiEdit(ctx.client, {
          projectId: ctx.projectId,
          chapterId: other.chapterId,
          content: PLAIN_TEXT,
          mode: "diagnose",
        }),
        403,
        API_ERROR_CODES.access
      );
    } finally {
      await deleteProjectQuietly(other.client, other.projectId);
    }
  });

  it("改别人的章节跑 AI → 403", async () => {
    const stranger = await freshAccount("intruder");

    try {
      expectFailure(
        await aiEdit(stranger.client, {
          projectId: ctx.projectId,
          chapterId: ctx.chapterId,
          content: PLAIN_TEXT,
          mode: "diagnose",
        }),
        403,
        API_ERROR_CODES.access
      );
    } finally {
      await deleteProjectQuietly(stranger.client, stranger.projectId);
    }
  });
});

describe("诊断与润色（成功路径）", () => {
  let ctx: Awaited<ReturnType<typeof freshAccount>>;

  beforeAll(async () => {
    ctx = await freshAccount("success");
  });

  afterAll(async () => {
    await deleteProjectQuietly(ctx.client, ctx.projectId);
  });

  it("诊断返回结构化问题清单，并带回今天的额度", async () => {
    const response = await aiEdit(ctx.client, {
      projectId: ctx.projectId,
      chapterId: ctx.chapterId,
      content: PLAIN_TEXT,
      mode: "diagnose",
    });

    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("diagnose");

    const issues = response.body.issues as {
      severity: string;
      quote: string;
      suggestion: string;
    }[];

    expect(issues.length).toBeGreaterThan(0);
    // 每条问题都要有「依据 + 建议」，光说有问题不叫诊断
    for (const issue of issues) {
      expect(issue.quote.length).toBeGreaterThan(0);
      expect(issue.suggestion.length).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(issue.severity);
    }

    const usage = response.body.usage as { used: number; limit: number };

    expect(usage.used).toBeGreaterThanOrEqual(1);
    expect(usage.limit).toBe(DAILY_AI_LIMIT);
  });

  it("润色返回完整修改稿 + 修改说明", async () => {
    const response = await aiEdit(ctx.client, {
      projectId: ctx.projectId,
      chapterId: ctx.chapterId,
      content: PLAIN_TEXT,
      mode: "polish",
    });

    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("polish");
    // 假服务把原文回带 + 加标记，能证明「改的是这一章的内容」
    expect(String(response.body.revisedText)).toContain("雨停了");
    expect((response.body.changes as string[]).length).toBeGreaterThan(0);
  });

  it("额度查询接口的数字和实际调用次数对得上", async () => {
    const quota = await ctx.client.json<{ used: number; limit: number; remaining: number }>(
      "/api/ai/usage"
    );

    expect(quota.status).toBe(200);
    expect(quota.body.used).toBeGreaterThanOrEqual(2);
    expect(quota.body.used + quota.body.remaining).toBe(quota.body.limit);
  });
});

describe("上游异常", () => {
  let ctx: Awaited<ReturnType<typeof freshAccount>>;

  beforeAll(async () => {
    ctx = await freshAccount("upstream");
  });

  afterAll(async () => {
    await deleteProjectQuietly(ctx.client, ctx.projectId);
  });

  it("上游 500 → 502，且提示里不带上游原始报文", async () => {
    const response = await aiEdit(ctx.client, {
      projectId: ctx.projectId,
      chapterId: ctx.chapterId,
      content: `[[UPSTREAM_500]]${PLAIN_TEXT}`,
      mode: "polish",
    });

    expectFailure(response, 502, API_ERROR_CODES.ai);
    expect(String(response.body.error)).not.toContain("fake upstream exploded");
  });

  it("上游 401（Key 失效）→ 502，并且不把 Key 泄露给前台", async () => {
    const response = await aiEdit(ctx.client, {
      projectId: ctx.projectId,
      chapterId: ctx.chapterId,
      content: `[[UPSTREAM_401]]${PLAIN_TEXT}`,
      mode: "diagnose",
    });

    expectFailure(response, 502, API_ERROR_CODES.ai);

    const dumped = JSON.stringify(response.body);

    expect(dumped).not.toContain("fake");
    expect(dumped).not.toContain("Bearer");
  });

  it("上游返回空内容 → 502", async () => {
    expectFailure(
      await aiEdit(ctx.client, {
        projectId: ctx.projectId,
        chapterId: ctx.chapterId,
        content: `[[EMPTY]]${PLAIN_TEXT}`,
        mode: "diagnose",
      }),
      502,
      API_ERROR_CODES.ai
    );
  });

  it("上游返回一段不是 JSON 的话 → 502", async () => {
    expectFailure(
      await aiEdit(ctx.client, {
        projectId: ctx.projectId,
        chapterId: ctx.chapterId,
        content: `[[NOT_JSON]]${PLAIN_TEXT}`,
        mode: "polish",
      }),
      502,
      API_ERROR_CODES.ai
    );
  });

  it("失败的调用不写用量（只记成功的，否则额度会白扣）", async () => {
    const quota = await ctx.client.json<{ used: number }>("/api/ai/usage");

    expect(quota.body.used).toBe(0);
  });
});

describe("限流与额度", () => {
  it("一分钟内第 11 次被拒（429 + Retry-After）", async () => {
    const ctx = await freshAccount("ratelimit");

    try {
      const statuses: number[] = [];
      let limited: { status: number; body: Record<string, unknown> } | null = null;

      // 每分钟限 10 次，所以第 11 次必须是 429
      for (let i = 0; i < 11; i++) {
        const response = await aiEdit(ctx.client, {
          projectId: ctx.projectId,
          chapterId: ctx.chapterId,
          content: PLAIN_TEXT,
          mode: "diagnose",
        });

        statuses.push(response.status);

        if (response.status === 429) {
          limited = response;
          break;
        }
      }

      expect(statuses.filter((s) => s === 200).length).toBe(10);
      expect(limited).not.toBeNull();
      expect(limited!.body.code).toBe(API_ERROR_CODES.rateLimited);
      expect(limited!.body.retryAfter).toBeTypeOf("number");
    } finally {
      await deleteProjectQuietly(ctx.client, ctx.projectId);
    }

    return undefined;
  });

  it("今日额度用满 → 429，并说清是额度不是频率", async () => {
    const ctx = await freshAccount("quota");

    try {
      // 直接把用量刷满（模拟"这个人一整天慢慢用完了"）。
      // 走数据库而不是打 30 次接口：接口有每分钟限流，打不进去。
      const user = await prisma.user.findUnique({
        where: { email: ctx.email },
        select: { id: true },
      });

      expect(user, "测试账号应该能在库里查到").toBeTruthy();

      await prisma.aiUsage.createMany({
        data: Array.from({ length: DAILY_AI_LIMIT }, () => ({
          userId: user!.id,
          projectId: ctx.projectId,
          chapterId: ctx.chapterId,
          mode: "diagnose",
          model: "test-model",
          inputChars: 10,
          outputChars: 20,
        })),
      });

      const response = await aiEdit(ctx.client, {
        projectId: ctx.projectId,
        chapterId: ctx.chapterId,
        content: PLAIN_TEXT,
        mode: "diagnose",
      });

      expectFailure(response, 429, API_ERROR_CODES.quota);
      expect(response.body.limit).toBe(DAILY_AI_LIMIT);
      expect(response.body.used).toBeGreaterThanOrEqual(DAILY_AI_LIMIT);

      // 收尾：把这个账号的用量清掉，免得影响重复运行
      await prisma.aiUsage.deleteMany({ where: { userId: user!.id } });
    } finally {
      await deleteProjectQuietly(ctx.client, ctx.projectId);
    }

    return undefined;
  });
});
