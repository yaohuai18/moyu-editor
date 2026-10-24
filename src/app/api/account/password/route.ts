import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authFailureResponse, requireUser } from "@/lib/require-user";
import { hashPassword, verifyPassword } from "@/lib/password";
import { checkRateLimit } from "@/lib/rate-limit";
import { API_ERROR_CODES, logError, logRouteError } from "@/lib/log";

/**
 * 新密码规则跟注册保持一致（至少 8 位）。
 * 这里刻意不做「必须含大小写数字符号」那套 —— 强行加规则的结果通常是
 * 大家都写成 Abc12345，反而更弱；长度才是最有效的因子。
 */
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(100),
  newPassword: z.string().min(8, "新密码至少 8 位").max(100),
});

/** 改密码这类操作不该被反复试，10 分钟 10 次足够本人使用 */
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 10 * 60_000;

/**
 * POST /api/account/password
 * 修改密码。
 *
 * 改完会把 User.tokenVersion +1 —— 其它设备上留着的旧登录 Cookie 会立刻失效，
 * 连当前这个浏览器也一样（要重新登录一次）。这样做是为了兑现「改了密码，
 * 别人就进不来了」这个预期；否则旧 Cookie 能一直用到它自己过期。
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();

    // 先限流再干活：这个接口要反复验证密码，是暴力猜测的入口
    const limit = checkRateLimit(
      `password:${user.id}`,
      RATE_LIMIT,
      RATE_WINDOW_MS
    );

    if (!limit.allowed) {
      logError("RATE_LIMITED", {
        userId: user.id,
        status: 429,
        detail: "password",
      });

      return NextResponse.json(
        {
          error: `操作过于频繁，请 ${limit.retryAfter} 秒后再试`,
          code: API_ERROR_CODES.rateLimited,
          retryAfter: limit.retryAfter,
        },
        { status: 429 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const data = changePasswordSchema.parse(body);

    if (data.newPassword === data.currentPassword) {
      return NextResponse.json(
        { error: "新密码不能与当前密码相同", code: API_ERROR_CODES.validation },
        { status: 400 }
      );
    }

    if (!user.passwordHash) {
      return NextResponse.json(
        {
          error: "该账号没有设置密码，无法自助修改，请联系管理员",
          code: API_ERROR_CODES.validation,
        },
        { status: 400 }
      );
    }

    const valid = await verifyPassword(data.currentPassword, user.passwordHash);

    if (!valid) {
      logError("PASSWORD_MISMATCH", {
        userId: user.id,
        status: 400,
        detail: "change-password",
      });

      return NextResponse.json(
        { error: "当前密码不正确", code: API_ERROR_CODES.credentials },
        { status: 400 }
      );
    }

    const passwordHash = await hashPassword(data.newPassword);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        // 让所有旧会话失效（含当前这个浏览器）
        tokenVersion: { increment: 1 },
      },
    });

    console.log(`[PASSWORD_CHANGED] ${JSON.stringify({ userId: user.id })}`);

    return NextResponse.json({ ok: true, reloginRequired: true });
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: "新密码至少 8 位（最长 100 位）",
          code: API_ERROR_CODES.validation,
        },
        { status: 400 }
      );
    }

    logRouteError(error);

    return NextResponse.json(
      { error: "修改密码失败，原密码未改动", code: API_ERROR_CODES.database },
      { status: 500 }
    );
  }
}
