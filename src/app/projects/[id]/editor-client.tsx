"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { countWords } from "@/lib/wordCount";
import { redirectToLogin } from "@/lib/client-nav";
import { AI_MAX_INPUT_CHARS, AI_MAX_INPUT_WORDS } from "@/lib/ai-limits";
import { REVISION_PAGE_SIZE } from "@/lib/pagination";
import UserMenu from "@/components/user-menu";

type ChapterMeta = {
  id: string;
  title: string;
  orderIndex: number;
  wordCount: number;
};

type StyleProfile = {
  tone: string | null;
  viewpoint: string | null;
  sentenceStyle: string | null;
  forbiddenWords: string | null;
} | null;

type CharacterMeta = {
  id: string;
  name: string;
  personality: string | null;
  speakingStyle: string | null;
};

type ProjectDetail = {
  id: string;
  title: string;
  genre: string | null;
  description: string | null;
  chapters: ChapterMeta[];
  styleProfile: StyleProfile;
  characters: CharacterMeta[];
};

/**
 * 保存状态机。
 *
 * 界面上的状态灯必须把这几件事分清楚，用户才知道「能不能关页面」：
 *   dirty      —— 有改动还没落盘（正在等防抖计时）
 *   saving     —— 正在写
 *   saved      —— 写完了
 *   error      —— 没写进去（也可能是被 409 拒了，用 conflict 区分文案）
 *   restoring  —— 正在回滚历史版本（这期间正文会整段被换掉，必须提示）
 */
type SaveStatus = "clean" | "dirty" | "saving" | "saved" | "error" | "restoring";

type DiagnosisIssue = {
  type: string;
  quote: string;
  explanation: string;
  suggestion: string;
  severity: "low" | "medium" | "high";
};

type PolishResult = {
  originalText: string;
  revisedText: string;
  changes: string[];
  /** 生成这份稿子时编辑器里的正文；用来判断等待期间用户是不是又改过 */
  sourceContent: string;
};

/**
 * 版本历史列表项 —— **只有摘要，没有正文**。
 * 正文按需去 /api/projects/[id]/revisions/[revisionId] 取（见 RevisionDetail）。
 */
type RevisionSummary = {
  id: string;
  changeReason: string | null;
  createdAt: string;
  chars: number;
};

type RevisionDetail = RevisionSummary & {
  content: string;
  chapterId: string;
};

const AUTOSAVE_DELAY = 1200;

export default function EditorClient({
  userName,
  userEmail,
}: {
  userName: string | null;
  userEmail: string | null;
}) {
  const params = useParams<{ id: string }>();
  const projectId = params?.id;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [creating, setCreating] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("clean");
  const [lastSavedAt, setLastSavedAt] = useState("");
  const [panelNotice, setPanelNotice] = useState("");
  /** 正在删除的章节 id（按钮上转圈用，同时挡住重复点击） */
  const [deletingChapterId, setDeletingChapterId] = useState<string | null>(
    null
  );
  /** 「复制结果」按钮的临时反馈 */
  const [copyNotice, setCopyNotice] = useState("");

  /**
   * 正在跑的 AI 任务。用「哪个任务」而不是 true/false，
   * 这样按钮上能显示对得上的文案（分析中 / 生成中），
   * 也能同时挡住另一个按钮被点（两个请求并发会把额度白花掉）。
   */
  const [aiBusy, setAiBusy] = useState<"diagnose" | "polish" | null>(null);
  /** AI 最后一次结果是成功还是失败，状态灯要显示「AI 处理完成 / 失败」 */
  const [aiOutcome, setAiOutcome] = useState<"none" | "done" | "failed">(
    "none"
  );
  const [diagnosis, setDiagnosis] = useState<DiagnosisIssue[]>([]);
  const [polishResult, setPolishResult] = useState<PolishResult | null>(null);
  const [aiMessage, setAiMessage] = useState("");
  // 提示语挂在哪个面板上（诊断/润色），避免两处重复显示或串位
  const [aiMessageTarget, setAiMessageTarget] = useState<"diagnose" | "polish">(
    "polish"
  );

  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [revisionsTotal, setRevisionsTotal] = useState(0);
  const [revisionsHasMore, setRevisionsHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  /** 点开的那一条（带全文）。列表里没有正文，正文是点开才去取的。 */
  const [revisionPreview, setRevisionPreview] = useState<RevisionDetail | null>(
    null
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);

  /**
   * 并发冲突：同一个章节在别的地方被保存过，本地这份已经过期。
   * 一旦为 true 就**停止自动保存** —— 否则会一直 409 刷屏，
   * 而且用户打的字还在，不能被自动动作弄丢。
   */
  const [conflict, setConflict] = useState(false);

  /** 今天的 AI 额度（用了几次 / 一共几次），来自服务端，不在前端自己算 */
  const [aiQuota, setAiQuota] = useState<{
    used: number;
    limit: number;
    remaining: number;
  } | null>(null);

  // 用 ref 保存「最新值」，避免防抖回调和事件监听里读到旧闭包
  const titleRef = useRef("");
  const contentRef = useRef("");
  const savedTitleRef = useRef("");
  const savedContentRef = useRef("");
  const activeChapterIdRef = useRef<string | null>(null);
  /**
   * 当前章节的版本号（服务端那份）。
   * 每次保存成功、切章、回滚之后都要跟着更新，否则下一次保存会被判成冲突。
   */
  const versionRef = useRef(0);
  const conflictRef = useRef(false);

  // 同步动作必须放在 effect 里：**在渲染期间写 ref 是禁止的**
  // （React 编译器靠「渲染是纯的」做优化，渲染期改 ref 会让它算错；
  //  eslint 的 react-hooks/refs 会直接报错）。
  // effect 在每次提交后跑，防抖保存和 beforeunload 都发生在提交之后，
  // 所以这里拿到的永远是最新值。
  useEffect(() => {
    titleRef.current = title;
    contentRef.current = content;
    activeChapterIdRef.current = activeChapterId;
  }, [title, content, activeChapterId]);

  /**
   * 版本列表「已经取到第几条了」。
   *
   * 「加载更多」要用它算 offset。为什么不直接用 `revisions.length`：
   * 那会让 loadRevisions 依赖 revisions → 每次渲染都重建 →
   * openChapter / saveNow 跟着重建，作品加载的 effect 会被反复触发。
   *
   * 也不能在渲染期把状态抄进 ref（React 的规则不允许），
   * 所以这个计数改成**在请求成功之后自己往前走** ——
   * 它本来表达的就是「服务端已经给了我多少条」，比抄一份状态更准。
   */
  const revisionsOffsetRef = useRef(0);

  /**
   * 取某一章的历史版本列表（最新在前，按页取）。
   *
   * 列表接口**只回摘要**（时间 / 原因 / 字数），正文要点开才取 ——
   * 一章几万字的话，把 30 条正文一次拉下来在手机上会直接卡住。
   *
   * append = true 时接着下一页往后面加（「加载更多」）。
   */
  const loadRevisions = useCallback(
    async (chapterId: string, options?: { append?: boolean }) => {
      if (!projectId || !chapterId) {
        return;
      }

      const append = options?.append ?? false;

      if (append) {
        setHistoryLoadingMore(true);
      } else {
        setHistoryLoading(true);
      }

      try {
        const offset = append ? revisionsOffsetRef.current : 0;

        const response = await fetch(
          `/api/projects/${projectId}/revisions?chapterId=${chapterId}` +
            `&limit=${REVISION_PAGE_SIZE}&offset=${offset}`
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "加载历史版本失败");
        }

        const items: RevisionSummary[] = data.items ?? [];

        // 计数往前走 —— 下一次「加载更多」就是这么算 offset 的
        revisionsOffsetRef.current = offset + items.length;

        setRevisions((prev) => (append ? [...prev, ...items] : items));
        setRevisionsTotal(typeof data.total === "number" ? data.total : items.length);
        setRevisionsHasMore(Boolean(data.hasMore));
      } catch (error) {
        setPanelNotice(
          error instanceof Error ? error.message : "加载历史版本失败"
        );
      } finally {
        if (append) {
          setHistoryLoadingMore(false);
        } else {
          setHistoryLoading(false);
        }
      }
    },
    [projectId]
  );

  /**
   * saveNow 的依赖要保持为空（否则会把作品加载 effect 反复触发），
   * 所以用 ref 拿「最新的」loadRevisions。同样是「渲染期不能写 ref」，
   * 改到 effect 里赋值 —— useRef 的初值已经保证第一次就不会是空的。
   */
  const loadRevisionsRef = useRef(loadRevisions);

  useEffect(() => {
    loadRevisionsRef.current = loadRevisions;
  }, [loadRevisions]);

  /**
   * 点开一条历史版本 —— 这一步才去取全文。
   * 列表里没有正文，就是为了不让「打开版本历史」变成一次上兆的下载。
   */
  const openRevision = useCallback(
    async (revisionId: string) => {
      if (!projectId) {
        return;
      }

      setPreviewLoading(true);
      setPanelNotice("");

      try {
        const response = await fetch(
          `/api/projects/${projectId}/revisions/${revisionId}`,
          { cache: "no-store" }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "加载历史版本失败");
        }

        setRevisionPreview(data);
      } catch (error) {
        setPanelNotice(
          error instanceof Error ? error.message : "加载历史版本失败"
        );
      } finally {
        setPreviewLoading(false);
      }
    },
    [projectId]
  );

  /**
   * 拉一次今天的 AI 额度。
   *
   * 额度由服务端算（本地时间零点为准），前端只负责显示 ——
   * 两边各算一次的话，只要时区或时钟有点差就会出现
   * 「按钮说还能用，一点就被拒」。
   */
  const loadAiQuota = useCallback(async () => {
    try {
      const response = await fetch("/api/ai/usage", { cache: "no-store" });

      if (!response.ok) {
        return;
      }

      const data = await response.json();

      setAiQuota({
        used: data.used ?? 0,
        limit: data.limit ?? 0,
        remaining: data.remaining ?? 0,
      });
    } catch {
      // 额度显示不出来不影响任何功能，静默跳过
    }
  }, []);

  /** 立即保存当前章节（有改动才真的发请求）。返回是否保存成功。 */
  const saveNow = useCallback(async () => {
    const chapterId = activeChapterIdRef.current;

    if (!chapterId) {
      return true;
    }

    // 已经处于冲突状态就别再发了：内容不会写进去，只会一直报 409
    if (conflictRef.current) {
      return false;
    }

    const nextTitle = titleRef.current;
    const nextContent = contentRef.current;

    if (
      nextTitle === savedTitleRef.current &&
      nextContent === savedContentRef.current
    ) {
      return true;
    }

    setSaveStatus("saving");

    try {
      const response = await fetch(`/api/chapters/${chapterId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: nextTitle,
          content: nextContent,
          // 带上「我看到的版本」。服务端如果发现已经变了，会返回 409 而不是覆盖。
          version: versionRef.current,
        }),
      });

      // 409 没有正常响应体结构，先单独处理，避免走到下面的通用分支
      if (response.status === 409) {
        const data = await response.json().catch(() => ({}));

        conflictRef.current = true;
        setConflict(true);
        setSaveStatus("error");
        setPanelNotice(
          data.error || "内容已被更新，请刷新后确认是否合并修改"
        );

        return false;
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "保存失败");
      }

      // 服务端返回的是它写完之后的版本号，接下来用这个继续保存
      if (typeof data.version === "number") {
        versionRef.current = data.version;
      }

      savedTitleRef.current = nextTitle;
      savedContentRef.current = nextContent;
      setSaveStatus("saved");
      setLastSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));

      setProject((prev) =>
        prev
          ? {
              ...prev,
              chapters: prev.chapters.map((item) =>
                item.id === chapterId
                  ? {
                      ...item,
                      title: data.title ?? item.title,
                      wordCount: data.wordCount ?? item.wordCount,
                    }
                  : item
              ),
            }
          : prev
      );

      // 每次保存都会新增一条版本记录，顺手刷新历史列表
      //（不然刚保存的版本要等到切章才出现在列表里）
      void loadRevisionsRef.current(chapterId);

      return true;
    } catch {
      setSaveStatus("error");
      return false;
    }
  }, []);

  /**
   * 冲突处理①：**放弃本地改动**，拉服务端最新内容。
   *
   * 刻意不复用 openChapter —— 那个函数开头会先 saveNow()，
   * 而此刻本地内容正是「过期的」，一存又是 409。这里要的是纯粹的重新加载。
   */
  const reloadFromServer = useCallback(async () => {
    const chapterId = activeChapterIdRef.current;

    if (!chapterId) {
      return;
    }

    try {
      const response = await fetch(`/api/chapters/${chapterId}`, {
        cache: "no-store",
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "刷新失败");
      }

      conflictRef.current = false;
      setConflict(false);
      savedTitleRef.current = data.title ?? "";
      savedContentRef.current = data.content ?? "";
      versionRef.current = typeof data.version === "number" ? data.version : 0;
      setTitle(data.title ?? "");
      setContent(data.content ?? "");
      setSaveStatus("clean");
      setPanelNotice("已载入服务端最新内容（你刚才未保存的改动已放弃）");
      void loadRevisionsRef.current(chapterId);
    } catch (error) {
      setPanelNotice(error instanceof Error ? error.message : "刷新失败");
    }
  }, []);

  /**
   * 冲突处理②：**保留本地内容**，覆盖服务端那一版。
   *
   * 做法是先拉一次最新版本号，然后拿这个新版本号把本地内容写上去 ——
   * 相当于「我知道了，我就要用我这份」。
   * 对方那次保存仍然留在版本历史里，反悔了还能回滚。
   */
  const overwriteWithLocal = useCallback(async () => {
    const chapterId = activeChapterIdRef.current;

    if (!chapterId) {
      return;
    }

    try {
      const response = await fetch(`/api/chapters/${chapterId}`, {
        cache: "no-store",
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "获取最新版本失败");
      }

      versionRef.current = typeof data.version === "number" ? data.version : 0;
      conflictRef.current = false;
      setConflict(false);
      setPanelNotice(
        "已用你的内容覆盖服务端最新版（对方那次改动仍保留在版本历史里）"
      );

      await saveNow();
    } catch (error) {
      setPanelNotice(error instanceof Error ? error.message : "覆盖保存失败");
    }
  }, [saveNow]);

  /** 打开某一章（切换前先把当前章的改动落盘，防止丢字） */
  const openChapter = useCallback(
    async (chapterId: string) => {
      // 有未解决的冲突时不许切章：切过去就会把用户没保存的内容冲掉，
      // 而那份内容正是冲突的其中一边，丢了就找不回来了。
      if (conflictRef.current && chapterId !== activeChapterIdRef.current) {
        setPanelNotice(
          "本章存在未解决的冲突，请先在上方选择「刷新取最新版」或「用我的内容覆盖」，再切换章节"
        );

        return;
      }

      setPanelNotice("");
      // 换章时清掉上一章的诊断/润色结果与打开的版本预览，避免张冠李戴
      setDiagnosis([]);
      setPolishResult(null);
      setAiMessage("");
      setAiOutcome("none");
      setCopyNotice("");
      setRevisionPreview(null);
      setRevisions([]);
      setRevisionsTotal(0);
      setRevisionsHasMore(false);
      // 上一章的冲突状态不该带到这一章
      conflictRef.current = false;
      setConflict(false);
      await saveNow();

      try {
        const response = await fetch(`/api/chapters/${chapterId}`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "章节加载失败");
        }

        savedTitleRef.current = data.title ?? "";
        savedContentRef.current = data.content ?? "";
        // 记住这一章的版本号，后面每次保存都要拿它去对
        versionRef.current = typeof data.version === "number" ? data.version : 0;
        setActiveChapterId(chapterId);
        setTitle(data.title ?? "");
        setContent(data.content ?? "");
        setSaveStatus("clean");

        // 拉这一章的历史版本
        void loadRevisions(chapterId);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "章节加载失败");
      }
    },
    [saveNow, loadRevisions]
  );

  /** 载入作品 */
  useEffect(() => {
    if (!projectId) {
      return;
    }

    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/projects/${projectId}`);
        const data = await response.json();

        // 会话过期（Cookie 被清、换了标签页登录别的账号等）时，
        // 直接整页跳回登录页，比在编辑区顶一条红字清楚
        if (response.status === 401) {
          redirectToLogin();
          return;
        }

        if (!response.ok) {
          throw new Error(data.error || "作品加载失败");
        }

        if (cancelled) {
          return;
        }

        setProject(data);
        setLoading(false);

        // 顺手把今天的 AI 额度也拿回来，面板上要显示
        void loadAiQuota();

        if (data.chapters?.length) {
          await openChapter(data.chapters[0].id);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "作品加载失败");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, openChapter, loadAiQuota]);

  /** 自动保存：停止输入 1.2 秒后写库 */
  useEffect(() => {
    if (!activeChapterId) {
      return;
    }

    // 冲突没解决之前不自动重试：写不进去，只会反复弹错
    if (conflict) {
      return;
    }

    if (
      content === savedContentRef.current &&
      title === savedTitleRef.current
    ) {
      // 用户改完又改回来了（比如撤销）——状态灯跟着退回「未修改」
      setSaveStatus((prev) => (prev === "dirty" ? "clean" : prev));
      return;
    }

    // 先亮「有未保存的改动」，等防抖到点再交给 saveNow 显示「保存中…」。
    // 中间这 1.2 秒用户必须看得出来「还没存」。
    setSaveStatus("dirty");

    const timer = setTimeout(() => {
      void saveNow();
    }, AUTOSAVE_DELAY);

    return () => clearTimeout(timer);
  }, [content, title, activeChapterId, saveNow, conflict]);

  /** 关页面 / 刷新前，用 keepalive 把还没落盘的改动顶出去 */
  useEffect(() => {
    function flush() {
      const chapterId = activeChapterIdRef.current;

      if (!chapterId) {
        return;
      }

      // 冲突状态下这一枪必然被拒（409），发了也没用
      if (conflictRef.current) {
        return;
      }

      if (
        contentRef.current === savedContentRef.current &&
        titleRef.current === savedTitleRef.current
      ) {
        return;
      }

      // keepalive 支持任意方法，且能在页面卸载后继续发完
      void fetch(`/api/chapters/${chapterId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: titleRef.current,
          content: contentRef.current,
          version: versionRef.current,
        }),
        keepalive: true,
      }).catch(() => undefined);
    }

    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);

    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  /**
   * Ctrl / Cmd + S 手动保存。
   *
   * 一定要 preventDefault —— 不然浏览器会弹「保存网页」对话框，
   * 而用户以为自己按的是「保存到云端」，这个误会很难解释。
   * 写小说的人习惯性按 Ctrl+S，这个支持是必须的。
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveNow();
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveNow]);

  /** 新建章节 */
  async function createChapter() {
    if (!projectId) {
      return;
    }

    setCreating(true);
    setPanelNotice("");

    try {
      const response = await fetch(`/api/projects/${projectId}/chapters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "新建章节失败");
      }

      setProject((prev) =>
        prev
          ? {
              ...prev,
              chapters: [
                ...prev.chapters,
                {
                  id: data.id,
                  title: data.title,
                  orderIndex: data.orderIndex,
                  wordCount: data.wordCount,
                },
              ],
            }
          : prev
      );

      await openChapter(data.id);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "新建章节失败");
    } finally {
      setCreating(false);
    }
  }

  /**
   * 调 AI：诊断或轻度润色。
   *
   * 这里堵了两个常见的坑：
   * 1. **请求期间重复点击** —— aiBusy 不为空就直接返回，两个按钮同时变灰。
   *    不加这个，「点了没反应」的用户会连点五下，五次额度就没了。
   * 2. **AI 结果覆盖用户的新编辑** —— 结果**永远不会**自动写进正文，
   *    必须用户自己点按钮；而且返回时会比对「发起时的正文」和「现在的正文」，
   *    对不上就明确提示；等待期间切了章，这份结果直接作废不显示。
   */
  async function runAiEdit(action: "diagnose" | "polish") {
    setAiMessageTarget(action);

    // 已有一个 AI 请求在跑：不排队、不并发，直接忽略这次点击
    if (aiBusy) {
      return;
    }

    if (!content.trim()) {
      setAiMessage("请先输入一些正文内容");
      return;
    }

    const contentWords = countWords(content);

    if (content.length > AI_MAX_INPUT_CHARS || contentWords > AI_MAX_INPUT_WORDS) {
      setAiMessage(
        `单次 AI 编辑最多处理 ${AI_MAX_INPUT_WORDS} 字（${AI_MAX_INPUT_CHARS} 个字符），当前 ${contentWords} 字，请分章或分段处理`
      );
      return;
    }

    const chapterId = activeChapterIdRef.current;

    if (!projectId || !chapterId) {
      setAiMessage("请先选择要处理的章节");
      return;
    }

    // 发起前的快照 —— 结果回来时用它判断「这段等待期间用户在编辑器里改过没有」
    const snapshotContent = content;
    const snapshotChapterId = chapterId;

    setAiBusy(action);
    setAiMessage("");
    setDiagnosis([]);
    setAiOutcome("none");
    setCopyNotice("");

    if (action === "polish") {
      setPolishResult(null);
    }

    try {
      const response = await fetch("/api/ai/edit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        // 注意：不再把作品信息传上去。服务端会自己按 projectId/chapterId
        // 从数据库读风格档案 —— 客户端传的那份是可以伪造的。
        body: JSON.stringify({
          projectId,
          chapterId,
          content,
          mode: action,
        }),
      });

      const data = await response.json().catch(() => ({}));

      // 按 HTTP 状态给明确提示，别让用户看到一句笼统的「AI 请求失败」
      if (response.status === 401) {
        throw new Error("登录状态已失效，请重新登录");
      }

      if (response.status === 403) {
        throw new Error("你没有这个章节的编辑权限");
      }

      if (response.status === 429) {
        // 两种 429 要说清楚是哪一种：一个是「等几十秒」，一个是「等明天」
        if (data.code === "DAILY_QUOTA_EXCEEDED") {
          if (typeof data.used === "number" && typeof data.limit === "number") {
            setAiQuota({
              used: data.used,
              limit: data.limit,
              remaining: Math.max(0, data.limit - data.used),
            });
          }

          throw new Error(
            data.error || "今日 AI 使用次数已达上限，明天 0 点后恢复"
          );
        }

        const retryAfter =
          typeof data.retryAfter === "number" ? data.retryAfter : null;

        throw new Error(
          retryAfter
            ? `AI 请求过于频繁，请 ${retryAfter} 秒后再试`
            : "AI 请求过于频繁，请稍后再试"
        );
      }

      if (response.status === 503) {
        throw new Error(
          data.error || "AI 服务尚未配置，请在服务端补齐 AI 密钥和模型名"
        );
      }

      if (!response.ok) {
        throw new Error(data.error || "AI 处理失败，请稍后重试");
      }

      // 服务端在响应里带回了最新额度，直接用它刷新显示，
      // 不必再多打一次 /api/ai/usage
      if (data.usage && typeof data.usage.used === "number") {
        setAiQuota({
          used: data.usage.used,
          limit: data.usage.limit ?? 0,
          remaining: data.usage.remaining ?? 0,
        });
      }

      // 等结果的这段时间里用户切了章：这份结果是上一章的，不能显示出来
      if (activeChapterIdRef.current !== snapshotChapterId) {
        setAiOutcome("failed");
        setAiMessage("等待期间你切换了章节，本次结果已作废，请在新章节里重新发起");
        return;
      }

      // 正文在等待期间被改过：结果仍然显示，但要提醒用户先对照
      const editedWhileWaiting = contentRef.current !== snapshotContent;

      if (action === "diagnose") {
        setDiagnosis(data.issues || []);
        setAiOutcome("done");
        setAiMessage(
          data.issues?.length
            ? `发现 ${data.issues.length} 个可关注的问题` +
                (editedWhileWaiting ? "（注意：等待期间正文有改动，引用的句子可能已不在此处）" : "")
            : "暂未发现明显问题"
        );
      } else {
        setPolishResult({
          originalText: snapshotContent,
          revisedText: data.revisedText,
          changes: data.changes || [],
          sourceContent: snapshotContent,
        });
        setAiOutcome("done");
        setAiMessage(
          editedWhileWaiting
            ? "修改稿已生成。注意：等待期间正文有新的改动，应用前请先对照，别把刚写的盖掉。"
            : "修改稿已生成，请确认后再应用"
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 请求失败";

      setAiOutcome("failed");
      setAiMessage(message);

      // 会话过期就直接送回去登录，不然用户会一直点重试
      if (message.includes("登录状态已失效")) {
        window.setTimeout(() => redirectToLogin(), 1200);
      }
    } finally {
      setAiBusy(null);
    }
  }

  /**
   * 采用结果：把修改稿写进正文**并立刻保存**，然后收起结果面板。
   * 这是「我确认了，就用它」。
   */
  function acceptPolish() {
    if (!polishResult) {
      return;
    }

    const nextContent = polishResult.revisedText;

    setContent(nextContent);
    // 同步 ref，保证紧接着的保存拿到的是新正文
    contentRef.current = nextContent;
    setPolishResult(null);
    setAiMessage("已应用修改稿，正在保存…");
    setAiMessageTarget("polish");

    void saveNow();
  }

  /**
   * 替换当前内容：只把编辑器里的正文换成修改稿，**先不保存**。
   * 结果面板保留着，用户可以继续看修改说明、也可以再点「采用结果」落盘。
   * 适合「先放进去，我自己再改两笔」。
   */
  function replaceContentWithPolished() {
    if (!polishResult) {
      return;
    }

    const nextContent = polishResult.revisedText;

    setContent(nextContent);
    contentRef.current = nextContent;
    setSaveStatus("dirty");
    setAiMessage("已替换编辑器里的正文（还没保存，可以直接继续改）");
    setAiMessageTarget("polish");
  }

  /** 复制结果：内容进剪贴板，正文一个字都不动 */
  async function copyPolishResult() {
    if (!polishResult) {
      return;
    }

    try {
      // clipboard 只在 https 或 localhost 下可用；不可用时给一句人话提示
      await navigator.clipboard.writeText(polishResult.revisedText);
      setCopyNotice("已复制到剪贴板");
    } catch {
      setCopyNotice("当前浏览器不允许自动复制，请手动选中修改稿复制");
    }

    window.setTimeout(() => setCopyNotice(""), 4000);
  }

  /** 放弃结果：直接丢掉，正文一个字都不动 */
  function rejectPolish() {
    setPolishResult(null);
    setCopyNotice("");
    setAiMessage("已放弃修改稿，正文未改动");
    setAiMessageTarget("polish");
  }

  /**
   * 把正在预览的历史版本恢复成当前正文。
   *
   * 恢复会**整段换掉**现在的正文，所以：先弹确认（把版本时间写进去，
   * 让人看清楚要退回哪一版），执行期间状态灯显示「恢复中…」，
   * 完成后再明确提示一句 —— 不能悄悄地换掉。
   */
  async function restoreRevision() {
    if (!revisionPreview || !projectId) {
      return;
    }

    const when = new Date(revisionPreview.createdAt).toLocaleString("zh-CN", {
      hour12: false,
    });

    const confirmed = window.confirm(
      `确定要恢复到 ${when} 这一版吗？\n\n当前正文会被替换掉，但不会丢 —— 恢复前的内容会作为新版本留在历史里。`
    );

    if (!confirmed) {
      return;
    }

    setRestoreLoading(true);
    setSaveStatus("restoring");
    setPanelNotice("");

    try {
      const response = await fetch(
        `/api/projects/${projectId}/revisions/${revisionPreview.id}/restore`,
        { method: "POST" }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "恢复版本失败");
      }

      setContent(data.content);
      // 同步 ref：恢复接口本身已经写了一条新版本记录，
      // 所以这里要假装「已保存过」，否则防抖保存会再发一次 PATCH、多留一条重复版本
      contentRef.current = data.content ?? "";
      savedContentRef.current = data.content ?? "";
      // 回滚也会推进版本号，本地必须跟着走，否则下一次保存被判冲突
      if (typeof data.version === "number") {
        versionRef.current = data.version;
      }
      setSaveStatus("saved");
      setLastSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));

      setProject((current) =>
        current
          ? {
              ...current,
              chapters: current.chapters.map((chapter) =>
                chapter.id === data.id
                  ? {
                      ...chapter,
                      title: data.title ?? chapter.title,
                      wordCount: data.wordCount ?? chapter.wordCount,
                    }
                  : chapter
              ),
            }
          : current
      );

      setRevisionPreview(null);
      // 提示里带上是哪一版，用户才知道自己刚做了什么
      setPanelNotice(
        `已恢复到 ${when} 那一版；恢复前的正文仍留在版本历史里，随时可以再退回去。`
      );
      await loadRevisions(data.id);
    } catch (error) {
      setSaveStatus("error");
      setPanelNotice(
        error instanceof Error ? error.message : "恢复版本失败"
      );
    } finally {
      setRestoreLoading(false);
    }
  }

  /**
   * 删除章节。
   *
   * 两个必须处理的细节：
   * 1. 删之前先把当前章的改动落盘 —— 否则用户刚写的字会跟着这一章一起消失；
   * 2. 删的如果是当前正在编辑的章，要自动切到邻近一章（或清空编辑区），
   *    不能让页面停在一个已经不存在的章节上。
   */
  async function deleteChapter(chapterId: string) {
    if (!projectId || deletingChapterId) {
      return;
    }

    const target = project?.chapters.find((item) => item.id === chapterId);
    const label = target?.title || "这一章";

    const confirmed = window.confirm(
      `确定删除「${label}」吗？\n\n这一章的正文和全部历史版本都会一起删掉，无法恢复。`
    );

    if (!confirmed) {
      return;
    }

    setDeletingChapterId(chapterId);
    setPanelNotice("");

    try {
      // 删的是当前章时先保存，避免"刚打的字"随着章节一起没了
      if (chapterId === activeChapterIdRef.current) {
        await saveNow();
      }

      const response = await fetch(`/api/chapters/${chapterId}`, {
        method: "DELETE",
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "删除章节失败");
      }

      const remaining = (project?.chapters ?? []).filter(
        (item) => item.id !== chapterId
      );

      setProject((prev) =>
        prev
          ? {
              ...prev,
              chapters: prev.chapters.filter((item) => item.id !== chapterId),
            }
          : prev
      );

      if (chapterId === activeChapterIdRef.current) {
        setRevisionPreview(null);
        setRevisions([]);
        setRevisionsTotal(0);
        setRevisionsHasMore(false);

        if (remaining.length > 0) {
          // 优先接管下一章；删的是最后一章就回到前一章
          const next =
            remaining.find((item) => item.orderIndex > (target?.orderIndex ?? 0)) ??
            remaining[remaining.length - 1];

          await openChapter(next.id);
        } else {
          setActiveChapterId(null);
          setTitle("");
          setContent("");
          setSaveStatus("clean");
        }
      }

      setPanelNotice(`「${label}」已删除`);
    } catch (error) {
      setPanelNotice(
        error instanceof Error ? error.message : "删除章节失败"
      );
    } finally {
      setDeletingChapterId(null);
    }
  }

  const activeIndex =
    project?.chapters.findIndex((item) => item.id === activeChapterId) ?? -1;

  const totalWords =
    project?.chapters.reduce((sum, item) => sum + item.wordCount, 0) ?? 0;

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 text-slate-500">
        正在载入作品…
      </main>
    );
  }

  if (!project) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 px-6 text-slate-600">
        <p className="text-sm text-red-600">{loadError || "作品不存在"}</p>
        <Link
          href="/"
          className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          返回作品列表
        </Link>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-slate-100 text-slate-900 lg:h-screen lg:overflow-hidden">
      {/* 顶栏。窄屏用 flex-wrap 允许换行 —— 硬挤会把按钮压到点不着 */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-4 py-3 lg:px-6">
        <Link
          href="/"
          onClick={() => void saveNow()}
          aria-label="返回作品列表"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-blue-300 hover:text-blue-600"
          title="返回作品列表"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{project.title}</h1>
          <p className="truncate text-xs text-slate-500">
            {project.genre || "未分类"}
            {" · "}
            {project.chapters.length} 章
            {" · "}
            全书 {totalWords.toLocaleString("zh-CN")} 字
          </p>
        </div>

        <Link
          href={`/projects/${projectId}/settings`}
          onClick={() => void saveNow()}
          className="shrink-0 rounded-lg px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-100 hover:text-blue-600"
        >
          <span className="hidden sm:inline">作品设置</span>
          <span className="sm:hidden">设置</span>
        </Link>

        {/* 导出：把作品带走（txt / md，全书或当前章）。
            这是「用户有权把自己的稿子拿走」的入口，不是可选装饰。 */}
        <ExportMenu
          projectId={project.id}
          projectTitle={project.title}
          activeChapter={
            project.chapters.find((item) => item.id === activeChapterId) ?? null
          }
          onBeforeExport={saveNow}
        />

        <SaveIndicator
          status={saveStatus}
          lastSavedAt={lastSavedAt}
          conflict={conflict}
        />

        {/* 手动保存。自动保存已经够用，但"我想现在立刻存一下"这个需求是真实存在的
            ——按 Ctrl+S 也一样（见上面的快捷键 effect） */}
        <button
          type="button"
          onClick={() => void saveNow()}
          disabled={saveStatus === "saving" || saveStatus === "restoring"}
          aria-busy={saveStatus === "saving"}
          title="立即保存（Ctrl+S）"
          className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
        >
          {saveStatus === "saving" ? "保存中…" : "保存"}
        </button>

        {/* AI 状态单独一格：保存状态和 AI 状态是两回事，混在一起说不清 */}
        <AiIndicator busy={aiBusy} outcome={aiOutcome} />

        <div className="hidden h-5 w-px shrink-0 bg-slate-200 sm:block" />

        <UserMenu name={userName} email={userEmail} onBeforeLeave={saveNow} />
      </header>

      {/* 并发冲突提示条：只在检测到 409 时出现，未解决前挡住自动保存 */}
      {conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 lg:px-6"
        >
          <span className="flex-1 leading-6">
            <strong className="font-semibold">内容已被更新。</strong>
            本章在别处（另一个标签页或设备）保存过，你这边看到的是旧版本，
            自动保存已暂停，你打的字还在编辑区里没丢。请选择：
          </span>

          <button
            type="button"
            onClick={reloadFromServer}
            className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-amber-700"
          >
            刷新取最新版
          </button>

          <button
            type="button"
            onClick={overwriteWithLocal}
            className="rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 transition hover:bg-amber-100"
          >
            用我的内容覆盖
          </button>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        {/* 左：章节列表 */}
        <aside className="shrink-0 border-b border-slate-200 bg-white lg:w-64 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between gap-2 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-700">章节</h2>
            <button
              type="button"
              onClick={createChapter}
              disabled={creating}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? "新建中…" : "+ 新建章节"}
            </button>
          </div>

          <div className="flex gap-2 overflow-x-auto px-4 pb-3 lg:flex-col lg:overflow-x-visible lg:pb-4">
            {project.chapters.length === 0 && (
              <p className="py-4 text-xs text-slate-500">
                还没有章节，点右上角新建一章。
              </p>
            )}

            {project.chapters.map((chapter, index) => {
              const active = chapter.id === activeChapterId;
              const deleting = deletingChapterId === chapter.id;

              return (
                <div
                  key={chapter.id}
                  className={`flex shrink-0 items-stretch overflow-hidden rounded-xl border transition lg:w-full ${
                    active
                      ? "border-blue-500 bg-blue-50"
                      : "border-slate-200 bg-white hover:border-blue-300 hover:bg-slate-50"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => openChapter(chapter.id)}
                    // 读屏用户靠这个知道「当前正在编辑哪一章」，
                    // 光靠蓝底（颜色）是识别不出来的
                    aria-current={active ? "true" : undefined}
                    className="min-w-0 flex-1 px-3 py-2 text-left"
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">{index + 1}</span>
                      <span
                        className={`max-w-[10rem] truncate text-sm lg:max-w-full ${
                          active
                            ? "font-semibold text-blue-700"
                            : "text-slate-700"
                        }`}
                      >
                        {chapter.title}
                      </span>
                    </span>
                    <span className="hidden text-xs text-slate-500 lg:mt-1 lg:block">
                      {chapter.wordCount.toLocaleString("zh-CN")} 字
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => deleteChapter(chapter.id)}
                    disabled={deleting}
                    aria-label={
                      deleting
                        ? `正在删除章节 ${chapter.title}`
                        : `删除章节 ${chapter.title}`
                    }
                    title="删除这一章"
                    className="flex w-8 shrink-0 items-center justify-center text-slate-500 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                  >
                    {deleting ? (
                      <span className="text-xs">…</span>
                    ) : (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                      </svg>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </aside>

        {/* 中：编辑区 */}
        <section className="flex min-h-[60vh] flex-1 flex-col bg-white lg:min-h-0 lg:overflow-hidden">
          {activeChapterId ? (
            <>
              <div className="shrink-0 border-b border-slate-100 px-5 py-3 lg:px-8">
                {/* 屏幕上靠 placeholder 提示，但读屏软件读不到 placeholder 的意思，
                    所以给一个真正的（视觉隐藏的）label */}
                <label htmlFor="chapter-title" className="sr-only">
                  章节标题
                </label>
                <input
                  id="chapter-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="章节标题"
                  maxLength={100}
                  className="w-full bg-transparent text-lg font-semibold outline-none placeholder:font-normal placeholder:text-slate-500"
                />
              </div>

              <label htmlFor="chapter-content" className="sr-only">
                章节正文
              </label>
              <textarea
                id="chapter-content"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="在这里写正文。停笔约一秒会自动保存。"
                spellCheck={false}
                aria-describedby="editor-status-line"
                className="min-h-[45vh] w-full flex-1 resize-none bg-white px-5 py-5 text-base leading-8 text-slate-800 outline-none placeholder:text-slate-500 lg:min-h-0 lg:px-8 lg:py-6"
              />

              <div
                id="editor-status-line"
                className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-slate-100 px-5 py-2 text-xs text-slate-500 lg:px-8"
              >
                <span>
                  本章 {countWords(content).toLocaleString("zh-CN")} 字
                  {activeIndex >= 0 && (
                    <span className="ml-3">
                      第 {activeIndex + 1} / {project.chapters.length} 章
                    </span>
                  )}
                </span>
                <span>
                  {saveStatus === "dirty" || saveStatus === "saving"
                    ? "有改动尚未落盘，请等状态变回「已保存」"
                    : "自动保存已开启（停笔约 1 秒后写入）"}
                </span>
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-slate-500">
              <p className="text-sm">这部作品还没有章节</p>
              <button
                type="button"
                onClick={createChapter}
                className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-blue-700"
              >
                新建第一章
              </button>
            </div>
          )}
        </section>

        {/* 右：诊断 / 润色面板 */}
        <aside className="shrink-0 space-y-4 border-t border-slate-200 bg-white p-4 lg:w-80 lg:overflow-y-auto lg:border-t-0 lg:border-l">
          {panelNotice && (
            <p
              role="status"
              aria-live="polite"
              className="rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-6 text-amber-800"
            >
              {panelNotice}
            </p>
          )}

          {/* AI 额度：把「今天还能用几次」摆出来，
              免得用户点到第 31 次才莫名其妙被拒 */}
          {aiQuota && (
            <p
              className={`rounded-xl px-3 py-2.5 text-xs leading-6 ${
                aiQuota.remaining === 0
                  ? "bg-amber-50 text-amber-800"
                  : "bg-slate-50 text-slate-600"
              }`}
            >
              今日 AI 用量 {aiQuota.used} / {aiQuota.limit} 次
              {aiQuota.remaining === 0
                ? "，已用满，明天 0 点后恢复"
                : `，还剩 ${aiQuota.remaining} 次`}
            </p>
          )}

          <section className="rounded-2xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-700">文本诊断</h3>

            <p className="mt-2 text-xs leading-6 text-slate-500">
              检查重复表达、空泛描写、句式单一和节奏问题。
            </p>

            <button
              type="button"
              onClick={() => runAiEdit("diagnose")}
              // 任何一个 AI 任务在跑，两个按钮都不能再点 —— 并发请求会白花额度
              disabled={
                aiBusy !== null || !content.trim() || aiQuota?.remaining === 0
              }
              aria-busy={aiBusy === "diagnose"}
              className="mt-3 w-full rounded-xl bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {aiBusy === "diagnose" ? "分析中…" : "开始诊断"}
            </button>

            {diagnosis.length > 0 && (
              <div className="mt-3 space-y-3">
                {diagnosis.map((issue, index) => (
                  <div
                    key={`${issue.type}-${index}`}
                    className="rounded-xl bg-slate-50 p-3 text-xs"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-700">
                        {issue.type}
                      </span>

                      <span
                        className={`shrink-0 ${
                          issue.severity === "high"
                            ? "text-red-600"
                            : issue.severity === "medium"
                              ? "text-amber-600"
                              : "text-slate-600"
                        }`}
                      >
                        {issue.severity === "high"
                          ? "重要"
                          : issue.severity === "medium"
                            ? "建议关注"
                            : "轻微"}
                      </span>
                    </div>

                    <p className="mb-2 border-l-2 border-slate-300 pl-2 leading-6 text-slate-500">
                      “{issue.quote}”
                    </p>

                    <p className="leading-6 text-slate-600">
                      {issue.explanation}
                    </p>

                    <p className="mt-2 leading-6 text-blue-600">
                      建议：{issue.suggestion}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {aiMessage && aiMessageTarget === "diagnose" && (
              <p
                // 报错用 alert（读屏会立刻念出来），普通提示用 status
                role={looksLikeError(aiMessage) ? "alert" : "status"}
                aria-live={looksLikeError(aiMessage) ? "assertive" : "polite"}
                className={`mt-3 rounded-xl px-3 py-2.5 text-xs leading-6 ${
                  looksLikeError(aiMessage)
                    ? "bg-amber-50 font-medium text-amber-800"
                    : "bg-slate-50 text-slate-600"
                }`}
              >
                {looksLikeError(aiMessage) ? "⚠ " : ""}
                {aiMessage}
              </p>
            )}

            {aiBusy === null &&
              diagnosis.length === 0 &&
              !(aiMessage && aiMessageTarget === "diagnose") && (
                <div className="mt-3 rounded-xl border border-dashed border-slate-300 px-3 py-5 text-center text-xs text-slate-500">
                  暂无结果
                </div>
              )}
          </section>

          <section className="rounded-2xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-700">轻度润色</h3>

            <p className="mt-2 text-xs leading-6 text-slate-500">
              在不改变剧情和人物设定的前提下，改善语句和阅读节奏。
            </p>

            <button
              type="button"
              onClick={() => runAiEdit("polish")}
              disabled={
                aiBusy !== null || !content.trim() || aiQuota?.remaining === 0
              }
              aria-busy={aiBusy === "polish"}
              className="mt-3 w-full rounded-xl bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {aiBusy === "polish" ? "生成中…" : "生成润色稿"}
            </button>

            {aiMessage && aiMessageTarget === "polish" && (
              <p
                role={looksLikeError(aiMessage) ? "alert" : "status"}
                aria-live={looksLikeError(aiMessage) ? "assertive" : "polite"}
                className={`mt-3 rounded-xl px-3 py-2.5 text-xs leading-6 ${
                  looksLikeError(aiMessage)
                    ? "bg-amber-50 font-medium text-amber-800"
                    : "bg-slate-50 text-slate-600"
                }`}
              >
                {looksLikeError(aiMessage) ? "⚠ " : ""}
                {aiMessage}
              </p>
            )}

            {copyNotice && (
              <p
                role="status"
                aria-live="polite"
                className="mt-3 rounded-xl bg-emerald-50 px-3 py-2.5 text-xs leading-6 text-emerald-800"
              >
                {copyNotice}
              </p>
            )}

            {!(aiMessage && aiMessageTarget === "polish") && !polishResult && (
              <div className="mt-3 rounded-xl border border-dashed border-slate-300 px-3 py-5 text-center text-xs text-slate-500">
                暂无结果
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-700">
              作品风格设定
            </h3>
            <dl className="mt-3 space-y-2 text-xs leading-6">
              <StyleRow label="基调" value={project.styleProfile?.tone} />
              <StyleRow label="视角" value={project.styleProfile?.viewpoint} />
              <StyleRow
                label="句式"
                value={project.styleProfile?.sentenceStyle}
              />
              <StyleRow
                label="禁用词"
                value={project.styleProfile?.forbiddenWords}
              />
            </dl>
            <Link
              href={`/projects/${projectId}/settings`}
              onClick={() => void saveNow()}
              className="mt-3 inline-block text-xs text-blue-600 transition hover:text-blue-700"
            >
              去作品设置里改 →
            </Link>
            <p className="mt-1 text-xs text-slate-500">
              禁用词暂未开放编辑，排在后面的阶段。
            </p>
          </section>

          <section className="rounded-2xl border border-slate-200 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700">人物卡</h3>
              <span className="text-xs text-slate-500">
                {project.characters.length} 张
              </span>
            </div>

            {project.characters.length === 0 ? (
              <p className="mt-3 rounded-xl border border-dashed border-slate-300 px-3 py-4 text-center text-xs text-slate-500">
                暂无人物卡
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {project.characters.map((character) => (
                  <li
                    key={character.id}
                    className="rounded-xl bg-slate-50 px-3 py-2.5"
                  >
                    <p className="text-sm font-medium text-slate-700">
                      {character.name}
                    </p>
                    {(character.personality || character.speakingStyle) && (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
                        {[character.personality, character.speakingStyle]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-3 text-xs text-slate-500">
              人物卡的可视化编辑排在后面的阶段。
            </p>
          </section>

          <section className="rounded-2xl border border-slate-200 p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-700">版本历史</h3>
              <span className="text-xs text-slate-500">
                {revisions.length} / {revisionsTotal} 条
              </span>
            </div>

            {historyLoading ? (
              <p
                role="status"
                aria-live="polite"
                className="mt-3 text-xs text-slate-500"
              >
                加载中…
              </p>
            ) : revisions.length === 0 ? (
              <p className="mt-3 text-xs leading-6 text-slate-500">
                保存后会在这里显示历史版本。
              </p>
            ) : (
              <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
                {revisions.map((revision) => (
                  <button
                    key={revision.id}
                    type="button"
                    onClick={() => void openRevision(revision.id)}
                    aria-current={
                      revisionPreview?.id === revision.id ? "true" : undefined
                    }
                    className={`w-full rounded-xl px-3 py-2 text-left text-xs transition ${
                      revisionPreview?.id === revision.id
                        ? "bg-blue-50 text-blue-700"
                        : "bg-slate-50 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    <span className="block font-medium">
                      {new Date(revision.createdAt).toLocaleString("zh-CN", {
                        hour12: false,
                      })}
                    </span>
                    <span className="mt-1 block text-slate-500">
                      {revision.changeReason || "编辑保存"} ·{" "}
                      {/* 字数直接用服务端算好的，不在这里取全文再数 */}
                      {revision.chars.toLocaleString("zh-CN")} 字
                    </span>
                  </button>
                ))}
              </div>
            )}

            {revisionsHasMore && (
              <button
                type="button"
                onClick={() => {
                  const chapterId = activeChapterIdRef.current;

                  if (chapterId) {
                    void loadRevisions(chapterId, { append: true });
                  }
                }}
                disabled={historyLoadingMore}
                className="mt-3 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
              >
                {historyLoadingMore
                  ? "加载中…"
                  : `加载更早的版本（还有 ${revisionsTotal - revisions.length} 条）`}
              </button>
            )}
          </section>

          {polishResult && (
            <section className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-blue-900">润色结果</h3>
                <span className="text-xs text-blue-800">
                  {countWords(polishResult.originalText)} →{" "}
                  {countWords(polishResult.revisedText)} 字
                </span>
              </div>

              <p className="mt-2 text-xs leading-6 text-blue-800">
                这是一份<strong className="font-semibold">待确认</strong>
                的修改稿，不会自动盖掉你的正文 —— 用不用、怎么用，
                由你点下面的按钮决定。
              </p>

              {/* 结果生成之后，编辑器里又被改过：明确提醒，别让人糊里糊涂地套用 */}
              {polishResult.sourceContent !== content && (
                <p
                  role="status"
                  aria-live="polite"
                  className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-800"
                >
                  这份修改稿是基于你
                  <strong className="font-semibold">之前</strong>
                  的正文生成的，那之后正文已经变过。套用前请自己对照一遍，
                  别把刚写的内容覆盖掉。
                </p>
              )}

              <div className="mt-3 max-h-80 space-y-3 overflow-y-auto text-sm">
                <div>
                  <p className="mb-1 text-xs font-medium text-slate-600">
                    修改稿
                  </p>
                  <div className="whitespace-pre-wrap rounded-xl bg-white p-3 text-xs leading-6 text-slate-700">
                    {polishResult.revisedText}
                  </div>
                </div>

                {polishResult.changes.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-slate-600">
                      修改说明
                    </p>
                    <ul className="list-disc space-y-1 pl-5 text-xs leading-6 text-slate-700">
                      {polishResult.changes.map((change, index) => (
                        <li key={index}>{change}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={copyPolishResult}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
                >
                  复制结果
                </button>

                <button
                  type="button"
                  onClick={replaceContentWithPolished}
                  className="rounded-xl border border-blue-300 bg-white px-3 py-2 text-sm text-blue-700 transition hover:bg-blue-50"
                >
                  替换当前内容
                </button>

                <button
                  type="button"
                  onClick={rejectPolish}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
                >
                  放弃结果
                </button>

                <button
                  type="button"
                  onClick={acceptPolish}
                  className="rounded-xl bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
                >
                  采用结果
                </button>
              </div>

              <p className="mt-2 text-xs leading-6 text-blue-800">
                「采用结果」= 写进正文并立刻保存；「替换当前内容」= 只换编辑器里的字，
                先不保存，你还能接着改。
              </p>
            </section>
          )}

          {previewLoading && (
            <p
              role="status"
              aria-live="polite"
              className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-6 text-slate-600"
            >
              正在读取这一版正文…
            </p>
          )}

          {revisionPreview && !previewLoading && (
            <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-amber-900">
                  历史版本预览
                </h3>

                <button
                  type="button"
                  onClick={() => setRevisionPreview(null)}
                  aria-label="关闭历史版本预览"
                  className="rounded-lg px-2 py-1 text-xs text-slate-600 transition hover:bg-amber-100 hover:text-slate-900"
                >
                  关闭
                </button>
              </div>

              <p className="mb-2 text-xs text-amber-900">
                {new Date(revisionPreview.createdAt).toLocaleString("zh-CN", {
                  hour12: false,
                })}
                {" · "}
                {revisionPreview.changeReason || "编辑保存"}
                {" · "}
                {revisionPreview.chars.toLocaleString("zh-CN")} 字
              </p>

              <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl bg-white p-3 text-xs leading-6 text-slate-700">
                {revisionPreview.content || "（这一版是空的）"}
              </div>

              <button
                type="button"
                onClick={restoreRevision}
                disabled={restoreLoading}
                aria-busy={restoreLoading}
                className="mt-3 w-full rounded-xl bg-amber-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {restoreLoading ? "恢复中…" : "恢复此版本"}
              </button>

              <p className="mt-2 text-xs leading-6 text-amber-900">
                恢复会把当前正文整段替换成这一版。当前正文不会丢 ——
                它会作为新版本留在历史里。
              </p>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}

/** 粗判提示语是不是报错，好决定用灰字还是警示色 */
/**
 * 判断一条 AI 提示语是不是「出错了」，用来决定用红字还是灰字显示。
 *
 * ⚠️ 往 runAiEdit 里加新的提示语时，记得把关键词补进这个正则，
 * 否则错误提示会以「正常提示」的样子出现，用户根本注意不到。
 */
function looksLikeError(text: string) {
  return /失败|尚未|未配置|无法|不正确|请先|最多|失效|权限|频繁|不能为空|不属于|重试|上限|已用满|被更新|冲突|放弃|作废/.test(
    text
  );
}

function StyleRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="flex gap-2">
      <dt className="w-12 shrink-0 text-slate-500">{label}</dt>
      <dd className="text-slate-700">{value || "未设置"}</dd>
    </div>
  );
}

function SaveIndicator({
  status,
  lastSavedAt,
  conflict,
}: {
  status: SaveStatus;
  lastSavedAt: string;
  /** 冲突时的「失败」跟断网的「失败」不是一回事，得分开说 */
  conflict: boolean;
}) {
  /**
   * 状态灯。**每个状态都必须是「能读出来的一句话」**，
   * 不能只靠颜色区分 —— 分不清红绿的用户全靠这几个字。
   * 前面那个小圆点是给一眼扫过去用的，文字才是主信息。
   */
  const config: Record<SaveStatus, { text: string; dot: string; tone: string }> =
    {
      clean: {
        text: "未修改",
        dot: "bg-slate-400",
        tone: "text-slate-600",
      },
      dirty: {
        text: "有改动待保存",
        dot: "bg-amber-400",
        tone: "text-amber-700",
      },
      saving: {
        text: "保存中…",
        dot: "bg-amber-500",
        tone: "text-amber-700",
      },
      saved: {
        text: lastSavedAt ? `已保存 ${lastSavedAt}` : "已保存",
        dot: "bg-emerald-500",
        tone: "text-emerald-700",
      },
      error: conflict
        ? {
            text: "保存被拒绝（内容已被更新）",
            dot: "bg-red-500",
            tone: "text-red-700",
          }
        : { text: "保存失败，请检查网络", dot: "bg-red-500", tone: "text-red-700" },
      restoring: {
        text: "恢复中…",
        dot: "bg-amber-500",
        tone: "text-amber-700",
      },
    };

  const current = config[status];

  return (
    <span
      // 读屏软件不会因为圆点变色就播报，所以状态变化要主动播
      role="status"
      aria-live="polite"
      className={`flex shrink-0 items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs ${current.tone}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${current.dot}`}
        aria-hidden="true"
      />
      {current.text}
    </span>
  );
}

/**
 * AI 状态灯：和保存状态分开显示。
 *
 * 第十节要求编辑页能看出「AI 处理中 / AI 处理完成」，
 * 但它跟「保存中 / 已保存」是两条独立的线 —— 合在一个灯里必然互相覆盖，
 * 用户就分不清「是稿子存了还是润色完了」。
 */
function AiIndicator({
  busy,
  outcome,
}: {
  busy: "diagnose" | "polish" | null;
  outcome: "none" | "done" | "failed";
}) {
  if (busy) {
    return (
      <span
        role="status"
        aria-live="polite"
        className="flex shrink-0 items-center gap-2 rounded-lg bg-blue-50 px-3 py-1.5 text-xs text-blue-700"
      >
        <span
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500"
          aria-hidden="true"
        />
        {busy === "diagnose" ? "AI 处理中（诊断）" : "AI 处理中（润色）"}
      </span>
    );
  }

  if (outcome === "done") {
    return (
      <span className="flex shrink-0 items-center gap-2 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700">
        <span
          className="h-1.5 w-1.5 rounded-full bg-emerald-500"
          aria-hidden="true"
        />
        AI 处理完成
      </span>
    );
  }

  if (outcome === "failed") {
    return (
      <span className="flex shrink-0 items-center gap-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700">
        <span
          className="h-1.5 w-1.5 rounded-full bg-red-500"
          aria-hidden="true"
        />
        AI 处理失败
      </span>
    );
  }

  return null;
}

/**
 * 导出菜单：把作品或当前章存成文件。
 *
 * 为什么点导出前必须先 await 一次保存：
 * 自动保存有 1.2 秒防抖，用户打完最后一个字立刻点导出，库里还是旧稿。
 * 不先存一次，导出的就是「差一截」的版本 —— 这种错最难跟用户解释，
 * 他只会说「导出来的文件不对」。保存失败时也停下来，不下载旧内容。
 *
 * 为什么用 window.location.assign 而不是 fetch + Blob：
 * 接口响应带 Content-Disposition: attachment，浏览器会原生走下载、
 * 不离开页面。用 Blob 就得把整本书塞进页面内存再拼，没必要。
 */
function ExportMenu({
  projectId,
  projectTitle,
  activeChapter,
  onBeforeExport,
}: {
  projectId: string;
  projectTitle: string;
  activeChapter: { id: string; title: string; orderIndex: number } | null;
  /** 返回是否保存成功；失败（冲突/断网）就不要继续下载 */
  onBeforeExport: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点菜单外面、按 Esc 都收起来。不做这个，菜单会一直挂在页面上
  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  async function download(url: string) {
    setOpen(false);
    setBusy(true);

    try {
      const saved = await onBeforeExport();

      if (!saved) {
        return;
      }

      window.location.assign(url);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`导出「${projectTitle}」或当前章（txt / md）`}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
      >
        {busy ? "准备中…" : "导出"}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="导出选项"
          className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
        >
          <p className="px-3 py-1.5 text-xs text-slate-400">全书</p>
          <ExportItem
            label="纯文本（.txt）"
            onSelect={() => void download(`/api/projects/${projectId}/export?format=txt`)}
          />
          <ExportItem
            label="Markdown（.md）"
            onSelect={() => void download(`/api/projects/${projectId}/export?format=md`)}
          />

          {activeChapter && (
            <>
              <p className="mt-1 border-t border-slate-100 px-3 pb-1.5 pt-2 text-xs text-slate-400">
                当前章节
              </p>
              <ExportItem
                label="纯文本（.txt）"
                onSelect={() =>
                  void download(`/api/chapters/${activeChapter.id}/export?format=txt`)
                }
              />
              <ExportItem
                label="Markdown（.md）"
                onSelect={() =>
                  void download(`/api/chapters/${activeChapter.id}/export?format=md`)
                }
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ExportItem({
  label,
  onSelect,
}: {
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="block w-full px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 hover:text-blue-600"
    >
      {label}
    </button>
  );
}
