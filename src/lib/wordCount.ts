/**
 * 中文字数统计。
 * 网文作者说的「字数」= 去掉空白后的字符数（中文按字、英文按字母都算 1）。
 * 全角空格、换行、制表符都不计入。
 */
export function countWords(text: string): number {
  if (!text) return 0;
  return text.replace(/\s/g, "").length;
}
