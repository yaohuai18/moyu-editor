import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { logRouteError, API_ERROR_CODES } from "@/lib/log";
import { checkRateLimit, getClientIp, isLoopbackIp } from "@/lib/rate-limit";

const registerSchema = z.object({
  name: z.string().min(1).max(50),
  email: z.string().email().max(200),
  password: z.string().min(8).max(100),
});

/**
 * POST /api/auth/register
 * 注册新账号。注册完不会自动登录——前端拿到 201 之后再调一次
 * signIn("credentials")，这样登录逻辑只有一处，不会两边不一致。
 */
export async function POST(request: NextRequest) {
  try {
    // 注册限流：挡「批量注册 + 探测邮箱是否被占用」。
    // 409「该邮箱已经注册」是产品功能（提示用户直接去登录），保留；
    // 限流把批量枚举的成本拉高。回环地址跳过（接口测试从 127.0.0.1 来）。
    const ip = getClientIp(request);

    if (!isLoopbackIp(ip)) {
      const limit = checkRateLimit(`register-ip:${ip}`, 5, 60 * 60_000);

      if (!limit.allowed) {
        return NextResponse.json(
          {
            error: "注册太频繁，请稍后再试",
            code: API_ERROR_CODES.rateLimited,
            retryAfter: limit.retryAfter,
          },
          {
            status: 429,
            headers: { "Retry-After": String(limit.retryAfter) },
          }
        );
      }
    }

    const body = await request.json();
    const data = registerSchema.parse(body);

    // 邮箱统一转小写去空格，避免 A@x.com 和 a@x.com 被当成两个账号
    const email = data.email.toLowerCase().trim();

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json({ error: "该邮箱已经注册" }, { status: 409 });
    }

    const passwordHash = await hashPassword(data.password);

    const user = await prisma.user.create({
      data: {
        name: data.name.trim(),
        email,
        passwordHash,
      },
      select: {
        id: true,
        name: true,
        email: true,
      },
    });

    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "注册信息格式不正确，密码至少 8 位" },
        { status: 400 }
      );
    }

    logRouteError(error);

    return NextResponse.json({ error: "注册失败" }, { status: 500 });
  }
}
