import { redirect } from "next/navigation";
import { auth } from "@/auth";
import AccountClient from "./account-client";

/**
 * 账号设置页（服务端壳子）—— 和编辑页/作品设置页同一套写法：
 * 服务端判登录，客户端负责交互。
 */
export default async function AccountPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  return (
    <AccountClient
      userName={session.user.name || null}
      userEmail={session.user.email || null}
    />
  );
}
