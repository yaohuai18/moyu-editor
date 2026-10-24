import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PROJECT_PAGE_SIZE } from "@/lib/pagination";
import HomeClient from "./home-client";

/**
 * 首页（服务端壳子）
 *
 * 客户端组件读不到会话，所以这里先拦住没登录的人，
 * 再把「用户信息 + 作品列表首页」一起交给下面的客户端组件。
 *
 * 作品列表在服务端直接查库、跟 HTML 一起发出去，有两个好处：
 *   1. 打开首页不用先转圈再出内容，看着不闪；
 *   2. 客户端不需要「挂载后再请求一次」的 effect，少一处竞态和一次往返。
 *
 * 只查第一页（PROJECT_PAGE_SIZE 部），剩下的点「加载更多」再走
 * /api/projects?offset=... —— 页大小必须和接口一致，否则会出现
 * 「第 25 部被跳过」这种错位（数字的唯一出处是 src/lib/pagination.ts）。
 *
 * 排序必须跟 `/api/projects` 一致（updatedAt 倒序），
 * 否则新建作品后重新拉列表，顺序会和首屏对不上。
 */
export default async function HomePage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where: { userId: session.user.id },
      select: {
        id: true,
        title: true,
        description: true,
        genre: true,
        updatedAt: true,
        _count: { select: { chapters: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: PROJECT_PAGE_SIZE,
    }),
    prisma.project.count({ where: { userId: session.user.id } }),
  ]);

  // Date 对象过不了 Server → Client 的序列化边界，先转成字符串
  const initialProjects = projects.map((project) => ({
    ...project,
    updatedAt: project.updatedAt.toISOString(),
  }));

  return (
    <HomeClient
      userName={session.user.name || null}
      userEmail={session.user.email || null}
      initialProjects={initialProjects}
      initialTotal={total}
      initialHasMore={initialProjects.length < total}
    />
  );
}
