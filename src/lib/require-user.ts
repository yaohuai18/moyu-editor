import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { API_ERROR_CODES } from "@/lib/log";
import type { User } from "@prisma/client";

/** 未登录时抛出这个，交给 authFailureResponse 统一转成 401 */
export class UnauthorizedError extends Error {
  constructor() {
    super("UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

/**
 * 取当前登录用户。没登录（或用户已被删）就抛 UnauthorizedError。
 *
 * 用法：在每个接口最开头 await 一次，后面一律用 user.id 过滤数据，
 * 不要再出现任何写死的邮箱。
 *
 * 这里还会比对**会话代次**（User.tokenVersion）：
 * 改过密码的账号，"其它设备上还留着的旧 Cookie" 会被判定为未登录。
 * 会话是 JWT（服务端不存会话记录），所以这是唯一能让旧登录态立刻失效的钩子。
 * 读一次用户本来就要查库，这一步是顺带的，没有额外开销。
 */
export async function requireUser(): Promise<User> {
  const session = await auth();

  if (!session?.user?.id) {
    throw new UnauthorizedError();
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
  });

  if (!user) {
    throw new UnauthorizedError();
  }

  // 老 Cookie 里没有这一项，按 0 算 —— 这样本次改动不会把所有人踢下线
  const sessionVersion = session.user.tokenVersion ?? 0;

  if (user.tokenVersion !== sessionVersion) {
    throw new UnauthorizedError();
  }

  return user;
}

/**
 * 把 requireUser 抛出的异常转成响应。
 * 不是鉴权错误时返回 null，说明该异常与登录无关，交给调用方自己的
 * catch 分支处理（Zod 报错、其他 500 等）。
 *
 * 响应里带 `code: "AUTH_FAILED"`：用户截图来问「怎么突然要登录」时，
 * 前端/日志里搜这个字符串就能确认是会话过期，而不是别的 401。
 */
export function authFailureResponse(error: unknown) {
  if (error instanceof UnauthorizedError) {
    return NextResponse.json(
      { error: "请先登录", code: API_ERROR_CODES.auth },
      { status: 401 }
    );
  }

  return null;
}

export type AccessCheck =
  | { ok: true }
  | { ok: false; status: 403 | 404; error: string };

/**
 * 校验「这个作品是不是当前用户的」。
 *
 * 刻意分成两个结果：作品根本不存在 → 404；存在但不是你的 → 403。
 * 这样改 URL 试别人的作品时，能一眼看出是被拦了，而不是「页面坏了」。
 */
export async function checkProjectAccess(
  projectId: string,
  userId: string
): Promise<AccessCheck> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  });

  if (!project) {
    return { ok: false, status: 404, error: "作品不存在" };
  }

  if (project.userId !== userId) {
    return { ok: false, status: 403, error: "无权访问该作品" };
  }

  return { ok: true };
}

export type ChapterAccess =
  | { ok: true; chapter: { id: string; projectId: string } }
  | { ok: false; status: 403 | 404; error: string };

/** 章节级的归属校验：顺着 章节 → 作品 → userId 查一遍 */
export async function checkChapterAccess(
  chapterId: string,
  userId: string
): Promise<ChapterAccess> {
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    select: { id: true, projectId: true, project: { select: { userId: true } } },
  });

  if (!chapter) {
    return { ok: false, status: 404, error: "章节不存在" };
  }

  if (chapter.project.userId !== userId) {
    return { ok: false, status: 403, error: "无权访问该作品" };
  }

  return { ok: true, chapter: { id: chapter.id, projectId: chapter.projectId } };
}
