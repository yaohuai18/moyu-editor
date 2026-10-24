import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_ERROR_CODES } from "@/lib/log";
import { countWords } from "@/lib/wordCount";
import {
  HttpClient,
  createChapter,
  createProject,
  deleteProjectQuietly,
  ensureAccount,
  expectFailure,
} from "./helpers";

/**
 * 章节：新建 / 保存 / 版本历史 / 回滚 / 并发冲突。
 *
 * 这里的每个用例都对应一个真实会出事的地方：
 * - 保存后字数没算 → 界面角标和实际不一致；
 * - 保存没留版本 → 写错了回不去；
 * - 并发保存没挡住 → 两个标签页一起开，后写的把先写的覆盖掉。
 */
const AUTHOR = {
  name: "九期章节作者",
  email: "p9-chapter-author@test.local",
  password: "p9-chapter-123456",
};

const OTHER = {
  name: "九期路人",
  email: "p9-chapter-other@test.local",
  password: "p9-chapter-other-123456",
};

let author: HttpClient;
let other: HttpClient;
let projectId: string;
let chapterId: string;

beforeAll(async () => {
  author = await ensureAccount(AUTHOR);
  other = await ensureAccount(OTHER);

  projectId = await createProject(author, "第九阶段章节测试");
  chapterId = await createChapter(author, projectId, "第一节");
});

afterAll(async () => {
  await deleteProjectQuietly(author, projectId);
});

describe("新建章节", () => {
  it("能按标题新建，顺序排在最后", async () => {
    const response = await author.post(`/api/projects/${projectId}/chapters`, {
      title: "自动排序测试",
    });

    expect(response.status).toBe(201);
    expect(response.body.title).toBe("自动排序测试");

    const detail = await author.json<{ chapters: { title: string }[] }>(
      `/api/projects/${projectId}`
    );
    const titles = detail.body.chapters.map((c) => c.title);

    expect(titles[titles.length - 1]).toBe("自动排序测试");
  });

  it("别人的作品里建不了章节（403）", async () => {
    expectFailure(
      await other.post(`/api/projects/${projectId}/chapters`, { title: "插一脚" }),
      403,
      API_ERROR_CODES.access
    );
  });
});

describe("保存章节", () => {
  it("存正文会顺带算好字数，并推进版本号", async () => {
    const before = await author.json<{ version: number }>(
      `/api/chapters/${chapterId}`
    );

    const text = "雨停了。\n周砚站在窗前，没有说话。";

    const saved = await author.patch(`/api/chapters/${chapterId}`, {
      content: text,
      version: before.body.version,
    });

    expect(saved.status).toBe(200);
    expect(saved.body.wordCount).toBe(countWords(text));
    expect(saved.body.version).toBe(before.body.version + 1);
  });

  it("保存留了一份版本历史", async () => {
    const history = await author.json<{
      items: { id: string; chars: number; content?: string }[];
      total: number;
    }>(`/api/projects/${projectId}/revisions?chapterId=${chapterId}`);

    expect(history.status).toBe(200);
    expect(history.body.items.length).toBeGreaterThan(0);
    // 列表是**摘要**：有字数、没有正文（正文要点开单条才取）
    expect(history.body.items[0].chars).toBeGreaterThan(0);
    expect(history.body.items[0].content).toBeUndefined();

    // 单条全文接口能取到正文
    const detail = await author.json<{ content: string }>(
      `/api/projects/${projectId}/revisions/${history.body.items[0].id}`
    );

    expect(detail.status).toBe(200);
    expect(detail.body.content).toContain("周砚");
  });

  it("改标题不影响正文", async () => {
    const current = await author.json<{
      content: string;
      version: number;
    }>(`/api/chapters/${chapterId}`);

    const renamed = await author.patch(`/api/chapters/${chapterId}`, {
      title: "第一节（改名）",
      version: current.body.version,
    });

    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe("第一节（改名）");
    expect(renamed.body.content).toBe(current.body.content);
  });

  it("别人的章节存不进去（403）", async () => {
    expectFailure(
      await other.patch(`/api/chapters/${chapterId}`, { content: "我要改" }),
      403,
      API_ERROR_CODES.access
    );
  });
});

describe("并发保存冲突", () => {
  it("拿旧版本号保存会被拒（409），而不是把新内容覆盖掉", async () => {
    const first = await author.json<{ version: number }>(
      `/api/chapters/${chapterId}`
    );

    // 模拟「另一个标签页」先保存了一次
    const otherTab = await author.patch(`/api/chapters/${chapterId}`, {
      content: "另一个标签页写的内容。",
      version: first.body.version,
    });

    expect(otherTab.status).toBe(200);

    // 这边还拿着刚才那个旧版本号
    const stale = await author.patch(`/api/chapters/${chapterId}`, {
      content: "我这边过期了的内容。",
      version: first.body.version,
    });

    expectFailure(stale, 409, API_ERROR_CODES.conflict);
    // 响应里要告诉客户端服务端现在是第几版，便于「用我的覆盖」时对齐
    expect(typeof stale.body.version).toBe("number");

    // 关键：服务端内容没被旧请求改掉
    const now = await author.json<{ content: string }>(
      `/api/chapters/${chapterId}`
    );

    expect(now.body.content).toBe("另一个标签页写的内容。");
  });

  it("不带版本号保存仍然可以（兼容脚本与老客户端）", async () => {
    const response = await author.patch(`/api/chapters/${chapterId}`, {
      content: "不带版本号的保存。",
    });

    expect(response.status).toBe(200);
  });
});

describe("删除章节", () => {
  it("删掉章节后读不到，顺序号会自动补齐不留空档", async () => {
    const tempProject = await createProject(author, "第九阶段删章节");

    try {
      // createProject 本身就会带一章「第一章」，所以这里只需要再建两章
      const second = await createChapter(author, tempProject, "第二章");
      await createChapter(author, tempProject, "第三章");

      const removed = await author.del(`/api/chapters/${second}`);

      expect(removed.status).toBe(200);
      expectFailure(await author.json(`/api/chapters/${second}`), 404);

      const detail = await author.json<{
        chapters: { id: string; title: string; orderIndex: number }[];
      }>(`/api/projects/${tempProject}`);

      // 顺序号必须是 0,1 连续 —— 出现空档会让"第 N 章"的显示错位
      expect(detail.body.chapters.map((c) => c.orderIndex)).toEqual([0, 1]);
      expect(detail.body.chapters.map((c) => c.title)).toEqual([
        "第一章",
        "第三章",
      ]);
    } finally {
      await deleteProjectQuietly(author, tempProject);
    }
  });

  it("删别人的章节是 403，而且真的没删掉", async () => {
    const tempProject = await createProject(author, "第九阶段护住章节");

    try {
      const chapter = await createChapter(author, tempProject, "不许删的一章");

      expectFailure(await other.del(`/api/chapters/${chapter}`), 403);
      expect((await author.json(`/api/chapters/${chapter}`)).status).toBe(200);
    } finally {
      await deleteProjectQuietly(author, tempProject);
    }
  });

  it("删章节会把它的版本历史一起带走", async () => {
    const tempProject = await createProject(author, "第九阶段级联删版本");

    try {
      const chapter = await createChapter(author, tempProject, "有历史的章");

      await author.patch(`/api/chapters/${chapter}`, {
        content: "先写一点内容，好留下一条版本记录。",
      });

      const beforeList = await author.json<{ total: number }>(
        `/api/projects/${tempProject}/revisions?chapterId=${chapter}`
      );

      expect(beforeList.body.total).toBeGreaterThan(0);

      expect((await author.del(`/api/chapters/${chapter}`)).status).toBe(200);

      // 章节没了，它的版本历史也不该还能查出来
      expectFailure(
        await author.json(
          `/api/projects/${tempProject}/revisions?chapterId=${chapter}`
        ),
        404
      );
    } finally {
      await deleteProjectQuietly(author, tempProject);
    }
  });
});

describe("版本历史与回滚", () => {
  /** 把当前章的所有历史版本按「最新在前」拉成完整列表（测试里条数很少，够用） */
  async function fullHistory() {
    const page = await author.json<{
      items: { id: string; createdAt: string; changeReason: string | null; chars: number }[];
    }>(`/api/projects/${projectId}/revisions?chapterId=${chapterId}&limit=50`);

    return page.body.items;
  }

  it("能读到历史版本，最新的在最前面", async () => {
    const items = await fullHistory();

    expect(items.length).toBeGreaterThan(1);

    const times = items.map((r) => new Date(r.createdAt).getTime());

    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
    }
  });

  it("版本历史分页：limit 生效，offset 往后翻不重复", async () => {
    const first = await author.json<{
      items: { id: string }[];
      total: number;
      hasMore: boolean;
    }>(`/api/projects/${projectId}/revisions?chapterId=${chapterId}&limit=1&offset=0`);

    expect(first.status).toBe(200);
    expect(first.body.items.length).toBe(1);

    const second = await author.json<{ items: { id: string }[] }>(
      `/api/projects/${projectId}/revisions?chapterId=${chapterId}&limit=1&offset=1`
    );

    expect(second.body.items.length).toBe(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    // 条数由 total 说了算，不由这一页装了几条决定
    expect(first.body.total).toBeGreaterThan(1);
  });

  it("回滚会恢复内容、推进版本号，并把这次回滚也记成一个版本", async () => {
    const items = await fullHistory();

    // 逐条取全文，找一个含早期内容的版本
    let target: { id: string } | null = null;

    for (const item of items) {
      const detail = await author.json<{ content: string }>(
        `/api/projects/${projectId}/revisions/${item.id}`
      );

      if (detail.body.content.includes("周砚")) {
        target = item;
        break;
      }
    }

    expect(target, "应该能找到一个含早期内容的版本").toBeTruthy();

    const before = await author.json<{ version: number }>(
      `/api/chapters/${chapterId}`
    );

    const restored = await author.post(
      `/api/projects/${projectId}/revisions/${target!.id}/restore`
    );

    expect(restored.status).toBe(200);
    expect(restored.body.content).toContain("周砚");
    // 回滚也是一次写入，版本号必须跟着走
    expect(restored.body.version).toBeGreaterThan(before.body.version);

    const after = await fullHistory();

    expect(after.some((r) => (r.changeReason || "").includes("恢复"))).toBe(true);
  });

  it("取别人的版本全文是不行的（403 / 404，不是 200）", async () => {
    const items = await fullHistory();

    expectFailure(
      await other.json(
        `/api/projects/${projectId}/revisions/${items[0].id}`
      ),
      403,
      API_ERROR_CODES.access
    );
  });

  it("不存在的版本 id 返回 404", async () => {
    expectFailure(
      await author.json(`/api/projects/${projectId}/revisions/no-such-revision`),
      404
    );
  });

  it("拿别人的版本 id 回滚是不行的（404，当它不存在）", async () => {
    const items = await fullHistory();

    const someoneElseProject = await createProject(other, "路人的作品");

    try {
      expectFailure(
        await other.post(
          `/api/projects/${someoneElseProject}/revisions/${items[0].id}/restore`
        ),
        404
      );
    } finally {
      await deleteProjectQuietly(other, someoneElseProject);
    }
  });

  it("读别人的版本历史是 403", async () => {
    expectFailure(
      await other.json(`/api/projects/${projectId}/revisions?chapterId=${chapterId}`),
      403,
      API_ERROR_CODES.access
    );
  });
});
