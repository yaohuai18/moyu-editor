import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_ERROR_CODES } from "@/lib/log";
import {
  HttpClient,
  createChapter,
  createProject,
  deleteProjectQuietly,
  ensureAccount,
  expectFailure,
} from "./helpers";

/**
 * 导出：用户把自己的作品带走的唯一通道。
 *
 * 这组用例盯的是三件真会出事的事：
 * - 别人的作品能不能被导出（不能）；
 * - 导出的中文文件名会不会乱码（只给 filename= 就会）；
 * - 导出的内容是不是最新、顺序对不对。
 *
 * 注意：新建作品接口会自动带一章「第一章」，所以这里的第一章
 * 直接用现成的那一章，不再自己建 —— 否则序号会从 2 开始，
 * 断言看起来像导出错了，其实只是测试数据建多了。
 */
const AUTHOR = {
  name: "九期导出作者",
  email: "p9-export-author@test.local",
  password: "p9-export-123456",
};

const OTHER = {
  name: "九期导出路人",
  email: "p9-export-other@test.local",
  password: "p9-export-other-123456",
};

let author: HttpClient;
let other: HttpClient;
let projectId: string;
let firstChapterId: string;

beforeAll(async () => {
  author = await ensureAccount(AUTHOR);
  other = await ensureAccount(OTHER);

  projectId = await createProject(author, "第九阶段导出测试");

  const detail = await author.json<{
    chapters: { id: string; title: string }[];
  }>(`/api/projects/${projectId}`);

  firstChapterId = detail.body.chapters[0].id;

  // 先写正文，导出才有的可验
  await author.patch(`/api/chapters/${firstChapterId}`, {
    content: "雨停了。\n周砚回来了。",
  });

  const secondChapterId = await createChapter(author, projectId, "旧信");

  await author.patch(`/api/chapters/${secondChapterId}`, {
    content: "信纸是潮的。",
  });
});

afterAll(async () => {
  await deleteProjectQuietly(author, projectId);
});

describe("全书导出", () => {
  it("txt：书名、章节、正文、顺序都对，响应是下载而不是网页", async () => {
    const response = await author.raw(
      `/api/projects/${projectId}/export?format=txt`
    );
    const text = await response.text();
    const disposition = response.headers.get("content-disposition") || "";

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("filename*=UTF-8''");

    expect(text).toContain("第九阶段导出测试");
    expect(text).toContain("第 1 章 第一章");
    expect(text).toContain("雨停了。");
    expect(text).toContain("第 2 章 旧信");
    expect(text).toContain("信纸是潮的。");
    expect(text.indexOf("第 1 章")).toBeLessThan(text.indexOf("第 2 章"));
  });

  it("md：有 # 书名和 ## 章节", async () => {
    const response = await author.raw(
      `/api/projects/${projectId}/export?format=md`
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(text).toContain("# 第九阶段导出测试");
    expect(text).toContain("## 第 1 章 第一章");
  });

  it("format 不写或写错都按 txt 给，不报错", async () => {
    const noFormat = await author.raw(`/api/projects/${projectId}/export`);

    expect(noFormat.status).toBe(200);
    expect(noFormat.headers.get("content-type")).toContain("text/plain");

    const bogus = await author.raw(
      `/api/projects/${projectId}/export?format=docx`
    );

    expect(bogus.status).toBe(200);
    expect(bogus.headers.get("content-type")).toContain("text/plain");
  });
});

describe("单章导出", () => {
  it("txt：只有这一章，不带别的章", async () => {
    const response = await author.raw(
      `/api/chapters/${firstChapterId}/export?format=txt`
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("第 1 章 第一章");
    expect(text).toContain("雨停了。");
    expect(text).not.toContain("信纸是潮的。");
  });

  it("md：一级标题开头", async () => {
    const response = await author.raw(
      `/api/chapters/${firstChapterId}/export?format=md`
    );
    const text = await response.text();

    expect(text.startsWith("# 第 1 章 第一章")).toBe(true);
  });

  it("文件名带书名和章名，中文走 RFC 5987 编码", async () => {
    const response = await author.raw(
      `/api/chapters/${firstChapterId}/export?format=txt`
    );
    const disposition = response.headers.get("content-disposition") || "";

    expect(disposition).toContain("filename*=UTF-8''");

    const encoded = disposition.split("filename*=UTF-8''")[1];
    const decoded = decodeURIComponent(encoded);

    expect(decoded).toContain("第九阶段导出测试");
    expect(decoded).toContain("第 1 章 第一章");
    expect(decoded.endsWith(".txt")).toBe(true);
  });
});

describe("权限", () => {
  it("没登录导不了（401）", async () => {
    expectFailure(
      await new HttpClient().json(`/api/projects/${projectId}/export?format=txt`),
      401,
      API_ERROR_CODES.auth
    );
  });

  it("别人的作品导不了（403）", async () => {
    expectFailure(
      await other.json(`/api/projects/${projectId}/export?format=txt`),
      403,
      API_ERROR_CODES.access
    );
  });

  it("别人的章节也导不了（403）", async () => {
    expectFailure(
      await other.json(`/api/chapters/${firstChapterId}/export?format=txt`),
      403,
      API_ERROR_CODES.access
    );
  });

  it("不存在的作品返回 404", async () => {
    expectFailure(
      await author.json(`/api/projects/no-such-project/export?format=txt`),
      404,
      API_ERROR_CODES.access
    );
  });

  it("不存在的章节返回 404", async () => {
    expectFailure(
      await author.json(`/api/chapters/no-such-chapter/export?format=txt`),
      404,
      API_ERROR_CODES.access
    );
  });
});
