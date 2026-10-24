import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEnvSummary, inspectEnv } from "@/lib/env";

/**
 * 健康检查接口 `/api/health`。
 *
 * 给部署平台、监控探针、上线后自查用，所以**不要求登录**。
 * 也正因为谁都打得开，这里返回的每一个字都必须是公开也无所谓的：
 *
 *   ✅ 可以返回：活着没、数据库通不通、AI 配了没、缺哪个变量名
 *   ❌ 绝不能返回：DATABASE_URL / AUTH_SECRET / AI_API_KEY 的值、
 *                  用户数据、数据库原始报错和堆栈
 *
 * 数据库不通时返回 **503**（不是 200）—— 否则负载均衡会以为实例健康，
 * 一直把用户流量往里送。
 */

// 健康检查必须每次真查，不能被静态化或缓存
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DatabaseState = "ok" | "error";

async function checkDatabase(): Promise<DatabaseState> {
  try {
    // 最轻的一枪：只要数据库能应答就行，不碰业务表
    await prisma.$queryRaw`SELECT 1`;

    return "ok";
  } catch (error) {
    // 只往服务端日志里记「错误类型」，不记完整报错 ——
    // Prisma 的初始化错误里可能带连接串片段。
    console.error(
      "[health] 数据库检查失败：",
      error instanceof Error ? error.name : "UnknownError"
    );

    return "error";
  }
}

export async function GET() {
  const database = await checkDatabase();

  const issues = inspectEnv();
  const fatal = issues.filter((issue) => issue.level === "fatal");
  const summary = getEnvSummary();

  const healthy = database === "ok" && fatal.length === 0;

  const body = {
    status: healthy ? "ok" : "error",
    database,
    aiConfigured: summary.ai.configured,
    env: {
      nodeEnv: summary.nodeEnv,
      databaseKind: summary.database.kind,
    },
    // 只报「哪个变量有问题、什么问题」，永远不带值
    issues: issues.map((issue) => ({
      key: issue.key,
      level: issue.level,
      message: issue.message,
    })),
    checkedAt: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    status: healthy ? 200 : 503,
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
