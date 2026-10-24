import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { authFailureResponse, requireUser } from "@/lib/require-user";
import { API_ERROR_CODES, logRouteError } from "@/lib/log";
import {
  MAX_PROJECT_PAGE_SIZE,
  PROJECT_PAGE_SIZE,
} from "@/lib/pagination";

const createProjectSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  genre: z.string().max(50).optional(),
});

/**
 * 页大小的默认值与上限来自 src/lib/pagination.ts ——
 * 首页首屏（服务端直接查库）和这个接口必须用同一个数字，否则会出现
 * 「首屏 24 部，点加载更多后第 25 部被跳过」这种错位。
 */
const DEFAULT_PROJECT_PAGE_SIZE = PROJECT_PAGE_SIZE;
const MAX_LIMIT = MAX_PROJECT_PAGE_SIZE;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * GET /api/projects?limit=24&offset=0
 * 当前登录用户的作品列表（只返回自己的），带分页。
 *
 * 响应结构是 `{ items, total, limit, offset, hasMore }`。
 * 分页不是为了现在就快多少（作品才几部），而是为了**以后不会慢**：
 * 一个人写三年攒 200 部作品时，首页不该一次全拉下来。
 *
 * 查询只 select 页面用得到的字段 —— 不要把整个 Project 行都取出来，
 * 之后加了新字段（比如草稿标记、封面）不会莫名其妙跟着变大。
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();

    const searchParams = request.nextUrl.searchParams;

    const query = listQuerySchema.parse({
      limit: searchParams.get("limit") ?? undefined,
      offset: searchParams.get("offset") ?? undefined,
    });

    const limit = query.limit ?? DEFAULT_PROJECT_PAGE_SIZE;
    const offset = query.offset ?? 0;

    const [items, total] = await Promise.all([
      prisma.project.findMany({
        where: {
          userId: user.id,
        },
        select: {
          id: true,
          title: true,
          description: true,
          genre: true,
          updatedAt: true,
          _count: {
            select: {
              chapters: true,
            },
          },
        },
        orderBy: {
          updatedAt: "desc",
        },
        take: limit,
        skip: offset,
      }),
      prisma.project.count({ where: { userId: user.id } }),
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
        { error: "分页参数不合法", code: API_ERROR_CODES.validation },
        { status: 400 }
      );
    }

    logRouteError(error);

    return NextResponse.json(
      { error: "加载作品列表失败", code: API_ERROR_CODES.database },
      { status: 500 }
    );
  }
}

/**
 * POST /api/projects
 * 新建作品，自动建第一章和空的风格档案
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();

    const body = await request.json();
    const data = createProjectSchema.parse(body);

    const project = await prisma.project.create({
      data: {
        userId: user.id,
        title: data.title,
        description: data.description,
        genre: data.genre,
        styleProfile: {
          create: {},
        },
      },
    });

    await prisma.chapter.create({
      data: {
        projectId: project.id,
        title: "第一章",
        content: "",
        orderIndex: 0,
      },
    });

    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    const unauthorized = authFailureResponse(error);

    if (unauthorized) {
      return unauthorized;
    }

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: "输入内容不符合要求",
          details: error.flatten(),
        },
        { status: 400 }
      );
    }

    logRouteError(error);

    return NextResponse.json({ error: "创建作品失败" }, { status: 500 });
  }
}
