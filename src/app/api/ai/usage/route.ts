import { NextResponse } from "next/server";
import { authFailureResponse, requireUser } from "@/lib/require-user";
import { getDailyQuota } from "@/lib/ai-usage";
import { API_ERROR_CODES, classifyError, logError, safeErrorDetail } from "@/lib/log";

/**
 * GET /api/ai/usage
 * 返回当前登录用户「今天还能用几次 AI」。
 *
 * 为什么要这个接口：每日额度是本阶段新加的，如果界面上不显示，
 * 用户只会看到某一次请求突然变成 429，然后以为「AI 坏了」。
 * 把还剩几次摆在面板上，额度就变成一个能被理解的东西。
 *
 * 只返回自己的用量，不接受任何参数 —— 免得变成「查别人用了多少」的接口。
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const quota = await getDailyQuota(user.id);

    return NextResponse.json(
      { ...quota, resetAt: tomorrowStart().toISOString() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return NextResponse.json(
        { error: "请先登录", code: API_ERROR_CODES.auth },
        { status: 401 }
      );
    }

    logError(classifyError(error), {
      status: 500,
      detail: safeErrorDetail(error),
    });

    return NextResponse.json(
      { error: "查询 AI 用量失败", code: API_ERROR_CODES.database },
      { status: 500 }
    );
  }
}

/** 额度什么时候恢复（明天的 00:00），前端用来告诉用户「几点之后能继续用」 */
function tomorrowStart() {
  const next = new Date();

  next.setHours(24, 0, 0, 0);

  return next;
}
