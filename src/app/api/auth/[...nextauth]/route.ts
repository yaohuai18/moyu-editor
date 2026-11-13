import { NextRequest, NextResponse } from "next/server";
import { handlers } from "@/auth";
import { checkRateLimit, getClientIp, isLoopbackIp } from "@/lib/rate-limit";
import { API_ERROR_CODES } from "@/lib/log";

export const GET = handlers.GET;

const LOGIN_EMAIL_LIMIT = 10;
const LOGIN_IP_LIMIT = 30;
const LOGIN_WINDOW_MS = 5 * 60_000;

function rateLimited(retryAfter: number) {
  return NextResponse.json(
    {
      error: "尝试过于频繁，请稍后再试",
      code: API_ERROR_CODES.rateLimited,
      retryAfter,
    },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}

/**
 * POST /api/auth/callback/credentials —— 登录限流（防在线撞库）。
 *
 * 两道闸：
 * 1. 按邮箱：同一邮箱 5 分钟内最多 10 次尝试 —— 挡「盯着一个账号撞密码」；
 * 2. 按 IP：同一来源 5 分钟内最多 30 次 —— 挡「一个 IP 扫一堆账号」。
 *
 * 限流器是进程内存（单实例部署前提，见 src/lib/rate-limit.ts）。
 * 回环地址跳过 IP 闸：本地开发与接口测试都从 127.0.0.1 来，
 * 开了会把整条测试套件限死；邮箱闸对回环也生效。
 * x-forwarded-for 可以伪造，这只是挡普通撞库脚本的闸，不是安全边界。
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request);

  if (!isLoopbackIp(ip)) {
    const ipLimit = checkRateLimit(
      `login-ip:${ip}`,
      LOGIN_IP_LIMIT,
      LOGIN_WINDOW_MS
    );

    if (!ipLimit.allowed) {
      return rateLimited(ipLimit.retryAfter);
    }
  }

  // 邮箱在表单里（Auth.js credentials 回调的固定格式）。
  // 读 clone 而不是原请求：Auth.js 还要自己读一遍请求体。
  const form = new URLSearchParams(await request.clone().text());
  const email = form.get("email")?.toLowerCase().trim();

  if (email) {
    const emailLimit = checkRateLimit(
      `login:${email}`,
      LOGIN_EMAIL_LIMIT,
      LOGIN_WINDOW_MS
    );

    if (!emailLimit.allowed) {
      return rateLimited(emailLimit.retryAfter);
    }
  }

  return handlers.POST(request);
}
