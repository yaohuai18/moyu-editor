import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { authFailureResponse, requireUser } from "@/lib/require-user";
import { verifyPassword } from "@/lib/password";
import { API_ERROR_CODES, logError, logRouteError } from "@/lib/log";

const updateAccountSchema = z.object({
  name: z.string().trim().min(1, "昵称不能为空").max(50),
});

const deleteAccountSchema = z.object({
  /** 注销是不可逆操作，光有登录态不够，必须再输一次密码 */
  password: z.string().min(1).max(100),
});

/**
 * GET /api/account
 * 账号资料 + 数据概况。
 *
 * 概况是给「注销账号」这一步用的：删之前先让用户看清楚会删掉多少东西，
 * 而不是只弹一句「确定吗」。
 */
export async function GET() {
  try {
    const user = await requireUser();

    const [projects, chapters, revisions, aiUsages] = await Promise.all([
      prisma.project.count({ where: { userId: user.id } }),
      prisma.chapter.count({ where: { project: { userId: user.id } } }),
      prisma.revision.count({ where: { chapter: { project: { userId: user.id } } } }),
      // 只数成功的调用 —— 台账里还有失败和被限流的记录（第十一阶段加的），
      // 那些没真的调用模型，不该算成用户「用了几次」
      prisma.aiUsage.count({ where: { userId: user.id, ok: true } }),
    ]);

    return NextResponse.json({
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      stats: { projects, chapters, revisions, aiUsages },
    });
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    logRouteError(error);

    return NextResponse.json(
      { error: "加载账号信息失败", code: API_ERROR_CODES.database },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/account
 * 改昵称（邮箱不允许改 —— 它是登录名，改邮箱等于换账号，会牵扯数据归属，
 * 真要做应该走「先验证新邮箱，再迁移」的流程，不放在这一步）。
 */
export async function PATCH(request: NextRequest) {
  try {
    const user = await requireUser();

    const body = await request.json();
    const data = updateAccountSchema.parse(body);

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { name: data.name },
      select: { name: true, email: true },
    });

    console.log(
      `[ACCOUNT_UPDATED] ${JSON.stringify({ userId: user.id })}`
    );

    return NextResponse.json(updated);
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "昵称需为 1-50 个字", code: API_ERROR_CODES.validation },
        { status: 400 }
      );
    }

    logRouteError(error);

    return NextResponse.json(
      { error: "保存账号信息失败", code: API_ERROR_CODES.database },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/account
 * 注销账号：连同作品、章节、版本历史、人物卡、风格档案、AI 用量台账一起删。
 *
 * 数据是靠数据库的级联外键删干净的（见 prisma/schema.prisma，各关联都是
 * onDelete: Cascade），不是在这里一条条手动删 —— 手写删除顺序很容易漏表，
 * 留下孤儿数据。删完会打一条 [ACCOUNT_DELETED] 日志，记下删掉了多少东西，
 * 万一有人误注销，至少能从日志里看出规模。
 */
export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser();

    const body = await request.json().catch(() => ({}));
    const data = deleteAccountSchema.parse(body);

    // 账号没有密码（不该出现）时，不允许注销 —— 否则任何人都能删掉它
    if (!user.passwordHash) {
      return NextResponse.json(
        {
          error: "该账号没有设置密码，无法自助注销，请联系管理员",
          code: API_ERROR_CODES.validation,
        },
        { status: 400 }
      );
    }

    const valid = await verifyPassword(data.password, user.passwordHash);

    if (!valid) {
      logError("PASSWORD_MISMATCH", {
        userId: user.id,
        status: 400,
        detail: "delete-account",
      });

      return NextResponse.json(
        { error: "密码不正确，账号未删除", code: API_ERROR_CODES.credentials },
        { status: 400 }
      );
    }

    // 先数一遍再删，日志里才有「删掉了多少」这个信息
    const summary = {
      userId: user.id,
      projects: await prisma.project.count({ where: { userId: user.id } }),
      chapters: await prisma.chapter.count({
        where: { project: { userId: user.id } },
      }),
      revisions: await prisma.revision.count({
        where: { chapter: { project: { userId: user.id } } },
      }),
      aiUsages: await prisma.aiUsage.count({ where: { userId: user.id } }),
    };

    await prisma.user.delete({ where: { id: user.id } });

    console.log(`[ACCOUNT_DELETED] ${JSON.stringify(summary)}`);

    return NextResponse.json({ ok: true, deleted: summary });
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "请输入当前密码", code: API_ERROR_CODES.validation },
        { status: 400 }
      );
    }

    logRouteError(error);

    return NextResponse.json(
      { error: "注销账号失败，账号未做任何改动", code: API_ERROR_CODES.database },
      { status: 500 }
    );
  }
}
