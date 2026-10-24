import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authFailureResponse,
  checkProjectAccess,
  requireUser,
} from "@/lib/require-user";
import { API_ERROR_CODES, logRouteError } from "@/lib/log";
import {
  buildProjectExport,
  buildProjectExportFilename,
  contentDispositionHeader,
  EXPORT_CONTENT_TYPES,
  parseExportFormat,
} from "@/lib/export";

/**
 * GET /api/projects/[id]/export?format=txt|md
 * 全书导出：响应体直接就是文件，浏览器弹下载，不留在页面上。
 *
 * 为什么是 GET 而不是 POST：
 * 「导出」是幂等的读取动作，GET 才能用 <a download>、才能复制链接、
 * 才能被浏览器原生下载管理器接手。用 POST 得在前端拼 Blob，
 * 整本书（可能几十万字）全压在页面内存里，没必要。
 *
 * 格式不认识时按 txt 处理而不是报错：导出是「把东西给我」，
 * 因为参数拼错就什么都不给，体验最差。
 */
export async function GET(
  request: NextRequest,
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

    const format = parseExportFormat(request.nextUrl.searchParams.get("format"));

    // orderIndex 有并列的可能（老数据搬过），拿 createdAt 兜一下，
    // 保证同一个 orderIndex 下顺序也是稳定的
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        chapters: {
          orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
          select: { title: true, content: true, orderIndex: true },
        },
      },
    });

    if (!project) {
      return NextResponse.json({ error: "作品不存在" }, { status: 404 });
    }

    const filename = buildProjectExportFilename(project.title, format);
    const body = buildProjectExport(project, project.chapters, format);

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": EXPORT_CONTENT_TYPES[format],
        "Content-Disposition": contentDispositionHeader(filename),
        // 导出内容是编辑中的实时数据，任何一层缓存都会给出旧稿
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    logRouteError(error);

    return NextResponse.json({ error: "导出作品失败" }, { status: 500 });
  }
}
