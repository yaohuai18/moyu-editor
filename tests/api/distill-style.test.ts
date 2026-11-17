import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_ERROR_CODES } from "@/lib/log";
import {
  HttpClient,
  createChapter,
  createProject,
  deleteProjectQuietly,
  expectFailure,
} from "./helpers";

/**
 * 文风蒸馏接口（P1-2）。
 *
 * 走真实 HTTP + 假 AI（scripts/fake-ai-server.mjs 的文风分支），验证：
 *   - 成功路径返回草稿，禁用词已清洗去重；
 *   - 样本不足、越权、未登录都被挡住；
 *   - 设置接口能保存禁用词，且不传时不会清空（老客户端兼容）。
 *
 * ⚠️ 每个用例独立账号：蒸馏与诊断/润色共用每日额度与限流。
 */

/** 一段够 200 字的样本正文（蒸馏最少字数门槛） */
const SAMPLE_TEXT = [
  "雨停在傍晚。程野把窗推开一条缝，楼下水洼里的天光碎成几片。",
  "他没有回头，只把烟摁进窗台的旧瓷碟里，碟沿已经磕掉一块。",
  "“钥匙在门垫下面。”他说。声音很平，像在交代一件早就想好的事。",
  "林栀没有动。她盯着他右手虎口那道新疤，看了三秒，才弯腰去摸门垫。",
  "屋里安静得能听见水管里的水走动。她拿到钥匙，站起来，把伞留在门口。",
  "“伞你留着。”他说。她嗯了一声，推门出去，楼道声控灯亮了一下，又灭了。",
  "他站在原地听了很久，直到脚步声彻底散掉，才转身把窗关上。",
  "水洼里的天光暗下去，街对面的招牌一盏一盏亮起来。",
].join("\n");

async function freshAccount(label: string) {
  const email = `p12-distill-${label}-${Date.now()}-${Math.floor(Math.random() * 1000)}@test.local`;
  const password = "p12-distill-123456";
  const client = new HttpClient();

  const registered = await client.post("/api/auth/register", {
    name: `十二期蒸馏${label}`,
    email,
    password,
  });

  if (registered.status !== 201) {
    throw new Error(`注册测试账号失败：${registered.status}`);
  }

  if (!(await client.login(email, password))) {
    throw new Error("测试账号登录失败");
  }

  const projectId = await createProject(client, `十二期蒸馏-${label}`);
  const chapterId = await createChapter(client, projectId, "第一章");

  return { client, projectId, chapterId, email };
}

/** 把正文写进章节（蒸馏读的是库里的章节内容） */
async function seedChapter(
  client: HttpClient,
  chapterId: string,
  content: string
) {
  const saved = await client.patch(`/api/chapters/${chapterId}`, { content });

  expect(saved.status, `写入章节正文应 200，实际 ${saved.status}`).toBe(200);
}

describe("文风蒸馏接口", () => {
  let ctx: Awaited<ReturnType<typeof freshAccount>>;

  beforeAll(async () => {
    ctx = await freshAccount("main");
    await seedChapter(ctx.client, ctx.chapterId, SAMPLE_TEXT);
  });

  afterAll(async () => {
    await deleteProjectQuietly(ctx.client, ctx.projectId);
  });

  it("成功：返回风格草稿，禁用词已去重，样本信息可核对", async () => {
    const response = await ctx.client.post(
      `/api/projects/${ctx.projectId}/distill-style`
    );

    expect(response.status).toBe(200);

    expect(typeof response.body.tone).toBe("string");
    expect(typeof response.body.viewpoint).toBe("string");
    expect(typeof response.body.sentenceStyle).toBe("string");
    expect(response.body.summary).toBeTruthy();

    const words = response.body.forbiddenWords as string[];

    expect(Array.isArray(words)).toBe(true);
    expect(words.length).toBeGreaterThan(0);
    // 假上游故意给了一个重复的「不由得」，路由必须已经清洗掉
    expect(new Set(words).size).toBe(words.length);

    const sample = response.body.sample as {
      chapters: number;
      chars: number;
    };

    expect(sample.chapters).toBeGreaterThanOrEqual(1);
    expect(sample.chars).toBeGreaterThanOrEqual(200);

    const usage = response.body.usage as { used: number; remaining: number };

    expect(usage.used).toBeGreaterThanOrEqual(1);
  });

  it("章节正文太少 → 400，并说明还差多少", async () => {
    const thin = await freshAccount("thin");

    try {
      await seedChapter(thin.client, thin.chapterId, "只有一句话。");

      const response = await thin.client.post(
        `/api/projects/${thin.projectId}/distill-style`
      );

      expectFailure(response, 400, API_ERROR_CODES.validation);
      expect(String(response.body.error)).toContain("至少需要");
    } finally {
      await deleteProjectQuietly(thin.client, thin.projectId);
    }
  });

  it("没登录 → 401（额度不能白烧）", async () => {
    const anonymous = new HttpClient();

    const response = await anonymous.post(
      `/api/projects/${ctx.projectId}/distill-style`
    );

    expectFailure(response, 401, API_ERROR_CODES.auth);
  });

  it("别人的作品 → 403", async () => {
    const stranger = await freshAccount("intruder");

    try {
      const response = await stranger.client.post(
        `/api/projects/${ctx.projectId}/distill-style`
      );

      expectFailure(response, 403, API_ERROR_CODES.access);
    } finally {
      await deleteProjectQuietly(stranger.client, stranger.projectId);
    }
  });
});

describe("设置接口的禁用词写入（P1-2 配套）", () => {
  it("保存禁用词后能读回；不传该字段时保持原值", async () => {
    const account = await freshAccount("settings");

    try {
      const saved = await account.client.patch(
        `/api/projects/${account.projectId}/settings`,
        {
          title: "十二期蒸馏-settings",
          tone: "克制",
          viewpoint: "第三人称限知",
          sentenceStyle: "短句为主",
          forbiddenWords: "不由得、心中一震",
        }
      );

      expect(saved.status).toBe(200);

      const profile = saved.body.styleProfile as {
        forbiddenWords: string | null;
      };

      expect(profile.forbiddenWords).toBe("不由得、心中一震");

      // 老客户端 / 只改标题的请求：不带 forbiddenWords，不许把词表清空
      const resaved = await account.client.patch(
        `/api/projects/${account.projectId}/settings`,
        {
          title: "十二期蒸馏-改名",
          tone: "克制",
        }
      );

      expect(resaved.status).toBe(200);

      const profileAfter = resaved.body.styleProfile as {
        forbiddenWords: string | null;
      };

      expect(profileAfter.forbiddenWords).toBe("不由得、心中一震");
    } finally {
      await deleteProjectQuietly(account.client, account.projectId);
    }
  });
});
