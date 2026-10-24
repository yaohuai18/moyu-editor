import { prisma } from "@/lib/prisma";
import { logWarn } from "@/lib/log";

/**
 * AI 用量台账 + 每日额度。
 *
 * 为什么在「每分钟 10 次」的限流之外还要再来一道每日额度：
 * 限流挡的是「手抖连点」和「脚本刷」，挡不住「一整天慢慢刷」。
 * 一个账号一天不紧不慢地点 500 次，限流一次都不会触发，但账单会。
 *
 * 额度按**自然日**算（服务器本地时间的 00:00 为分界）。
 * 单机部署下这就是「用户眼里的今天」；将来多实例部署要注意，
 * 各实例的时区必须一致，否则额度会在半夜突然刷新。
 *
 * ⚠️ 第十一阶段起，台账里除了成功调用，也会记**失败**和**被限流**的记录
 * （`ok=false`）。这是为了让「失败率」「429 次数」这两个运营指标能查出来 ——
 * 只记成功的话，上游挂了反而在报表上看不出来。
 * 但**额度只认 `ok=true`**，所以失败的记录不会白扣用户次数。
 * 改动这张表的查询时，请务必确认 `ok` 过滤还在。
 */

/** 普通用户每天最多调用多少次 AI */
export const DAILY_AI_LIMIT = 30;

/**
 * 今天的起点（本地时间 00:00）。
 * 单独抽出来是为了能写测试 —— 传入任意时间都能算出那天的零点。
 */
export function startOfToday(now: Date = new Date()): Date {
  const start = new Date(now);

  start.setHours(0, 0, 0, 0);

  return start;
}

/**
 * 今天已经**用掉**几次。
 *
 * 只数 `ok=true` —— 台账里还躺着失败和被限流的记录，
 * 那些没有真的调用上游模型，不该算进用户的次数里。
 * （漏了这个过滤，上游抖一次，用户就白扣一次。）
 */
export async function countTodayUsage(userId: string): Promise<number> {
  return prisma.aiUsage.count({
    where: {
      userId,
      ok: true,
      createdAt: { gte: startOfToday() },
    },
  });
}

/** 今天的额度情况，接口和界面都用这一个口径 */
export async function getDailyQuota(userId: string) {
  const used = await countTodayUsage(userId);

  return {
    used,
    limit: DAILY_AI_LIMIT,
    remaining: Math.max(0, DAILY_AI_LIMIT - used),
  };
}

export type AiUsageInput = {
  userId: string;
  projectId?: string | null;
  chapterId?: string | null;
  mode: string;
  model: string;
  inputChars: number;
  outputChars: number;
  /** 调用成功没有，默认 true。失败要显式传 false（用 recordAiFailure 更清楚） */
  ok?: boolean;
  /** 这次调用花了多久（毫秒） */
  durationMs?: number | null;
  /** 失败编号，与 src/lib/log.ts 的 ErrorCode 同一套 */
  errorCode?: string | null;
};

/**
 * 记一条台账。
 *
 * **这个函数永远不抛异常。** 用量台账是「记账」，AI 结果才是「交付」——
 * 账记漏了顶多是统计不准，但要是因为记账失败把已经生成好的润色稿吞掉，
 * 用户会觉得「AI 用一次坏一次」。所以失败只写一条 warn 日志。
 *
 * 注意：这里记的是**字符数**，不是正文。
 */
export async function recordAiUsage(input: AiUsageInput): Promise<boolean> {
  try {
    await prisma.aiUsage.create({
      data: {
        userId: input.userId,
        projectId: input.projectId ?? null,
        chapterId: input.chapterId ?? null,
        mode: input.mode,
        model: input.model,
        inputChars: input.inputChars,
        outputChars: input.outputChars,
        ok: input.ok ?? true,
        durationMs: input.durationMs ?? null,
        errorCode: input.errorCode ?? null,
      },
    });

    return true;
  } catch (error) {
    logWarn("DATABASE_ERROR", {
      userId: input.userId,
      projectId: input.projectId,
      chapterId: input.chapterId,
      mode: input.mode,
      detail: `usage-write-failed:${error instanceof Error ? error.name : "unknown"}`,
    });

    return false;
  }
}

/**
 * 记一次**失败 / 被拦下来**的调用。
 *
 * 与 recordAiUsage 的唯一区别是 `ok=false` —— 语义上更明确，
 * 也避免调用点忘了传 ok 而把失败算成成功（那会让额度被白扣）。
 *
 * 有意**不记**参数错误（400）、未登录（401）、越权（403/404）：
 * 那些是用户操作错误、不是 AI 使用情况，而且量可能很大，
 * 全记进来会把台账冲成一堆噪声，反而看不出上游到底稳不稳。
 */
export function recordAiFailure(
  input: Omit<AiUsageInput, "ok" | "outputChars"> & { outputChars?: number }
) {
  return recordAiUsage({
    ...input,
    ok: false,
    outputChars: input.outputChars ?? 0,
  });
}
