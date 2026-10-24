import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authFailureResponse,
  checkProjectAccess,
  requireUser,
} from "@/lib/require-user";
import { API_ERROR_CODES, logRouteError } from "@/lib/log";

/**
 * GET /api/projects/[id]
 * 取作品详情 + 章节列表（不含正文，正文单独取，避免章节多了响应过大）
 *
 * 归属校验：作品不属于当前用户时返回 403，不存在返回 404。
 * 这条就是「改 URL 想看别人作品」的拦路石。
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await requireUser();

    const access = await checkProjectAccess(id, user.id);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error, code: API_ERROR_CODES.access },
        { status: access.status }
      );
    }

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        chapters: {
          select: {
            id: true,
            title: true,
            orderIndex: true,
            wordCount: true,
          },
          orderBy: { orderIndex: "asc" },
        },
        styleProfile: true,
        characters: {
          select: {
            id: true,
            name: true,
            description: true,
            personality: true,
            speakingStyle: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!project) {
      return NextResponse.json({ error: "作品不存在" }, { status: 404 });
    }

    return NextResponse.json(project);
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    logRouteError(error);

    return NextResponse.json({ error: "加载作品失败" }, { status: 500 });
  }
}

/**
 * DELETE /api/projects/[id]
 * 删除作品，连同它的章节、版本历史和人物卡一起删。
 *
 * 这是全站唯一的「一次删掉一大堆东西」的接口，所以：
 * - 先校验归属（不属于你的作品 → 403，不存在 → 404）；
 * - 删之前把章节数记进日志 —— 万一有人误删，至少能从日志里看出来删了多少。
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const user = await requireUser();

    const access = await checkProjectAccess(id, user.id);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error, code: API_ERROR_CODES.access },
        { status: access.status }
      );
    }

    const chapters = await prisma.chapter.count({ where: { projectId: id } });

    await prisma.project.delete({ where: { id } });

    console.log(
      `[PROJECT_DELETED] ${JSON.stringify({
        userId: user.id,
        projectId: id,
        chapters,
      })}`
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    logRouteError(error, { status: 500 });

    return NextResponse.json({ error: "删除作品失败" }, { status: 500 });
  }
}
