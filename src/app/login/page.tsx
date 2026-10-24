"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    setLoading(true);
    setError("");

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (result?.error) {
      setError("邮箱或密码错误");
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-5">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-5 rounded-2xl bg-white p-6 shadow-sm"
      >
        <div>
          <p className="mb-2 text-sm font-medium text-blue-600">墨语编辑器</p>
          <h1 className="text-xl font-semibold">登录</h1>
          <p className="mt-1 text-sm text-slate-500">
            登录后管理你的作品。
          </p>
        </div>

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
            autoComplete="current-password"
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
          {loading ? "登录中..." : "登录"}
        </button>

        <p className="text-center text-sm text-slate-500">
          还没有账号？{" "}
          <Link href="/register" className="text-blue-600">
            注册
          </Link>
        </p>
      </form>
    </main>
  );
}
