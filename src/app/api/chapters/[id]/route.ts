import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authFailureResponse,
  checkChapterAccess,
  requireUser,
} from "@/lib/require-user";
import { countWords } from "@/lib/wordCount";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { API_ERROR_CODES, logError, logRouteError } from "@/lib/log";

const patchChapterSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  content: z.string().max(500000).optional(),
  /**
   * 客户端「看到的那一版」的版本号。
   *
   * 传了 → 做乐观锁检查：和库里不一致就返回 409，不覆盖别人的新内容。
   * 不传 → 跳过检查（兼容脚本、旧客户端；调序这类不碰正文的写操作也不受影响）。
   */
  version: z.number().int().min(0).optional(),
});

/**
 * GET /api/chapters/[id]
 * 取章节全文
 */
export async function GET(
  _request: NextRequest,
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

    const chapter = await prisma.chapter.findUnique({ where: { id } });

    if (!chapter) {
      return NextResponse.json({ error: "章节不存在" }, { status: 404 });
    }

    return NextResponse.json(chapter);
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    logRouteError(error);

    return NextResponse.json({ error: "加载章节失败" }, { status: 500 });
  }
}

/**
 * PATCH /api/chapters/[id]
 * 保存章节（标题 / 正文），自动重算字数，并留一条版本记录
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const user = await requireUser();

    const access = await checkChapterAccess(id, user.id);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error, code: API_ERROR_CODES.access },
        { status: access.status }
      );
    }

    const body = await request.json();
    const data = patchChapterSchema.parse(body);

    const chapter = await prisma.chapter.findUnique({ where: { id } });

    if (!chapter) {
      return NextResponse.json({ error: "章节不存在" }, { status: 404 });
    }

    /**
     * 乐观锁检查。
     *
     * 场景：同一个章节在两个标签页（或两台设备）里都打开了，
     * 右边那个先保存，左边这个拿着旧内容再保存一次 —— 结果右边写的字全没了。
     * 有了版本号就能挡住：左边提交的 version 已经过期，直接 409。
     *
     * 注意这里**不合并、不覆盖**：我们不知道用户想留哪一份，
     * 所以把当前版本号回给前端，让用户自己刷新看清楚了再决定。
     */
    if (data.version !== undefined && data.version !== chapter.version) {
      logError("VERSION_CONFLICT", {
        userId: user.id,
        chapterId: id,
        projectId: chapter.projectId,
        status: 409,
        detail: `client=${data.version} server=${chapter.version}`,
      });

      return NextResponse.json(
        {
          error: "内容已被更新，请刷新后确认是否合并修改",
          code: API_ERROR_CODES.conflict,
          version: chapter.version,
        },
        { status: 409 }
      );
    }

    const update: Prisma.ChapterUpdateInput = {};

    if (data.title !== undefined) {
      update.title = data.title;
    }

    if (data.content !== undefined) {
      update.content = data.content;
      update.wordCount = countWords(data.content);
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "没有要更新的内容" }, { status: 400 });
    }

    const nextContent = update.content ?? chapter.content;

    const updatedChapter = await prisma.$transaction(async (tx) => {
      const updated = await tx.chapter.update({
        where: { id },
        data: {
          ...update,
          // 版本号只在真的写入时前进（上面已确认过没有冲突）
          version: { increment: 1 },
        },
      });

      // 每次保存都留档：正文改动就是历史版本。
      // userId 记的是当前登录用户，登录系统上线前这里是演示用户。
      if (data.content !== undefined) {
        await tx.revision.create({
          data: {
            chapterId: id,
            userId: user.id,
            content: nextContent as string,
            // 字数在这里算好存下来：版本历史列表只读这一列，不读全文
            chars: countWords(nextContent as string),
            changeReason: "编辑器保存",
          },
        });
      }

      // 顺带刷新作品的更新时间，让首页按「最近编辑」排序能反映出来
      await tx.project.update({
        where: { id: chapter.projectId },
        data: { updatedAt: new Date() },
      });

      return updated;
    });

    return NextResponse.json(updatedChapter);
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "输入内容不符合要求", details: error.flatten() },
        { status: 400 }
      );
    }

    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "P2025"
    ) {
      return NextResponse.json({ error: "章节不存在" }, { status: 404 });
    }

    logRouteError(error);

    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }
}

/**
 * DELETE /api/chapters/[id]
 * 删除章节
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const user = await requireUser();

    const access = await checkChapterAccess(id, user.id);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error, code: API_ERROR_CODES.access },
        { status: access.status }
      );
    }

    const chapter = await prisma.chapter.delete({ where: { id } });

    // 删完之后把后面的章节顺序补齐，避免出现空档
    const rest = await prisma.chapter.findMany({
      where: { projectId: chapter.projectId },
      orderBy: { orderIndex: "asc" },
      select: { id: true },
    });

    await prisma.$transaction(
      rest.map((c, index) =>
        prisma.chapter.update({
          where: { id: c.id },
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

    return NextResponse.json({ error: "删除失败" }, { status: 500 });
  }
}
