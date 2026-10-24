"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * 页面级错误兜底。
 *
 * 原则：**用户看到的是「怎么办」，不是「为什么崩」。**
 * 完整报错只进浏览器控制台和部署平台日志，页面上最多给一个错误编号，
 * 方便用户报问题时我们能对上号。
 */
export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-16 text-slate-900">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-2xl">
          !
        </div>

        <h1 className="mt-4 text-xl font-semibold">页面出了点问题</h1>

        <p className="mt-3 text-sm leading-6 text-slate-500">
          这部分内容没能正常加载。你的作品和正文都存在服务器上，不会丢。
          先点「重新加载」试试，多半就好了。
        </p>

        {error.digest ? (
          <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-400">
            错误编号：{error.digest}
            <br />
            如果反复出现，把这串发给开发者
          </p>
        ) : null}

        <div className="mt-6 flex justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
          >
            重新加载
          </button>

          <Link
            href="/"
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 transition hover:border-blue-300 hover:text-blue-600"
          >
            回作品列表
          </Link>
        </div>
      </div>
    </main>
  );
}
