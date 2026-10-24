"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import UserMenu from "@/components/user-menu";
import { redirectToLogin } from "@/lib/client-nav";

type AccountInfo = {
  name: string | null;
  email: string;
  createdAt: string;
  stats: {
    projects: number;
    chapters: number;
    revisions: number;
    aiUsages: number;
  };
};

export default function AccountClient({
  userName,
  userEmail,
}: {
  userName: string | null;
  userEmail: string | null;
}) {
  const router = useRouter();

  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // 改昵称
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameMessage, setNameMessage] = useState("");
  const [nameError, setNameError] = useState("");

  // 改密码
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState("");
  const [passwordError, setPasswordError] = useState("");

  // 注销账号
  const [deleteEmail, setDeleteEmail] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  /**
   * 首屏拉一次账号信息。
   *
   * 写成 effect 里的 IIFE，而不是调用外面包好的 useCallback —— 两个原因：
   * 1. 包成 useCallback 再在 effect 里调，会被 React 的 lint 规则判成
   *    「在 effect 里同步 setState」（它看不出 setState 在 await 之后）；
   * 2. 这个函数除了挂载时拉一次，没有第二个调用方，包成 useCallback 纯属多余。
   * 编辑页拉作品用的是同一种写法，保持一致。
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/account", { cache: "no-store" });

        if (response.status === 401) {
          redirectToLogin();
          return;
        }

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "加载账号信息失败");
        }

        // 组件已经卸载了就别再 setState（切页面时会出现）
        if (cancelled) {
          return;
        }

        setInfo(data);
        setName(data.name || "");
      } catch (error) {
        if (cancelled) {
          return;
        }

        setLoadError(error instanceof Error ? error.message : "加载账号信息失败");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /** 改昵称 */
  async function saveName(event: React.FormEvent) {
    event.preventDefault();

    if (savingName) {
      return;
    }

    if (!name.trim()) {
      setNameError("昵称不能为空");
      return;
    }

    setSavingName(true);
    setNameMessage("");
    setNameError("");

    try {
      const response = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "保存失败");
      }

      setInfo((prev) => (prev ? { ...prev, name: data.name } : prev));
      setNameMessage("昵称已更新（下次刷新页面后，顶部显示的就是新昵称）");
    } catch (error) {
      setNameError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSavingName(false);
    }
  }

  /** 改密码 */
  async function savePassword(event: React.FormEvent) {
    event.preventDefault();

    if (savingPassword) {
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError("新密码至少 8 位");
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError("两次输入的新密码不一致");
      return;
    }

    setSavingPassword(true);
    setPasswordMessage("");
    setPasswordError("");

    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "修改密码失败");
      }

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordMessage(
        "密码已修改。所有设备（包括这一个）的登录状态都已失效，正在跳转登录页…"
      );

      // 服务端把会话代次 +1 了，当前这份 Cookie 已经无效 —— 老老实实重新登录，
      // 顺便也让用户确认一遍新密码记得住
      window.setTimeout(() => {
        void signOut({ callbackUrl: "/login" });
      }, 2000);
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "修改密码失败");
    } finally {
      setSavingPassword(false);
    }
  }

  /** 注销账号：连同全部数据一起删 */
  async function deleteAccount(event: React.FormEvent) {
    event.preventDefault();

    if (!info || deleting) {
      return;
    }

    if (deleteEmail.trim().toLowerCase() !== info.email.toLowerCase()) {
      setDeleteError("输入的邮箱与当前账号不一致，为避免误操作，请重新输入");
      return;
    }

    const confirmed = window.confirm(
      `确定要注销账号 ${info.email} 吗？\n\n` +
        `账号下的 ${info.stats.projects} 部作品、${info.stats.chapters} 个章节、` +
        `${info.stats.revisions} 条版本历史和 ${info.stats.aiUsages} 条 AI 使用记录\n` +
        "都会一并删除，且无法恢复。这个操作不可撤销。"
    );

    if (!confirmed) {
      return;
    }

    setDeleting(true);
    setDeleteError("");

    try {
      const response = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: deletePassword }),
      });

      const data = await response.json().catch(() => ({}));

      if (response.status === 401) {
        redirectToLogin();
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || "注销账号失败");
      }

      // 账号已经没了，直接登出（signOut 只是清 Cookie，不会报错）
      await signOut({ callbackUrl: "/login" });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "注销账号失败");
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <main
        role="status"
        aria-live="polite"
        className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-600"
      >
        正在载入账号信息…
      </main>
    );
  }

  if (!info) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-6">
        <p role="alert" className="text-sm font-medium text-red-700">
          ⚠ {loadError || "加载账号信息失败"}
        </p>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          重试
        </button>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-5">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="rounded-lg px-2 py-1 text-sm text-slate-600 hover:text-blue-700"
            >
              ← 返回作品列表
            </Link>

            <div className="h-5 w-px bg-slate-200" />

            <h1 className="font-semibold">账号设置</h1>
          </div>

          <UserMenu name={userName} email={userEmail} />
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-8 p-5 md:p-8">
        {/* 账号信息 */}
        <section className="rounded-2xl bg-white p-6 shadow-sm md:p-8">
          <h2 className="text-lg font-semibold">账号信息</h2>

          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex gap-3">
              <dt className="w-24 shrink-0 text-slate-600">邮箱（登录名）</dt>
              <dd className="text-slate-800">{info.email}</dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-24 shrink-0 text-slate-600">注册时间</dt>
              <dd className="text-slate-800">
                {new Date(info.createdAt).toLocaleString("zh-CN", {
                  hour12: false,
                })}
              </dd>
            </div>
          </dl>

          <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-6 text-slate-600">
            邮箱暂时不支持修改：它是账号的唯一标识，作品、版本历史都挂在它下面，
            换邮箱等于换账号。真有需要请先导出正文再重新注册。
          </p>

          <form onSubmit={saveName} className="mt-6 space-y-3">
            <label className="block">
              <span className="mb-2 block text-sm font-medium">昵称</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={50}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
                placeholder="显示在页面右上角"
              />
            </label>

            {nameError && (
              <p
                role="alert"
                className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700"
              >
                ⚠ {nameError}
              </p>
            )}

            {nameMessage && (
              <p
                role="status"
                aria-live="polite"
                className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800"
              >
                {nameMessage}
              </p>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingName}
                aria-busy={savingName}
                className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm text-white transition hover:bg-slate-700 disabled:opacity-50"
              >
                {savingName ? "保存中…" : "保存昵称"}
              </button>
            </div>
          </form>
        </section>

        {/* 数据概况 */}
        <section className="rounded-2xl bg-white p-6 shadow-sm md:p-8">
          <h2 className="text-lg font-semibold">我的数据</h2>
          <p className="mt-1 text-sm text-slate-600">
            这些数字只统计你自己的数据（下面注销账号时会用到）。
          </p>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="作品" value={info.stats.projects} />
            <Stat label="章节" value={info.stats.chapters} />
            <Stat label="历史版本" value={info.stats.revisions} />
            <Stat label="AI 调用次数" value={info.stats.aiUsages} />
          </div>
        </section>

        {/* 改密码 */}
        <section className="rounded-2xl bg-white p-6 shadow-sm md:p-8">
          <h2 className="text-lg font-semibold">修改密码</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            改完之后，所有设备上的登录状态都会立刻失效（包括你正在用的这个），
            需要用新密码重新登录一次。
          </p>

          <form onSubmit={savePassword} className="mt-5 space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium">当前密码</span>
              <input
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-sm font-medium">
                  新密码（至少 8 位）
                </span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-medium">
                  再输一次新密码
                </span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
                />
              </label>
            </div>

            {passwordError && (
              <p
                role="alert"
                className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700"
              >
                ⚠ {passwordError}
              </p>
            )}

            {passwordMessage && (
              <p
                role="status"
                aria-live="polite"
                className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800"
              >
                {passwordMessage}
              </p>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingPassword}
                aria-busy={savingPassword}
                className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm text-white transition hover:bg-slate-700 disabled:opacity-50"
              >
                {savingPassword ? "提交中…" : "修改密码"}
              </button>
            </div>
          </form>
        </section>

        {/* 注销账号 */}
        <section className="rounded-2xl border border-red-200 bg-white p-6 shadow-sm md:p-8">
          <h2 className="text-lg font-semibold text-red-800">注销账号</h2>

          <p className="mt-2 text-sm leading-6 text-slate-700">
            <strong className="font-semibold">
              注销账号后，作品、章节、版本历史和 AI 使用记录将无法恢复。
            </strong>
            这是永久删除，我们不做回收站，也没有人工找回的途径。
          </p>

          <p className="mt-2 text-sm text-slate-700">
            当前账号会被删除的内容：
            <span className="ml-1 font-medium">
              {info.stats.projects} 部作品、{info.stats.chapters} 个章节、
              {info.stats.revisions} 条版本历史、{info.stats.aiUsages} 条 AI 使用记录
            </span>
            。
          </p>

          <form onSubmit={deleteAccount} className="mt-5 space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-800">
                输入你的邮箱「{info.email}」以确认
              </span>
              <input
                value={deleteEmail}
                onChange={(event) => setDeleteEmail(event.target.value)}
                placeholder={info.email}
                autoComplete="off"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-red-400 focus:ring-4 focus:ring-red-50"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-800">
                输入当前密码
              </span>
              <input
                type="password"
                value={deletePassword}
                onChange={(event) => setDeletePassword(event.target.value)}
                autoComplete="current-password"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-red-400 focus:ring-4 focus:ring-red-50"
              />
            </label>

            {deleteError && (
              <p
                role="alert"
                className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700"
              >
                ⚠ {deleteError}
              </p>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={
                  deleting ||
                  deleteEmail.trim().toLowerCase() !== info.email.toLowerCase() ||
                  !deletePassword
                }
                aria-busy={deleting}
                className="rounded-lg bg-red-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deleting ? "注销中…" : "永久注销账号并删除全部数据"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-slate-50 px-4 py-3">
      <p className="text-xs leading-5 text-slate-600">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-800">
        {value.toLocaleString("zh-CN")}
      </p>
    </div>
  );
}
