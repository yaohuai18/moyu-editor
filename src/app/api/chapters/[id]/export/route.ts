import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authFailureResponse,
  checkChapterAccess,
  requireUser,
} from "@/lib/require-user";
import { API_ERROR_CODES, logRouteError } from "@/lib/log";
import {
  buildChapterExport,
  buildChapterExportFilename,
  contentDispositionHeader,
  EXPORT_CONTENT_TYPES,
  parseExportFormat,
} from "@/lib/export";

/**
 * GET /api/chapters/[id]/export?format=txt|md
 * 单章导出。行为和全书导出一致，只是范围小一圈：只给这一章。
 *
 * 单章单独做一个接口，而不是让前端调全书接口再切：
 * 用户点「导出这一章」时，可能只是想把单章发给朋友看，
 * 没必要为了一章把整本书都生成一遍再丢掉。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await requireUser();

    const access = await checkChapterAccess(id, user.id);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error, code: API_ERROR_CODES.access },
        { status: access.status }
      );
    }

    const format = parseExportFormat(request.nextUrl.searchParams.get("format"));

    // 书名要进文件名，所以顺着章节把作品标题一起带出来
    const chapter = await prisma.chapter.findUnique({
      where: { id: access.chapter.id },
      select: {
        title: true,
        content: true,
        orderIndex: true,
        project: { select: { title: true } },
      },
    });

    if (!chapter) {
      return NextResponse.json({ error: "章节不存在" }, { status: 404 });
    }

    const filename = buildChapterExportFilename(
      chapter.project.title,
      chapter,
      format
    );
    const body = buildChapterExport(chapter, format);

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": EXPORT_CONTENT_TYPES[format],
        "Content-Disposition": contentDispositionHeader(filename),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    logRouteError(error);

    return NextResponse.json({ error: "导出章节失败" }, { status: 500 });
  }
}
