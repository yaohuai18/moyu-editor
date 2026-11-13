import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authFailureResponse,
  checkChapterAccess,
  requireUser,
} from "@/lib/require-user";
import { countWords } from "@/lib/wordCount";
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
     * 乐观锁（原子版）。
     *
     * 场景：同一个章节在两个标签页（或两台设备）里都打开了，
     * 右边那个先保存，左边这个拿着旧内容再保存一次 —— 结果右边写的字全没了。
     *
     * 旧写法是「先查版本 → 比一比 → 再 UPDATE」，检查与写入之间有空档：
     * 两个并发请求都能通过检查，后写的静默覆盖先写的，版本号形同虚设。
     * 现在把版本条件直接写进 UPDATE 的 where 里，由数据库保证同一版本
     * 只有一个请求能写成功，另一个拿到 0 行受影响，按 409 处理。
     *
     * 不传 version 的调用方（脚本、旧客户端）跳过版本条件，行为与以前一致。
     * 冲突时**不合并、不覆盖**：把当前版本号回给前端，让用户自己决定。
     */

    const update: { title?: string; content?: string; wordCount?: number } = {};

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

    const expectedVersion = data.version;
    const nextContent = update.content ?? chapter.content;

    const outcome = await prisma.$transaction(async (tx) => {
      // 条件更新：只有库里版本还等于客户端看到的版本时才写得进去。
      // 这一步是乐观锁真正生效的地方，不能挪到事务外面。
      const claimed = await tx.chapter.updateMany({
        where: expectedVersion === undefined ? { id } : { id, version: expectedVersion },
        data: {
          ...update,
          // 版本号只在真的写入时前进
          version: { increment: 1 },
        },
      });

      if (claimed.count === 0) {
        // 没抢到这一版：别人先写了，整个事务不做任何改动
        return { ok: false as const };
      }

      const updated = await tx.chapter.findUniqueOrThrow({ where: { id } });

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

      return { ok: true as const, chapter: updated };
    });

    if (!outcome.ok) {
      // 冲突时读一下服务器当前版本，回给前端让它带着新版本号重试或合并
      const current = await prisma.chapter.findUnique({
        where: { id },
        select: { version: true },
      });

      // 章节在访问检查之后被另一个标签页删掉了——这不是并发冲突，
      // 返回 404 而不是 409：客户端把 409 当「内容冲突」锁住编辑器，
      // 但这里应该让用户知道章节已经不存在。
      if (!current) {
        return NextResponse.json({ error: "章节不存在" }, { status: 404 });
      }

      logError("VERSION_CONFLICT", {
        userId: user.id,
        chapterId: id,
        projectId: chapter.projectId,
        status: 409,
        detail: `client=${expectedVersion} server=${current.version}`,
      });

      return NextResponse.json(
        {
          error: "内容已被更新，请刷新后确认是否合并修改",
          code: API_ERROR_CODES.conflict,
          version: current.version,
        },
        { status: 409 }
      );
    }

    return NextResponse.json(outcome.chapter);
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
