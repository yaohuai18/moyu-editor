import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_ERROR_CODES } from "@/lib/log";
import {
  HttpClient,
  createProject,
  deleteProjectQuietly,
  ensureAccount,
  expectFailure,
} from "./helpers";

/**
 * 作品：增删改查 + 越权。
 *
 * 「越权」这部分是本文件里最重要的：作品详情接口如果只判断了登录、
 * 没判断归属，那么任何人把 URL 里的 id 换一换就能读到别人的小说。
 * 这类漏洞在功能测试里是「全绿」的 —— 必须专门测。
 */
const OWNER = {
  name: "九期作者甲",
  email: "p9-owner-a@test.local",
  password: "p9-owner-a-123456",
};

const INTRUDER = {
  name: "九期作者乙",
  email: "p9-owner-b@test.local",
  password: "p9-owner-b-123456",
};

let owner: HttpClient;
let intruder: HttpClient;
const created: string[] = [];

beforeAll(async () => {
  owner = await ensureAccount(OWNER);
  intruder = await ensureAccount(INTRUDER);
});

afterAll(async () => {
  for (const id of created) {
    await deleteProjectQuietly(owner, id);
  }
});

describe("创建与读取", () => {
  it("创建作品返回 201，并自动带一章和一份空的风格档案", async () => {
    const client = new HttpClient();
    await client.login(OWNER.email, OWNER.password);

    const response = await client.post("/api/projects", {
      title: "第九阶段测试作品",
      description: "自动化测试建的",
      genre: "悬疑",
    });

    expect(response.status).toBe(201);

    const projectId = response.body.id as string;
    created.push(projectId);

    const detail = await client.json(`/api/projects/${projectId}`);

    expect(detail.status).toBe(200);
    expect(detail.body.title).toBe("第九阶段测试作品");
    expect(detail.body.genre).toBe("悬疑");
    // 新作品必须自带第一章，否则用户点进去是一片空白还不知道该干嘛
    expect((detail.body.chapters as unknown[]).length).toBe(1);
    expect(detail.body.styleProfile).toBeTruthy();
  });

  it("标题为空创建不出来（400）", async () => {
    expectFailure(await owner.post("/api/projects", { title: "" }), 400);
  });

  it("列表里只出现自己的作品", async () => {
    const list = await owner.json<{
      items: { id: string; title: string }[];
      total: number;
      hasMore: boolean;
    }>("/api/projects");

    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    expect(typeof list.body.total).toBe("number");
    expect(list.body.total).toBeGreaterThan(0);
  });

  it("分页：limit 生效，且返回 total / hasMore", async () => {
    const list = await owner.json<{
      items: unknown[];
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    }>("/api/projects?limit=1&offset=0");

    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(1);
    expect(list.body.limit).toBe(1);
    expect(list.body.offset).toBe(0);
    // total 是总数，不受 limit 影响
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    expect(list.body.hasMore).toBe(list.body.total > 1);
  });

  it("分页参数不合法时是 400，不是 500", async () => {
    expectFailure(await owner.json("/api/projects?limit=0"), 400);
    expectFailure(await owner.json("/api/projects?limit=99999"), 400);
    expectFailure(await owner.json("/api/projects?offset=-1"), 400);
  });
});

describe("修改", () => {
  it("改基本信息与风格档案，读回来是对的", async () => {
    const projectId = await createProject(owner, "第九阶段改动测试");
    created.push(projectId);

    const patch = await owner.patch(`/api/projects/${projectId}/settings`, {
      title: "改过名字的作品",
      description: "改过的简介",
      genre: "都市",
      tone: "冷静克制",
      viewpoint: "第三人称限知",
      sentenceStyle: "短句为主",
    });

    expect(patch.status).toBe(200);

    const detail = await owner.json(`/api/projects/${projectId}`);

    expect(detail.body.title).toBe("改过名字的作品");
    expect((detail.body.styleProfile as Record<string, unknown>).tone).toBe(
      "冷静克制"
    );
    expect((detail.body.styleProfile as Record<string, unknown>).viewpoint).toBe(
      "第三人称限知"
    );
  });
});

describe("删除", () => {
  it("能删掉自己的作品，删完再读是 404", async () => {
    const client = new HttpClient();
    await client.login(OWNER.email, OWNER.password);

    const projectId = await createProject(client, "第九阶段待删除作品");

    const removed = await client.del(`/api/projects/${projectId}`);

    expect(removed.status).toBe(200);

    expectFailure(
      await client.json(`/api/projects/${projectId}`),
      404,
      API_ERROR_CODES.access
    );
  });

  it("删作品会把章节和版本历史一起带走（不留孤儿数据）", async () => {
    const projectId = await createProject(owner, "第九阶段级联删除");
    const chapterId = (await owner.json<{ chapters: { id: string }[] }>(
      `/api/projects/${projectId}`
    )).body.chapters[0].id;

    await owner.patch(`/api/chapters/${chapterId}`, {
      content: "写一点内容，好留下一条版本记录。",
    });

    expect((await owner.del(`/api/projects/${projectId}`)).status).toBe(200);

    // 章节跟着作品一起消失
    expectFailure(await owner.json(`/api/chapters/${chapterId}`), 404);
  });
});

describe("越权访问", () => {
  it("看别人的作品是 403，不是 200 也不是 500", async () => {
    const projectId = await createProject(owner, "第九阶段私有作品");
    created.push(projectId);

    expectFailure(
      await intruder.json(`/api/projects/${projectId}`),
      403,
      API_ERROR_CODES.access
    );
  });

  it("改别人的作品设置也是 403", async () => {
    const projectId = await createProject(owner, "第九阶段私有作品2");
    created.push(projectId);

    expectFailure(
      await intruder.patch(`/api/projects/${projectId}/settings`, {
        title: "我要改别人的",
      }),
      403
    );
  });

  it("删别人的作品也是 403", async () => {
    const projectId = await createProject(owner, "第九阶段私有作品3");
    created.push(projectId);

    expectFailure(await intruder.del(`/api/projects/${projectId}`), 403);

    // 确认真的没被删掉
    expect((await owner.json(`/api/projects/${projectId}`)).status).toBe(200);
  });

  it("作品不存在时返回 404（跟 403 分开，便于判断是「没权限」还是「找错了」）", async () => {
    expectFailure(await owner.json("/api/projects/no-such-project-id"), 404);
  });
});
