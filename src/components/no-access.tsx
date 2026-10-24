import Link from "next/link";

/**
 * 被权限拦下时的提示页（服务端组件，不含任何客户端状态）。
 *
 * 刻意写清「是无权访问，不是页面坏了」——不然改 URL 发现打不开，
 * 很容易误以为程序出 bug 了。
 */
export default function NoAccess({
  message = "无权访问该作品",
  hint = "只有作品的所有者才能打开它。如果你确认这是自己的作品，请确认当前登录的账号是否正确。",
}: {
  message?: string;
  hint?: string;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 px-6 text-center">
      <p className="text-lg font-semibold text-slate-800">{message}</p>
      <p className="max-w-md text-sm leading-6 text-slate-500">{hint}</p>
      <Link
        href="/"
        className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-blue-700"
      >
        返回我的作品列表
      </Link>
    </main>
  );
}
