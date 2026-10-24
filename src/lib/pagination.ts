/**
 * 分页相关的公开常量。
 *
 * 放在单独一个文件里，是因为**服务端首屏和接口必须用同一个数字**：
 * 首页列表是服务端直接查库渲染的（见 src/app/page.tsx），
 * 「加载更多」走的是 /api/projects —— 两边页大小不一致的话，
 * 会出现「首屏 24 部，点加载更多后第 25 部被跳过 / 重复」这种错位。
 *
 * 注意这个文件是**能进浏览器的**（前端也要 import），
 * 所以只能放常量，不要 import prisma、ai 这类服务端模块。
 */

/** 首页「我的作品」一页多少部 */
export const PROJECT_PAGE_SIZE = 24;

/** 作品列表接口允许的最大页大小 */
export const MAX_PROJECT_PAGE_SIZE = 100;

/** 版本历史一页多少条 */
export const REVISION_PAGE_SIZE = 10;

/** 版本历史接口允许的最大页大小 */
export const MAX_REVISION_PAGE_SIZE = 50;
