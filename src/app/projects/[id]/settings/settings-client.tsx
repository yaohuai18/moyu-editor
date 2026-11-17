"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import UserMenu from "@/components/user-menu";
import { redirectToLogin } from "@/lib/client-nav";

type ProjectSettings = {
  id: string;
  title: string;
  description: string | null;
  genre: string | null;
  styleProfile: {
    tone: string | null;
    viewpoint: string | null;
    sentenceStyle: string | null;
    forbiddenWords: string | null;
  } | null;
};

/**
 * 文风蒸馏草稿（P1-2）。
 *
 * 只建议、不落库：用户点「填入表单」后这些值才进本地 state，
 * 最终仍要按原有流程点「保存设置」。
 */
type StyleDistillDraft = {
  tone?: string;
  viewpoint?: string;
  sentenceStyle?: string;
  forbiddenWords: string[];
  summary?: string;
  sample?: { chapters: number; chars: number; truncated?: boolean };
  usage?: { used: number; limit: number; remaining: number };
};

export default function SettingsClient({
  userName,
  userEmail,
}: {
  userName: string | null;
  userEmail: string | null;
}) {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const router = useRouter();

  const [settings, setSettings] = useState<ProjectSettings | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [genre, setGenre] = useState("");
  const [tone, setTone] = useState("");
  const [viewpoint, setViewpoint] = useState("");
  const [sentenceStyle, setSentenceStyle] = useState("");
  const [forbiddenWords, setForbiddenWords] = useState("");

  /** 文风蒸馏：进行中 / 错误 / 草稿（草稿只在本地，不落库） */
  const [distilling, setDistilling] = useState(false);
  const [distillError, setDistillError] = useState("");
  const [distillDraft, setDistillDraft] = useState<StyleDistillDraft | null>(
    null
  );

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  /**
   * 删除作品。这是全站破坏性最大的操作，所以做三重门槛：
   * 1. 要手动把作品名打进来（不是勾一下复选框）；
   * 2. 再弹一次系统确认；
   * 3. 服务端还会再校验一次归属。
   * 打错一个字都不给删 —— 避免手滑。
   */
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    if (!projectId) {
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}`);
        const data = await response.json();

        if (response.status === 401) {
          redirectToLogin();
          return;
        }

        if (!response.ok) {
          throw new Error(data.error || "加载作品失败");
        }

        if (cancelled) {
          return;
        }

        setSettings(data);
        setTitle(data.title || "");
        setDescription(data.description || "");
        setGenre(data.genre || "");
        setTone(data.styleProfile?.tone || "");
        setViewpoint(data.styleProfile?.viewpoint || "");
        setSentenceStyle(data.styleProfile?.sentenceStyle || "");
        setForbiddenWords(data.styleProfile?.forbiddenWords || "");
      } catch (error) {
        if (!cancelled) {
          setError(
            error instanceof Error ? error.message : "加载作品失败"
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();

    if (!projectId || !title.trim()) {
      setError("作品名称不能为空");
      return;
    }

    setSaving(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch(`/api/projects/${projectId}/settings`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          genre: genre.trim(),
          tone: tone.trim(),
          viewpoint: viewpoint.trim(),
          sentenceStyle: sentenceStyle.trim(),
          forbiddenWords: forbiddenWords.trim(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "保存失败");
      }

      setSettings(data);
      setTitle(data.title || "");
      setDescription(data.description || "");
      setGenre(data.genre || "");
      setTone(data.styleProfile?.tone || "");
      setViewpoint(data.styleProfile?.viewpoint || "");
      setSentenceStyle(data.styleProfile?.sentenceStyle || "");
      setForbiddenWords(data.styleProfile?.forbiddenWords || "");
      setMessage("设置已保存");
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  /**
   * 从已有章节蒸馏文风（P1-2）。
   *
   * 只拿回**草稿**，绝不自动写表单、更不自动保存 ——
   * 作者点「填入表单」才进 state，最后还要自己点「保存设置」。
   * AI 可以提建议，但不能替作者决定他是什么文风。
   */
  async function distillStyle() {
    if (!projectId || distilling) {
      return;
    }

    setDistilling(true);
    setDistillError("");
    setDistillDraft(null);
    setMessage("");
    setError("");

    try {
      const response = await fetch(
        `/api/projects/${projectId}/distill-style`,
        { method: "POST" }
      );

      const data = await response.json().catch(() => ({}));

      if (response.status === 401) {
        redirectToLogin();
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || "文风提取失败");
      }

      setDistillDraft({
        tone: typeof data.tone === "string" ? data.tone : undefined,
        viewpoint:
          typeof data.viewpoint === "string" ? data.viewpoint : undefined,
        sentenceStyle:
          typeof data.sentenceStyle === "string" ? data.sentenceStyle : undefined,
        forbiddenWords: Array.isArray(data.forbiddenWords)
          ? data.forbiddenWords.filter(
              (word: unknown): word is string => typeof word === "string"
            )
          : [],
        summary: typeof data.summary === "string" ? data.summary : undefined,
        sample:
          data.sample && typeof data.sample.chapters === "number"
            ? {
                chapters: data.sample.chapters,
                chars: Number(data.sample.chars) || 0,
                truncated: Boolean(data.sample.truncated),
              }
            : undefined,
        usage:
          data.usage && typeof data.usage.remaining === "number"
            ? {
                used: Number(data.usage.used) || 0,
                limit: Number(data.usage.limit) || 0,
                remaining: Number(data.usage.remaining) || 0,
              }
            : undefined,
      });
    } catch (err) {
      setDistillError(
        err instanceof Error ? err.message : "文风提取失败，请稍后重试"
      );
    } finally {
      setDistilling(false);
    }
  }

  /** 把草稿填进表单（不保存）。空字段不覆盖用户已有内容 —— 模型没归纳出来的维度，别把人家手填的抹掉 */
  function applyDistillDraft() {
    if (!distillDraft) {
      return;
    }

    if (distillDraft.tone) {
      setTone(distillDraft.tone);
    }

    if (distillDraft.viewpoint) {
      setViewpoint(distillDraft.viewpoint);
    }

    if (distillDraft.sentenceStyle) {
      setSentenceStyle(distillDraft.sentenceStyle);
    }

    if (distillDraft.forbiddenWords.length > 0) {
      setForbiddenWords(distillDraft.forbiddenWords.join("、"));
    }

    setDistillDraft(null);
    setMessage("已把提取结果填入表单，请核对后点下方「保存设置」生效");
  }

  /** 删除这部作品（连同章节、版本历史、人物卡一起） */
  async function deleteProject() {
    if (!projectId || !settings || deleting) {
      return;
    }

    if (deleteConfirmation.trim() !== settings.title) {
      setDeleteError("输入的作品名称与当前作品名不完全一致，为避免误删，请重新输入");
      return;
    }

    const confirmed = window.confirm(
      `确定要删除《${settings.title}》吗？\n\n` +
        "作品下的所有章节、全部版本历史、人物卡和风格设定都会一起删掉，" +
        "删除后无法恢复。"
    );

    if (!confirmed) {
      return;
    }

    setDeleting(true);
    setDeleteError("");

    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "DELETE",
      });

      const data = await response.json().catch(() => ({}));

      if (response.status === 401) {
        redirectToLogin();
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || "删除作品失败");
      }

      // 作品已经不存在了，回列表页（不是 replace 到原作品页 —— 那是个 404）
      router.replace("/");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "删除作品失败");
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
        加载中...
      </main>
    );
  }

  if (!settings) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
        <p role="alert" className="text-red-700">
          ⚠ {error || "作品不存在"}
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-5">
          <div className="flex items-center gap-4">
            <Link
              href={`/projects/${projectId}`}
              className="text-sm text-slate-500 hover:text-blue-600"
            >
              返回编辑器
            </Link>

            <div className="h-5 w-px bg-slate-200" />

            <h1 className="font-semibold">作品设置</h1>
          </div>

          <UserMenu name={userName} email={userEmail} />
        </div>
      </header>

      <section className="mx-auto max-w-3xl p-5 md:p-8">
        <form
          onSubmit={saveSettings}
          className="space-y-6 rounded-2xl bg-white p-6 shadow-sm md:p-8"
        >
          <div>
            <h2 className="text-lg font-semibold">基本信息</h2>
            <p className="mt-1 text-sm text-slate-500">
              这些信息会用于作品管理和 AI 编辑上下文。
            </p>
          </div>

          <label className="block">
            <span className="mb-2 block text-sm font-medium">作品名称</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
              placeholder="请输入作品名称"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium">作品简介</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-28 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 leading-6 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
              placeholder="简要描述作品内容"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium">类型</span>
            <input
              value={genre}
              onChange={(event) => setGenre(event.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
              placeholder="例如：悬疑、科幻、都市"
            />
          </label>

          <div className="border-t border-slate-100 pt-6">
            <h2 className="text-lg font-semibold">风格档案</h2>
            <p className="mt-1 text-sm text-slate-500">
              AI 诊断和润色时会参考这些设定。
            </p>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-sm font-medium">语气</span>
              <input
                value={tone}
                onChange={(event) => setTone(event.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
                placeholder="例如：克制、冷峻、轻松"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium">叙事视角</span>
              <input
                value={viewpoint}
                onChange={(event) => setViewpoint(event.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
                placeholder="例如：第一人称、第三人称限知"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-2 block text-sm font-medium">句式风格</span>
            <textarea
              value={sentenceStyle}
              onChange={(event) => setSentenceStyle(event.target.value)}
              className="min-h-24 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 leading-6 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
              placeholder="例如：短句为主，少用抽象形容词，动作描写具体"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium">禁用词</span>
            <textarea
              value={forbiddenWords}
              onChange={(event) => setForbiddenWords(event.target.value)}
              className="min-h-20 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 leading-6 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-50"
              placeholder="例如：不由得、心中一震、瞳孔骤缩（用顿号分隔，AI 诊断/润色时会尽量避开）"
            />
            <span className="mt-1 block text-xs text-slate-400">
              AI 诊断和润色会尽量避开这些表达；留空表示不限制。
            </span>
          </label>

          {/* ===== 文风蒸馏（P1-2）=====
              只出建议、不写库：点「填入表单」才进本地 state，
              最终仍要按上面的「保存设置」流程走一遍。 */}
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-slate-700">
                  从已有章节提取文风
                </p>
                <p className="mt-1 text-xs leading-6 text-slate-500">
                  读取最近 3 章正文，归纳语气、视角、句式和常用套话。
                  只生成建议、不自动保存；消耗 1 次 AI 额度。
                </p>
              </div>

              <button
                type="button"
                onClick={distillStyle}
                disabled={distilling || saving}
                aria-busy={distilling}
                className="shrink-0 rounded-lg border border-blue-200 bg-white px-4 py-2 text-sm font-medium text-blue-700 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {distilling ? "提取中…" : "提取文风"}
              </button>
            </div>

            {distillError && (
              <p
                role="alert"
                className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700"
              >
                ⚠ {distillError}
              </p>
            )}

            {distillDraft && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-xs font-medium text-slate-500">
                  提取结果（草稿，尚未保存）
                  {distillDraft.sample
                    ? ` — 样本 ${distillDraft.sample.chapters} 章 / ${distillDraft.sample.chars} 字符${
                        distillDraft.sample.truncated ? "（已截断）" : ""
                      }`
                    : ""}
                </p>

                <dl className="mt-2 space-y-1.5 text-xs leading-6">
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-slate-400">语气</dt>
                    <dd className="text-slate-700">
                      {distillDraft.tone || "（样本不足以判断）"}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-slate-400">视角</dt>
                    <dd className="text-slate-700">
                      {distillDraft.viewpoint || "（样本不足以判断）"}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-slate-400">句式</dt>
                    <dd className="text-slate-700">
                      {distillDraft.sentenceStyle || "（样本不足以判断）"}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-16 shrink-0 text-slate-400">禁用词</dt>
                    <dd className="text-slate-700">
                      {distillDraft.forbiddenWords.length > 0
                        ? distillDraft.forbiddenWords.join("、")
                        : "（未发现明显套话）"}
                    </dd>
                  </div>
                </dl>

                {distillDraft.summary && (
                  <p className="mt-2 border-t border-slate-100 pt-2 text-xs leading-6 text-slate-500">
                    总评：{distillDraft.summary}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={applyDistillDraft}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700"
                  >
                    填入表单
                  </button>

                  <button
                    type="button"
                    onClick={() => setDistillDraft(null)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 transition hover:bg-slate-50"
                  >
                    忽略
                  </button>

                  {distillDraft.usage && (
                    <span className="text-xs text-slate-400">
                      今日 AI 剩余 {distillDraft.usage.remaining} /{" "}
                      {distillDraft.usage.limit} 次
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700"
            >
              ⚠ {error}
            </div>
          )}

          {message && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800"
            >
              {message}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              aria-busy={saving}
              className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {saving ? "保存中..." : "保存设置"}
            </button>
          </div>
        </form>

        {/* ===== 危险区 =====
            删除是不可逆的，所以做了三重门槛：输入作品名 → 系统确认 → 服务端再校验一次归属。
            单独放在最后、视觉上跟普通设置隔开，避免误点。 */}
        <section className="mt-8 rounded-2xl border border-red-200 bg-white p-6 shadow-sm md:p-8">
          <h2 className="text-lg font-semibold text-red-800">危险区</h2>

          <p className="mt-2 text-sm leading-6 text-slate-700">
            删除作品后，
            <strong className="font-semibold">
              它的全部章节、版本历史、人物卡和风格设定都会一起删除，无法恢复。
            </strong>
            如果只是想重写，建议先导出正文（复制到本地）再删。
          </p>

          <label className="mt-5 block">
            <span className="mb-2 block text-sm font-medium text-slate-800">
              请输入作品名称「{settings.title}」以确认删除
            </span>
            <input
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              placeholder={settings.title}
              autoComplete="off"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-red-400 focus:ring-4 focus:ring-red-50"
            />
          </label>

          {deleteError && (
            <p
              role="alert"
              className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700"
            >
              ⚠ {deleteError}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={deleteProject}
              // 名字没打对时按钮就是灰的 —— 让「不能删」这件事从界面上就能看出来
              disabled={deleting || deleteConfirmation.trim() !== settings.title}
              aria-busy={deleting}
              className="rounded-lg bg-red-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {deleting ? "删除中…" : "永久删除这部作品"}
            </button>
          </div>
        </section>
      </section>
    </main>
  );
}
