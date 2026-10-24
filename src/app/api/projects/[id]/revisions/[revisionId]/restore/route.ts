import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authFailureResponse,
  checkProjectAccess,
  requireUser,
} from "@/lib/require-user";
import { countWords } from "@/lib/wordCount";
import { API_ERROR_CODES, logRouteError } from "@/lib/log";

type RouteContext = {
  params: Promise<{
    id: string;
    revisionId: string;
  }>;
};

/**
 * POST /api/projects/[id]/revisions/[revisionId]/restore
 * 把某个历史版本的内容恢复成当前正文；同时把这次恢复本身也记成一个新版本
 */
export async function POST(_request: Request, context: RouteContext) {
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
      include: { chapter: true },
    });

    // 版本必须属于这个作品的某一章，否则一律当不存在，
    // 免得拿别人的 revisionId 来试
    if (!revision || revision.chapter.projectId !== projectId) {
      return NextResponse.json({ error: "版本不存在" }, { status: 404 });
    }

    const restoredChars = countWords(revision.content);

    const restoredChapter = await prisma.$transaction(async (tx) => {
      const updatedChapter = await tx.chapter.update({
        where: { id: revision.chapterId },
        data: {
          content: revision.content,
          wordCount: restoredChars,
          // 回滚也是一次写入，版本号必须跟着走 ——
          // 否则另一个标签页拿着旧版本号还能把这次回滚覆盖掉。
          version: { increment: 1 },
        },
      });

      await tx.revision.create({
        data: {
          chapterId: revision.chapterId,
          userId: user.id,
          content: revision.content,
          chars: restoredChars,
          changeReason: "从历史版本恢复",
        },
      });

      await tx.project.update({
        where: { id: projectId },
        data: { updatedAt: new Date() },
      });

      return updatedChapter;
    });

    return NextResponse.json(restoredChapter);
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    logRouteError(error);

    return NextResponse.json({ error: "恢复版本失败" }, { status: 500 });
  }
}
