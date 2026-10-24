import { describe, expect, it } from "vitest";
import { countWords } from "@/lib/wordCount";

/**
 * 字数统计。
 * 这个函数前端（编辑区角标）和后端（存库的 wordCount、AI 长度校验）共用，
 * 口径一旦不一致就会出现「界面说 3 万字、保存后变成 2.9 万字」这种怪事。
 */
describe("countWords", () => {
  it("空串和 undefined 都算 0", () => {
    expect(countWords("")).toBe(0);
    expect(countWords(undefined as unknown as string)).toBe(0);
  });

  it("中文按字算", () => {
    expect(countWords("雨停了")).toBe(3);
  });

  it("空白字符一律不计（半角空格、全角空格、换行、制表符）", () => {
    expect(countWords("雨 停 了")).toBe(3);
    expect(countWords("雨　停　了")).toBe(3); // 全角空格
    expect(countWords("雨\n停\r\n了")).toBe(3);
    expect(countWords("雨\t停 了")).toBe(3);
  });

  it("英文按字母算，标点算进去", () => {
    expect(countWords("hello world")).toBe(10);
    expect(countWords("晚安，周砚。")).toBe(6);
  });

  it("只有空白时是 0（AI 接口靠这个判断「正文不能为空」）", () => {
    expect(countWords("   \n\t　 ")).toBe(0);
  });
});
