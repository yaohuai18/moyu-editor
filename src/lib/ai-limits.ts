/**
 * AI 输入长度限制 —— 客户端和服务端共用这一份，绝不允许两边各写一个数字。
 *
 * 单独一个文件是为了让「编辑页」能 import 到限制值，
 * 又不会因此把 `src/lib/ai.ts`（含 API Key 的读取逻辑）带进浏览器 bundle。
 */

/** 硬上限：字符数（含空白）。超过直接 400，连模型都不叫。 */
export const AI_MAX_INPUT_CHARS = 100_000;

/** 业务上限：去掉空白后的字数 */
export const AI_MAX_INPUT_WORDS = 50_000;
