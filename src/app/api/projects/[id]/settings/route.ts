import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authFailureResponse,
  checkProjectAccess,
  requireUser,
} from "@/lib/require-user";
import { z } from "zod";
import { API_ERROR_CODES, logRouteError } from "@/lib/log";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const settingsSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  genre: z.string().max(50).optional(),
  tone: z.string().max(100).optional(),
  viewpoint: z.string().max(100).optional(),
  sentenceStyle: z.string().max(200).optional(),
  /**
   * 禁用词（P1-2 起开放写入，来源可以是手填或文风蒸馏的建议）。
   * 上限 500 字是为了让它保持「一列短词」的样子，
   * 真有人往里塞一篇小作文，提示词预算会被它吃掉。
   */
  forbiddenWords: z.string().max(500).optional(),
});

/**
 * PATCH /api/projects/[id]/settings
 * 保存作品基本信息 + 风格档案。
 *
 * 注意：本接口只改 title / description / genre 与风格档案的
 * tone / viewpoint / sentenceStyle / forbiddenWords 这些字段，
 * 风格档案里的 description（风格备注）不在入参里，因此**不会被清空**。
 * forbiddenWords 也遵循「不传就不动」：老客户端或只改标题的请求
 * 不会顺手把作者攒的禁用词表抹掉。
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const user = await requireUser();

    const access = await checkProjectAccess(id, user.id);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error, code: API_ERROR_CODES.access },
        { status: access.status }
      );
    }

    const body = await request.json();
    const data = settingsSchema.parse(body);

    const updatedProject = await prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: {
          id,
        },
        data: {
          title: data.title,
          description: data.description || null,
          genre: data.genre || null,
        },
      });

      await tx.styleProfile.upsert({
        where: {
          projectId: id,
        },
        create: {
          projectId: id,
          tone: data.tone || null,
          viewpoint: data.viewpoint || null,
          sentenceStyle: data.sentenceStyle || null,
          forbiddenWords: data.forbiddenWords || null,
        },
        update: {
          tone: data.tone || null,
          viewpoint: data.viewpoint || null,
          sentenceStyle: data.sentenceStyle || null,
          // 不传就保持原值（见文件头注释）
          ...(data.forbiddenWords === undefined
            ? {}
            : { forbiddenWords: data.forbiddenWords || null }),
        },
      });

      return updated;
    });

    const result = await prisma.project.findUnique({
      where: {
        id: updatedProject.id,
      },
      include: {
        styleProfile: true,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "作品设置格式不正确" },
        { status: 400 }
      );
    }

    logRouteError(error);

    return NextResponse.json({ error: "保存作品设置失败" }, { status: 500 });
  }
}
