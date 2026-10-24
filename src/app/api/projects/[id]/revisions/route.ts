import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authFailureResponse,
  checkProjectAccess,
  requireUser,
} from "@/lib/require-user";
import { z } from "zod";
import { API_ERROR_CODES, logRouteError } from "@/lib/log";
import {
  MAX_REVISION_PAGE_SIZE,
  REVISION_PAGE_SIZE,
} from "@/lib/pagination";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

/** 默认一页 10 条；上限 50，防止有人 ?limit=99999 把库拖垮 */
const DEFAULT_LIMIT = REVISION_PAGE_SIZE;
const MAX_LIMIT = MAX_REVISION_PAGE_SIZE;

const querySchema = z.object({
  chapterId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * GET /api/projects/[id]/revisions?chapterId=xxx&limit=10&offset=0
 *
 * 取某一章的历史版本列表（最新在前）。
 *
 * **只返回摘要，不返回正文**：正文放在
 * /api/projects/[id]/revisions/[revisionId] 里按需取。
 * 一章 3 万字、列 30 条的话，带上正文就是 90 万字的响应，
 * 手机上直接卡住。
 *
 * 也**不读 content 列**：字数已经存在 Revision.chars 里了。
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id: projectId } = await context.params;
    const user = await requireUser();

    const access = await checkProjectAccess(projectId, user.id);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error, code: API_ERROR_CODES.access },
        { status: access.status }
      );
    }

    const searchParams = request.nextUrl.searchParams;

    const query = querySchema.parse({
      chapterId: searchParams.get("chapterId"),
      limit: searchParams.get("limit") ?? undefined,
      offset: searchParams.get("offset") ?? undefined,
    });

    const chapter = await prisma.chapter.findFirst({
      where: {
        id: query.chapterId,
        projectId,
      },
      select: { id: true },
    });

    if (!chapter) {
      return NextResponse.json(
        { error: "章节不存在", code: API_ERROR_CODES.access },
        { status: 404 }
      );
    }

    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;

    const [items, total] = await Promise.all([
      prisma.revision.findMany({
        where: {
          chapterId: query.chapterId,
        },
        select: {
          id: true,
          changeReason: true,
          createdAt: true,
          chars: true,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: limit,
        skip: offset,
      }),
      prisma.revision.count({ where: { chapterId: query.chapterId } }),
    ]);

    return NextResponse.json({
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    });
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "缺少有效的 chapterId 参数", code: API_ERROR_CODES.validation },
        { status: 400 }
      );
    }

    logRouteError(error);

    return NextResponse.json(
      { error: "加载版本历史失败", code: API_ERROR_CODES.database },
      { status: 500 }
    );
  }
}
