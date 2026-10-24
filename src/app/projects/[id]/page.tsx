import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import NoAccess from "@/components/no-access";
import EditorClient from "./editor-client";

/**
 * 作品编辑页（服务端壳子）
 *
 * 这里做两层拦截，客户端一进来就必然是「自己的作品」：
 * 1. 没登录 → 直接踢到登录页
 * 2. 作品不属于当前用户 → 显示「无权访问该作品」
 *
 * 接口层还有一道独立的校验，两层都在，改 URL 走不通。
 */
export default async function ProjectEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const project = await prisma.project.findUnique({
    where: { id },
    select: { userId: true },
  });

  if (!project) {
    return (
      <NoAccess
        message="作品不存在"
        hint="这个作品可能已经被删除，或者链接地址不对。"
      />
    );
  }

  if (project.userId !== session.user.id) {
    return <NoAccess />;
  }

  return (
    <EditorClient
      userName={session.user.name || null}
      userEmail={session.user.email || null}
    />
  );
}
