import { describe, expect, it } from "vitest";
import {
  buildChapterExport,
  buildChapterExportFilename,
  buildProjectExport,
  buildProjectExportFilename,
  chapterHeading,
  contentDispositionHeader,
  parseExportFormat,
  sanitizeFilenamePart,
} from "@/lib/export";

/**
 * 导出内容与文件名。
 *
 * 导出是「用户把稿子带走」的唯一通道，出错代价很高：
 * 文件名乱码，用户以为导出坏了；章节顺序错了，他要自己一页页对；
 * 内容里混进占位字，粘到别处还要一个个删。所以这里逐条钉死。
 */
const CHAPTERS = [
  { title: "雨夜", content: "雨停了。\n周砚回来了。", orderIndex: 0 },
  { title: "", content: "", orderIndex: 1 },
];

describe("parseExportFormat", () => {
  it("认识 txt 和 md", () => {
    expect(parseExportFormat("txt")).toBe("txt");
    expect(parseExportFormat("md")).toBe("md");
  });

  it("不认识、空、null 都退回 txt，不报错", () => {
    expect(parseExportFormat("docx")).toBe("txt");
    expect(parseExportFormat("")).toBe("txt");
    expect(parseExportFormat(null)).toBe("txt");
    expect(parseExportFormat(undefined)).toBe("txt");
  });
});

describe("sanitizeFilenamePart", () => {
  it("把 Windows 不允许的字符换成下划线", () => {
    expect(sanitizeFilenamePart('a/b\\c:d*e?f"g<h>i|j')).toBe(
      "a_b_c_d_e_f_g_h_i_j"
    );
  });

  it("去掉结尾的点和空格（Windows 会静默吃掉它们）", () => {
    expect(sanitizeFilenamePart("第3章. ")).toBe("第3章");
  });

  it("连续空白压成一个空格", () => {
    expect(sanitizeFilenamePart("罪   域")).toBe("罪 域");
  });

  it("清完是空的就用兜底名", () => {
    expect(sanitizeFilenamePart("   ")).toBe("未命名");
    expect(sanitizeFilenamePart("", "未命名作品")).toBe("未命名作品");
  });
});

describe("chapterHeading", () => {
  it("orderIndex 从 0 开始，显示时 +1", () => {
    expect(chapterHeading(0, "雨夜")).toBe("第 1 章 雨夜");
    expect(chapterHeading(9, "结局")).toBe("第 10 章 结局");
  });

  it("标题为空就只写第几章", () => {
    expect(chapterHeading(2, "   ")).toBe("第 3 章");
  });
});

describe("全书导出", () => {
  const project = { title: "罪域", genre: "悬疑", description: null };

  it("txt：带书名、章节标题和正文，章节按顺序", () => {
    const text = buildProjectExport(project, CHAPTERS, "txt");

    expect(text.startsWith("罪域")).toBe(true);
    expect(text).toContain("第 1 章 雨夜");
    expect(text).toContain("雨停了。\n周砚回来了。");
    expect(text).toContain("第 2 章");
    expect(text.indexOf("第 1 章")).toBeLessThan(text.indexOf("第 2 章"));
  });

  it("md：用 # 和 ## 分层，带上分类和章数", () => {
    const md = buildProjectExport(project, CHAPTERS, "md");

    expect(md).toContain("# 罪域");
    expect(md).toContain("> 分类：悬疑 · 共 2 章");
    expect(md).toContain("## 第 1 章 雨夜");
    expect(md).toContain("## 第 2 章");
  });

  it("没有章节时给一句说明，不是空文件", () => {
    const text = buildProjectExport(project, [], "txt");

    expect(text).toContain("还没有章节");
  });

  it("作品名是空白时用「未命名作品」", () => {
    const text = buildProjectExport({ title: "  " }, [], "txt");

    expect(text.startsWith("未命名作品")).toBe(true);
  });

  it("正文里的 Windows 换行统一成 \\n，不在文件里留 \\r", () => {
    const text = buildProjectExport(
      project,
      [{ title: "一章", content: "第一行\r\n第二行", orderIndex: 0 }],
      "txt"
    );

    expect(text).not.toContain("\r");
    expect(text).toContain("第一行\n第二行");
  });
});

describe("单章导出", () => {
  it("txt：只有这一章，标题和正文之间空一行", () => {
    expect(buildChapterExport(CHAPTERS[0], "txt")).toBe(
      "第 1 章 雨夜\n\n雨停了。\n周砚回来了。\n"
    );
  });

  it("md：用一级标题", () => {
    expect(buildChapterExport(CHAPTERS[0], "md")).toBe(
      "# 第 1 章 雨夜\n\n雨停了。\n周砚回来了。\n"
    );
  });

  it("空章节只留标题，不塞占位字（用户会直接把正文粘去别处）", () => {
    expect(buildChapterExport(CHAPTERS[1], "txt")).toBe("第 2 章\n");
    expect(buildChapterExport(CHAPTERS[1], "md")).toBe("# 第 2 章\n");
  });
});

describe("文件名", () => {
  it("全书文件名就是书名 + 扩展名", () => {
    expect(buildProjectExportFilename("罪域", "txt")).toBe("罪域.txt");
    expect(buildProjectExportFilename("罪域", "md")).toBe("罪域.md");
  });

  it("书名里的非法字符会被清掉", () => {
    expect(buildProjectExportFilename("罪/域", "txt")).toBe("罪_域.txt");
  });

  it("单章文件名带书名和章名", () => {
    expect(buildChapterExportFilename("罪域", CHAPTERS[0], "txt")).toBe(
      "罪域-第 1 章 雨夜.txt"
    );
  });

  it("超长书名会截断，不会生成一个 Windows 打不开的文件", () => {
    const filename = buildProjectExportFilename("罪".repeat(100), "txt");

    expect(filename.length).toBeLessThan(70);
    expect(filename.endsWith(".txt")).toBe(true);
  });
});

describe("contentDispositionHeader", () => {
  it("同时给 ASCII 兜底和 RFC 5987 的 UTF-8 文件名", () => {
    const header = contentDispositionHeader("罪域.txt");

    expect(header.startsWith("attachment;")).toBe(true);
    expect(header).toContain("filename=");
    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain(encodeURIComponent("罪域.txt"));
  });

  it("filename= 那半段必须是纯 ASCII（中文只出现在 filename* 里）", () => {
    const header = contentDispositionHeader("罪域.txt");
    const asciiPart = header.slice(0, header.indexOf("filename*=UTF-8''"));

    expect(asciiPart).toMatch(/^[\x20-\x7e]*$/);
  });

  it("RFC 5987 要求转义的 ' ( ) ! * 也转了，否则某些浏览器拒绝整个头", () => {
    const header = contentDispositionHeader("笔记(1).txt");

    expect(header).toContain("%28");
    expect(header).toContain("%29");
  });
});
