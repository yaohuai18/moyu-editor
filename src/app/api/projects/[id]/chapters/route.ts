import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authFailureResponse,
  checkProjectAccess,
  requireUser,
} from "@/lib/require-user";
import { API_ERROR_CODES, logRouteError } from "@/lib/log";

/**
 * POST /api/projects/[id]/chapters
 * 新建章节，自动排在最后
 */
export async function POST(
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

    let title: string | null = null;
    try {
      const body = await request.json();
      if (typeof body?.title === "string" && body.title.trim()) {
        title = body.title.trim().slice(0, 100);
      }
    } catch {
      // 允许不带 body
    }

    const count = await prisma.chapter.count({ where: { projectId: id } });

    const chapter = await prisma.chapter.create({
      data: {
        projectId: id,
        title: title ?? `第${count + 1}章`,
        content: "",
        orderIndex: count,
        wordCount: 0,
      },
    });

    await prisma.project.update({
      where: { id },
      data: { updatedAt: new Date() },
    });

    return NextResponse.json(chapter, { status: 201 });
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    logRouteError(error);

    return NextResponse.json({ error: "新建章节失败" }, { status: 500 });
  }
}

/**
 * PUT /api/projects/[id]/chapters
 * 批量调整章节顺序（第三阶段做拖拽排序时用，现在先留着）
 */
export async function PUT(
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

    let orderedIds: string[] = [];
    try {
      const body = await request.json();
      if (Array.isArray(body?.orderedIds)) {
        orderedIds = body.orderedIds.filter((v: unknown) => typeof v === "string");
      }
    } catch {
      // ignore
    }

    if (orderedIds.length === 0) {
      return NextResponse.json({ error: "缺少 orderedIds" }, { status: 400 });
    }

    const chapters = await prisma.chapter.findMany({
      where: { projectId: id },
      select: { id: true },
    });
    const ownIds = new Set(chapters.map((c) => c.id));

    if (!orderedIds.every((cid) => ownIds.has(cid))) {
      return NextResponse.json({ error: "章节不属于该作品" }, { status: 400 });
    }

    await prisma.$transaction(
      orderedIds.map((cid, index) =>
        prisma.chapter.update({
          where: { id: cid },
          data: { orderIndex: index },
        })
      )
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    logRouteError(error);

    return NextResponse.json({ error: "调整章节顺序失败" }, { status: 500 });
  }
}
