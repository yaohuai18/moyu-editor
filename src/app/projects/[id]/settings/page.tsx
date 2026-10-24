import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import NoAccess from "@/components/no-access";
import SettingsClient from "./settings-client";

/**
 * 作品设置页（服务端壳子）—— 与编辑页同一套拦截逻辑
 */
export default async function ProjectSettingsPage({
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
    <SettingsClient
      userName={session.user.name || null}
      userEmail={session.user.email || null}
    />
  );
}
