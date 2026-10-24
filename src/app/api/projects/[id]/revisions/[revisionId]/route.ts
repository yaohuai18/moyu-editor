import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authFailureResponse,
  checkProjectAccess,
  requireUser,
} from "@/lib/require-user";
import { API_ERROR_CODES, logRouteError } from "@/lib/log";

type RouteContext = {
  params: Promise<{
    id: string;
    revisionId: string;
  }>;
};

/**
 * GET /api/projects/[id]/revisions/[revisionId]
 * 取某一个历史版本的**全文**。
 *
 * 为什么要单开一个接口：版本历史列表只返回「时间 / 原因 / 字数」，
 * 不返回正文（一章几万字 × 30 条，一次就是上兆的响应）。
 * 用户点开哪一条，才取哪一条的全文。
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id: projectId, revisionId } = await context.params;
    const user = await requireUser();

    const access = await checkProjectAccess(projectId, user.id);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error, code: API_ERROR_CODES.access },
        { status: access.status }
      );
    }

    const revision = await prisma.revision.findUnique({
      where: { id: revisionId },
      select: {
        id: true,
        chapterId: true,
        content: true,
        chars: true,
        changeReason: true,
        createdAt: true,
        chapter: { select: { projectId: true } },
      },
    });

    // 版本必须属于这个作品的某一章，否则一律当不存在 ——
    // 免得拿别人的 revisionId 来试
    if (!revision || revision.chapter.projectId !== projectId) {
      return NextResponse.json(
        { error: "版本不存在", code: API_ERROR_CODES.access },
        { status: 404 }
      );
    }

    return NextResponse.json({
      id: revision.id,
      chapterId: revision.chapterId,
      content: revision.content,
      chars: revision.chars,
      changeReason: revision.changeReason,
      createdAt: revision.createdAt,
    });
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    logRouteError(error);

    return NextResponse.json(
      { error: "加载历史版本失败", code: API_ERROR_CODES.database },
      { status: 500 }
    );
  }
}
