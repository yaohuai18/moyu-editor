import Link from "next/link";

/**
 * 404 页。地址写错、作品被删、链接过期都会走到这里。
 *
 * 不显示任何技术细节（找不到的是哪条路由之类），
 * 只给一句人话和一个出口。
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-16 text-slate-900">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-sm font-medium text-blue-600">404</p>

        <h1 className="mt-3 text-xl font-semibold">这个页面不存在</h1>

        <p className="mt-3 text-sm leading-6 text-slate-500">
          地址可能写错了，或者这个作品已经被删掉了。
          回作品列表看看，你要找的东西应该在那儿。
        </p>

        <Link
          href="/"
          className="mt-6 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          回作品列表
        </Link>
      </div>
    </main>
  );
}
