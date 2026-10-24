import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authFailureResponse, checkChapterAccess, requireUser } from "@/lib/require-user";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  AI_MAX_INPUT_CHARS,
  AI_MAX_INPUT_WORDS,
  countWords,
  describeAiError,
  runAiEdit,
} from "@/lib/ai";
import { countTodayUsage, DAILY_AI_LIMIT, recordAiFailure, recordAiUsage } from "@/lib/ai-usage";
import { API_ERROR_CODES, classifyError, logError, safeErrorDetail } from "@/lib/log";

/**
 * AI 诊断 / 润色接口。
 *
 * 这一层只干五件事：**鉴权 → 限流 → 查额度 → 校验入参 → 转成响应**。
 * 调模型的所有细节都在 src/lib/ai.ts，这里不碰 fetch，也不碰 API Key。
 *
 * 安全要点：
 * - 必须登录（否则谁拿到地址都能烧你的额度）
 * - 每人每分钟 10 次（挡连点），每天 30 次（挡慢刷）
 * - 正文长度双重限制（字符数 + 去空白字数）
 * - 章节归属在服务端校验，风格档案从数据库读，
 *   **不信客户端传的 projectContext**（那个可以随便伪造）
 */

const requestSchema = z.object({
  projectId: z.string().min(1),
  chapterId: z.string().min(1),
  content: z.string().trim().min(1).max(AI_MAX_INPUT_CHARS),
  mode: z.enum(["diagnose", "polish"]),
});

/** 每人每分钟最多 10 次 AI 调用 */
const RATE_LIMIT = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** 台账里 model 字段的兜底值（限流这类早退分支还没解析请求体，不知道用哪个模型） */
function currentModel() {
  return process.env.AI_MODEL || "unknown";
}

/**
 * 「被拦下来」这件事要不要落台账 —— 每分钟每人最多记一条。
 *
 * 为什么需要这个：被限流的请求**不受限流器约束**（限流器挡下的正是它们），
 * 所以一个刷接口的人可以每分钟产生上千条 429。全记下来会把台账撑爆，
 * 而且真正想看的「谁在被拦」一点也没多出来。
 *
 * 做法是复用限流器本身：给它一个「每分钟只放行 1 次」的 key 当开关。
 * ⚠️ 与限流器同样的限制：这个开关是进程内内存，多实例部署下会各记各的。
 */
function shouldRecordBlockedEvent(userId: string, kind: string) {
  return checkRateLimit(`ai-blocked-log:${kind}:${userId}`, 1, RATE_LIMIT_WINDOW_MS).allowed;
}

/**
 * 输出侧的长度，用来记用量。
 * 诊断返回的是结构化问题列表，没有「一段文本」，就把问题内容序列化后量一下长度 ——
 * 目的是估算输出规模，不需要精确。
 */
function measureOutput(result: { mode: string; revisedText?: string; issues?: unknown[] }) {
  if (result.mode === "polish") {
    return result.revisedText?.length ?? 0;
  }

  return JSON.stringify(result.issues ?? []).length;
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  let context = { projectId: null as string | null, chapterId: null as string | null, mode: null as string | null };
  /** 请求体解析出来后记下输入规模，失败落台账时用（catch 里拿不到 try 块内的 data） */
  let inputChars = 0;

  try {
    const user = await requireUser();
    userId = user.id;

    const rateLimit = checkRateLimit(
      `ai:${user.id}`,
      RATE_LIMIT,
      RATE_LIMIT_WINDOW_MS
    );

    if (!rateLimit.allowed) {
      logError("RATE_LIMITED", {
        userId: user.id,
        status: 429,
        detail: `retryAfter=${rateLimit.retryAfter}s`,
      });

      // 落台账（每分钟最多一条，见 shouldRecordBlockedEvent）。
      // 这条记录 ok=false，所以**不会**再扣用户额度。
      if (shouldRecordBlockedEvent(user.id, "rate")) {
        await recordAiFailure({
          userId: user.id,
          mode: "unknown",
          model: currentModel(),
          inputChars: 0,
          errorCode: "RATE_LIMITED",
        });
      }

      return NextResponse.json(
        {
          error: "AI 请求过于频繁，请稍后再试",
          code: API_ERROR_CODES.rateLimited,
          retryAfter: rateLimit.retryAfter,
        },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfter) },
        }
      );
    }

    const body = await request.json();
    const data = requestSchema.parse(body);

    context = {
      projectId: data.projectId,
      chapterId: data.chapterId,
      mode: data.mode,
    };

    inputChars = data.content.length;

    // 字符数上限已被 zod 管住，这里再管「去掉空白后到底有多少字」。
    // 否则有人塞 10 万个空格就能绕过。
    const contentWords = countWords(data.content);

    if (contentWords > AI_MAX_INPUT_WORDS) {
      logError("PAYLOAD_TOO_LARGE", {
        userId: user.id,
        ...context,
        status: 400,
        detail: `words=${contentWords}`,
      });

      return NextResponse.json(
        {
          error: `单次 AI 编辑最多处理 ${AI_MAX_INPUT_WORDS} 字，当前 ${contentWords} 字，请分章或分段处理`,
          code: API_ERROR_CODES.validation,
        },
        { status: 400 }
      );
    }

    // 归属校验：章节不存在 → 404；存在但不是你的 → 403
    const access = await checkChapterAccess(data.chapterId, user.id);

    if (!access.ok) {
      logError("PROJECT_ACCESS_DENIED", {
        userId: user.id,
        ...context,
        status: access.status,
        detail: `chapter-access-${access.status}`,
      });

      return NextResponse.json(
        { error: access.error, code: API_ERROR_CODES.access },
        { status: access.status }
      );
    }

    // 章节必须确实挂在这个作品下（防止用别人的章节 id 配自己的作品 id）
    const chapter = await prisma.chapter.findFirst({
      where: { id: data.chapterId, projectId: data.projectId },
      select: {
        id: true,
        project: {
          select: {
            title: true,
            description: true,
            genre: true,
            styleProfile: {
              select: { tone: true, viewpoint: true, sentenceStyle: true },
            },
          },
        },
      },
    });

    if (!chapter) {
      return NextResponse.json(
        { error: "该章节不属于这个作品", code: API_ERROR_CODES.access },
        { status: 404 }
      );
    }

    // 每日额度：放在归属校验之后（不该为别人的章节消耗自己的额度判断），
    // 也在真正花钱之前。
    const usedToday = await countTodayUsage(user.id);

    if (usedToday >= DAILY_AI_LIMIT) {
      logError("DAILY_QUOTA_EXCEEDED", {
        userId: user.id,
        status: 429,
        detail: `used=${usedToday}/${DAILY_AI_LIMIT}`,
      });

      // 同样落台账（每分钟最多一条），用来在报表里看出「额度不够用」的用户
      if (shouldRecordBlockedEvent(user.id, "quota")) {
        await recordAiFailure({
          userId: user.id,
          projectId: data.projectId,
          chapterId: data.chapterId,
          mode: data.mode,
          model: currentModel(),
          inputChars: data.content.length,
          errorCode: "DAILY_QUOTA_EXCEEDED",
        });
      }

      return NextResponse.json(
        {
          error: `今日 AI 使用次数已达上限（${DAILY_AI_LIMIT} 次），明天 0 点后恢复`,
          code: API_ERROR_CODES.quota,
          used: usedToday,
          limit: DAILY_AI_LIMIT,
        },
        { status: 429 }
      );
    }

    const result = await runAiEdit({
      content: data.content,
      mode: data.mode,
      projectTitle: chapter.project.title,
      projectDescription: chapter.project.description,
      genre: chapter.project.genre,
      tone: chapter.project.styleProfile?.tone,
      viewpoint: chapter.project.styleProfile?.viewpoint,
      sentenceStyle: chapter.project.styleProfile?.sentenceStyle,
    });

    // 记用量。故意放在返回之前而不是 await 之后忘掉：
    // recordAiUsage 内部自己吞异常，绝不会因为记账失败把结果弄丢。
    await recordAiUsage({
      userId: user.id,
      projectId: data.projectId,
      chapterId: data.chapterId,
      mode: data.mode,
      model: currentModel(),
      inputChars: data.content.length,
      outputChars: measureOutput(result),
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      ...result,
      usage: {
        used: usedToday + 1,
        limit: DAILY_AI_LIMIT,
        remaining: Math.max(0, DAILY_AI_LIMIT - usedToday - 1),
      },
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return NextResponse.json(
        { error: "请先登录", code: API_ERROR_CODES.auth },
        { status: 401 }
      );
    }

    if (error instanceof z.ZodError) {
      const contentIssue = error.issues.find((issue) => issue.path[0] === "content");

      if (contentIssue?.code === "too_big") {
        logError("PAYLOAD_TOO_LARGE", {
          userId,
          ...context,
          status: 400,
          detail: "chars-over-limit",
        });

        return NextResponse.json(
          {
            error: `单次 AI 编辑最多处理 ${AI_MAX_INPUT_CHARS} 个字符，请分章或分段处理`,
            code: API_ERROR_CODES.validation,
          },
          { status: 400 }
        );
      }

      if (contentIssue?.code === "too_small") {
        return NextResponse.json(
          { error: "正文不能为空", code: API_ERROR_CODES.validation },
          { status: 400 }
        );
      }

      logError("VALIDATION_FAILED", { userId, ...context, status: 400 });

      return NextResponse.json(
        {
          error: "AI 请求参数不正确（需要 projectId / chapterId / content / mode）",
          code: API_ERROR_CODES.validation,
        },
        { status: 400 }
      );
    }

    // 请求体不是合法 JSON
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "请求内容不是合法 JSON", code: API_ERROR_CODES.validation },
        { status: 400 }
      );
    }

    // AI 侧的错误（未配置 / 上游失败 / 返回为空 / 格式不对）统一在这里翻译。
    // 注意：响应里永远不含 API Key，只有中文提示。
    const aiFailure = describeAiError(error);

    if (aiFailure) {
      const code = classifyError(error);

      logError(code, {
        userId,
        ...context,
        status: aiFailure.status,
        durationMs: Date.now() - startedAt,
        detail: safeErrorDetail(error),
      });

      // 真失败也落台账（ok=false）。这类记录**受每分钟 10 次的限流约束**，
      // 一个用户最多 10 条/分钟，不需要再做记录节流。
      // 记它的意义：只记成功的话，「上游不稳」在报表上完全看不出来。
      if (userId) {
        await recordAiFailure({
          userId,
          projectId: context.projectId,
          chapterId: context.chapterId,
          mode: context.mode ?? "unknown",
          model: currentModel(),
          inputChars,
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
      ...context,
      status: 500,
      durationMs: Date.now() - startedAt,
      detail: safeErrorDetail(error),
    });

    // 这一支**不落 AI 台账**：走到这里说明是我们自己的代码或数据库出了问题
    // （不在 AI 层），记进去会把「AI 失败率」这个指标污染成四不像。
    // 它出现在日志里，由运维按错误编号去查。
    return NextResponse.json(
      { error: "AI 处理失败，请稍后重试", code: API_ERROR_CODES.database },
      { status: 502 }
    );
  }
}
