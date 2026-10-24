"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { useState } from "react";

/**
 * 右上角的「当前登录用户 + 账号设置 + 退出登录」。
 *
 * onBeforeLeave 很关键：退出登录 / 去账号设置都是一次跳转，如果这时候编辑区
 * 还有没落盘的字（防抖没到 1.2 秒），不先存一次就会丢。
 * ⚠️ 以后往这里加新的跳转入口，记得同样挂上 onBeforeLeave。
 */
export default function UserMenu({
  name,
  email,
  onBeforeLeave,
}: {
  name?: string | null;
  email?: string | null;
  onBeforeLeave?: () => unknown;
}) {
  const [leaving, setLeaving] = useState(false);

  async function handleSignOut() {
    if (leaving) {
      return;
    }

    setLeaving(true);

    try {
      await onBeforeLeave?.();
    } finally {
      await signOut({ callbackUrl: "/login" });
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1 sm:gap-2">
      <span
        className="hidden max-w-[9rem] truncate text-xs text-slate-500 sm:inline"
        title={email || undefined}
      >
        {name || email || "已登录"}
      </span>

      <Link
        href="/account"
        onClick={() => void onBeforeLeave?.()}
        className="rounded-lg px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-100 hover:text-blue-700"
      >
        账号
      </Link>

      <button
        type="button"
        onClick={handleSignOut}
        disabled={leaving}
        aria-busy={leaving}
        className="rounded-lg px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-100 hover:text-red-700 disabled:opacity-50"
      >
        {leaving ? "退出中…" : "退出登录"}
      </button>
    </div>
  );
}
