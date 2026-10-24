"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import UserMenu from "@/components/user-menu";
import { PROJECT_PAGE_SIZE } from "@/lib/pagination";

type Project = {
  id: string;
  title: string;
  description: string | null;
  genre: string | null;
  updatedAt: string;
  _count: {
    chapters: number;
  };
};

type ProjectsResponse = {
  items: Project[];
  total: number;
  hasMore: boolean;
};

export default function HomeClient({
  userName,
  userEmail,
  initialProjects,
  initialTotal,
  initialHasMore,
}: {
  userName: string | null;
  userEmail: string | null;
  initialProjects: Project[];
  initialTotal: number;
  initialHasMore: boolean;
}) {
  const router = useRouter();

  // 首屏列表由服务端查好传进来（见 page.tsx），所以这里既没有
  // 「挂载后再请求一次」的 effect，也没有加载中转圈：
  // 页面打开就是成品。列表之后只在新建作品 / 加载更多时才重新拉。
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [total, setTotal] = useState(initialTotal);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingMore, setLoadingMore] = useState(false);
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("都市");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  /**
   * 拉列表。
   *
   * 服务端首屏和这个接口用的是同一个页大小（src/lib/pagination.ts），
   * 不一致会出现「首屏 24 部，点加载更多时第 25 部被跳过」。
   */
  async function fetchProjects(offset: number): Promise<ProjectsResponse> {
    const response = await fetch(
      `/api/projects?limit=${PROJECT_PAGE_SIZE}&offset=${offset}`,
      { cache: "no-store" }
    );

    // 会话过期就别在这儿报错了，直接回登录页
    if (response.status === 401) {
      router.replace("/login");
      throw new Error("请先登录");
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "加载失败");
    }

    return data;
  }

  /** 重新拉第一页（新建作品后用） */
  async function refreshProjects() {
    const data = await fetchProjects(0);

    setProjects(data.items ?? []);
    setTotal(data.total ?? 0);
    setHasMore(Boolean(data.hasMore));
  }

  async function loadMore() {
    if (loadingMore) {
      return;
    }

    setLoadingMore(true);
    setError("");

    try {
      const data = await fetchProjects(projects.length);

      // 按 id 去重：万一期间在别处删了作品，分页窗口会错位，
      // 直接拼上去会出现重复卡片
      setProjects((prev) => {
        const seen = new Set(prev.map((item) => item.id));

        return [...prev, ...(data.items ?? []).filter((item) => !seen.has(item.id))];
      });
      setTotal(data.total ?? 0);
      setHasMore(Boolean(data.hasMore));
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();

    if (creating) {
      return;
    }

    if (!title.trim()) {
      setError("请输入作品名称");
      return;
    }

    setCreating(true);
    setError("");

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          genre,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "创建失败");
      }

      setTitle("");
      await refreshProjects();
    } catch (error) {
      setError(error instanceof Error ? error.message : "创建失败");
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 px-5 py-10 text-slate-900 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <header className="mb-10">
          <div className="mb-2 flex items-start justify-between gap-4">
            <p className="text-sm font-medium text-blue-700">墨语编辑器</p>
            <UserMenu name={userName} email={userEmail} />
          </div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            小说创作工作台
          </h1>
          <p className="mt-3 text-slate-600">
            改善可读性、人物表达和叙事节奏，保留作者自己的声音。
          </p>
        </header>

        <section className="mb-10 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="mb-4 text-lg font-semibold">创建新作品</h2>

          <form
            onSubmit={createProject}
            className="grid gap-4 md:grid-cols-[1fr_180px_auto]"
          >
            <div>
              {/* placeholder 不是标签：读屏软件念不出「这里要填什么」，
                  所以给它一个真实的（视觉隐藏）label */}
              <label htmlFor="new-project-title" className="sr-only">
                作品名称
              </label>
              <input
                id="new-project-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="请输入作品名称"
                maxLength={100}
                className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </div>

            <div>
              <label htmlFor="new-project-genre" className="sr-only">
                作品类型
              </label>
              <select
                id="new-project-genre"
                value={genre}
                onChange={(event) => setGenre(event.target.value)}
                className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
              >
                <option>都市</option>
                <option>悬疑</option>
                <option>言情</option>
                <option>科幻</option>
                <option>历史</option>
                <option>奇幻</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={creating}
              aria-busy={creating}
              className="rounded-xl bg-blue-600 px-6 py-3 font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creating ? "创建中..." : "创建作品"}
            </button>
          </form>

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
            >
              ⚠ {error}
            </p>
          )}
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">我的作品</h2>
            <span className="text-sm text-slate-600">
              共 {total} 部
              {projects.length < total ? `（已显示 ${projects.length} 部）` : ""}
            </span>
          </div>

          {projects.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center text-slate-600">
              还没有作品，先创建一部小说吧。
            </div>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {projects.map((project) => (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                  >
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <h3 className="font-semibold">{project.title}</h3>
                      <span className="shrink-0 rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-700">
                        {project.genre || "未分类"}
                      </span>
                    </div>

                    <p className="text-sm text-slate-600">
                      {project.description || "暂无作品简介"}
                    </p>

                    <div className="mt-6 text-sm text-slate-500">
                      {project._count.chapters} 个章节
                    </div>
                  </Link>
                ))}
              </div>

              {hasMore && (
                <div className="mt-6 flex justify-center">
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    aria-busy={loadingMore}
                    className="rounded-xl border border-slate-300 bg-white px-6 py-2.5 text-sm text-slate-700 transition hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
                  >
                    {loadingMore
                      ? "加载中…"
                      : `加载更多（还有 ${total - projects.length} 部）`}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
