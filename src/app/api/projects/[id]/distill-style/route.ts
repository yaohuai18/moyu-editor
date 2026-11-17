import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authFailureResponse,
  checkProjectAccess,
  requireUser,
} from "@/lib/require-user";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  AI_MAX_INPUT_CHARS,
  countWords,
  describeAiError,
  runStyleDistill,
} from "@/lib/ai";
import {
  DAILY_AI_LIMIT,
  recordAiFailure,
  recordAiUsage,
  releaseQuotaReservation,
  tryReserveQuota,
} from "@/lib/ai-usage";
import { API_ERROR_CODES, classifyError, logError, safeErrorDetail } from "@/lib/log";

/**
 * POST /api/projects/[id]/distill-style
 * 从作品最近的章节里蒸馏「风格档案」草稿。
 *
 * 这一层只干五件事：**鉴权 → 限流 → 查额度 → 取样与校验 → 转成响应**。
 * 归纳逻辑在 src/lib/ai.ts 的 runStyleDistill，这里不碰 fetch、不碰 Key。
 *
 * 产品约束（改动前先读）：
 * - 只返回**建议值**，不写库。作者在设置页确认后才走 PATCH settings 保存 ——
 *   AI 不能悄悄改一个人的文风设定。
 * - 与诊断/润色**共用**每日 AI 额度（同一本账），蒸馏一次算一次调用。
 * - 取样只取有正文的最近章节，总字符有上限：文风看的是写法，
 *   不需要把整本塞进提示词，省下的都是真金白银。
 */

/** 每人每分钟最多 3 次蒸馏（比编辑接口更严：一次要读好几章） */
const RATE_LIMIT = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** 取最近几章做样本 */
const SAMPLE_CHAPTER_COUNT = 3;

/** 样本下限：少于 200 字归纳不出任何可靠的文风 */
const MIN_SAMPLE_WORDS = 200;

/**
 * 样本字符上限。12k 字符（约 6k 汉字）足够看出句长节奏、常用句式和口头禅，
 * 再往上加只是给 token 账单添零。与全局输入上限取小值，防止常量漂移。
 */
const MAX_SAMPLE_CHARS = Math.min(12_000, AI_MAX_INPUT_CHARS);

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const startedAt = Date.now();
  let userId: string | null = null;
  let projectId: string | null = null;

  try {
    const { id } = await context.params;
    projectId = id;

    const user = await requireUser();
    userId = user.id;

    const rateLimit = checkRateLimit(
      `ai-distill:${user.id}`,
      RATE_LIMIT,
      RATE_LIMIT_WINDOW_MS
    );

    if (!rateLimit.allowed) {
      logError("RATE_LIMITED", {
        userId: user.id,
        projectId: id,
        status: 429,
        detail: `retryAfter=${rateLimit.retryAfter}s`,
      });

      return NextResponse.json(
        {
          error: "文风提取请求过于频繁，请稍后再试",
          code: API_ERROR_CODES.rateLimited,
          retryAfter: rateLimit.retryAfter,
        },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfter) },
        }
      );
    }

    // 归属校验：作品不存在 → 404；不是你的 → 403
    const access = await checkProjectAccess(id, user.id);

    if (!access.ok) {
      logError("PROJECT_ACCESS_DENIED", {
        userId: user.id,
        projectId: id,
        status: access.status,
        detail: `distill-project-${access.status}`,
      });

      return NextResponse.json(
        { error: access.error, code: API_ERROR_CODES.access },
        { status: access.status }
      );
    }

    // 取样时顺手拿作品元信息（标题/类型进提示词，帮助模型判断文体）
    const [project, recent] = await Promise.all([
      prisma.project.findUnique({
        where: { id },
        select: { title: true, genre: true },
      }),
      // 倒序取最近几章有正文的章节，后面再翻回时间正序拼样本
      prisma.chapter.findMany({
        where: { projectId: id, content: { not: "" } },
        orderBy: { orderIndex: "desc" },
        take: SAMPLE_CHAPTER_COUNT,
        select: { title: true, content: true },
      }),
    ]);

    const totalWords = recent.reduce(
      (sum, chapter) => sum + countWords(chapter.content),
      0
    );

    if (totalWords < MIN_SAMPLE_WORDS) {
      return NextResponse.json(
        {
          error: `章节正文太少（最近 ${recent.length} 章共 ${totalWords} 字），至少需要 ${MIN_SAMPLE_WORDS} 字才能提取文风`,
          code: API_ERROR_CODES.validation,
        },
        { status: 400 }
      );
    }

    // 时间正序 + 字符预算：从最早的一章开始装，装不下就截断
    const ordered = [...recent].reverse();
    const parts: string[] = [];
    let budget = MAX_SAMPLE_CHARS;

    for (const chapter of ordered) {
      if (budget <= 0) {
        break;
      }

      const body = chapter.content.slice(0, budget);

      parts.push(`【${chapter.title}】\n${body}`);
      budget -= body.length;
    }

    const samples = parts.join("\n\n");

    // 每日额度：与诊断/润色同一本账，真正花钱之前查
    const quota = await tryReserveQuota(user.id);

    if (!quota.allowed) {
      logError("DAILY_QUOTA_EXCEEDED", {
        userId: user.id,
        projectId: id,
        status: 429,
        detail: `used=${quota.used}/${DAILY_AI_LIMIT}`,
      });

      return NextResponse.json(
        {
          error: `今日 AI 使用次数已达上限（${DAILY_AI_LIMIT} 次），明天 0 点后恢复`,
          code: API_ERROR_CODES.quota,
          used: quota.used,
          limit: DAILY_AI_LIMIT,
        },
        { status: 429 }
      );
    }

    try {
      const result = await runStyleDistill({
        projectTitle: project?.title ?? null,
        genre: project?.genre ?? null,
        samples,
      });

      await recordAiUsage({
        userId: user.id,
        projectId: id,
        mode: "distill",
        model: process.env.AI_MODEL || "unknown",
        inputChars: samples.length,
        outputChars: JSON.stringify(result).length,
        durationMs: Date.now() - startedAt,
      });

      return NextResponse.json({
        ...result,
        sample: {
          chapters: recent.length,
          chars: samples.length,
          truncated: budget <= 0,
        },
        usage: {
          used: quota.used + 1,
          limit: DAILY_AI_LIMIT,
          remaining: Math.max(0, DAILY_AI_LIMIT - quota.used - 1),
        },
        durationMs: Date.now() - startedAt,
      });
    } finally {
      releaseQuotaReservation(user.id);
    }
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return NextResponse.json(
        { error: "请先登录", code: API_ERROR_CODES.auth },
        { status: 401 }
      );
    }

    // AI 侧错误（未配置 / 上游失败 / 空响应 / 格式不对）统一翻译
    const aiFailure = describeAiError(error);

    if (aiFailure) {
      const code = classifyError(error);

      logError(code, {
        userId,
        projectId,
        status: aiFailure.status,
        durationMs: Date.now() - startedAt,
        detail: safeErrorDetail(error),
      });

      if (userId) {
        await recordAiFailure({
          userId,
          projectId,
          mode: "distill",
          model: process.env.AI_MODEL || "unknown",
          inputChars: 0,
          durationMs: Date.now() - startedAt,
          errorCode: code,
        });
      }

      return NextResponse.json(
        { error: aiFailure.message, code: API_ERROR_CODES.ai },
        { status: aiFailure.status }
      );
    }

    const code = classifyError(error);

    logError(code, {
      userId,
      projectId,
      status: 500,
      durationMs: Date.now() - startedAt,
      detail: safeErrorDetail(error),
    });

    return NextResponse.json(
      { error: "文风提取失败，请稍后重试", code: API_ERROR_CODES.database },
      { status: 502 }
    );
  }
}
