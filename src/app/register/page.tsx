"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function RegisterPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (password.length < 8) {
      setError("密码至少 8 位");
      return;
    }

    // 确认密码在本地比对，不发给服务器——纯属防手滑打错，
    // 打错了会直接被锁在门外，非常难自查。
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "注册失败");
      }

      // 注册完自动登录一次，省得再手打一遍密码
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });

      if (result?.error) {
        setError("注册成功，但自动登录失败，请手动登录一次");
        setLoading(false);
        return;
      }

      router.push("/");
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "注册失败");
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-5">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-5 rounded-2xl bg-white p-6 shadow-sm"
      >
        <div>
          <p className="mb-2 text-sm font-medium text-blue-600">墨语编辑器</p>
          <h1 className="text-xl font-semibold">注册</h1>
          <p className="mt-1 text-sm text-slate-500">
            创建一个账号，你的作品只有自己能看到。
          </p>
        </div>

        <label className="block">
          <span className="mb-2 block text-sm font-medium">昵称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
            placeholder="笔名或昵称"
            required
          />
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-medium">邮箱</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
            autoComplete="email"
            required
          />
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-medium">密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
            placeholder="至少 8 位"
            autoComplete="new-password"
            required
          />
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-medium">确认密码</span>
          <input
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
            autoComplete="new-password"
            required
          />
        </label>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm text-white transition hover:bg-slate-700 disabled:opacity-50"
        >
          {loading ? "注册中..." : "注册并登录"}
        </button>

        <p className="text-center text-sm text-slate-500">
          已经有账号？{" "}
          <Link href="/login" className="text-blue-600">
            登录
          </Link>
        </p>
      </form>
    </main>
  );
}
