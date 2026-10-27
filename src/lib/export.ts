/**
 * 导出：把作品变成「能带走」的文件。
 *
 * 为什么只做 txt 和 Markdown：
 * 用户要的是「稿子离开这个站还能用」。txt 能被任何编辑器、任何写作平台
 * 直接粘贴；md 多了章节层级，方便再排版。做 docx/pdf 得引一堆依赖，
 * 对「把作品搬去别处」这个真实需求没有额外帮助，反而更难验证。
 *
 * 这个文件里全是纯函数，不碰数据库也不碰网络 —— 所以能单测，
 * 也能被接口和页面共用。
 */

export const EXPORT_FORMATS = ["txt", "md"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const DEFAULT_EXPORT_FORMAT: ExportFormat = "txt";

/** 浏览器靠 Content-Type 决定怎么打开下载的文件；charset 必须写，否则中文会乱码 */
export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};

export function isExportFormat(value: unknown): value is ExportFormat {
  return (
    typeof value === "string" &&
    (EXPORT_FORMATS as readonly string[]).includes(value)
  );
}

/** 把 URL 上的 ?format= 变成合法格式。不认识的值一律按默认 txt 处理，不报错。 */
export function parseExportFormat(
  value: string | null | undefined
): ExportFormat {
  return isExportFormat(value) ? value : DEFAULT_EXPORT_FORMAT;
}

// ---------------------------------------------------------------------------
// 文件名
// ---------------------------------------------------------------------------

/** Windows 不允许 \ / : * ? " < > |，控制字符也不行 */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * 清洗文件名里的非法字符。
 *
 * 除了非法字符，还要处理两个坑：连续空白压成一个空格；结尾的点和空格
 * 会被 Windows 静默吃掉，必须提前去掉（否则「第3章.」和「第3章」会打架）。
 */
export function sanitizeFilenamePart(
  name: string,
  fallback = "未命名"
): string {
  const cleaned = name
    .replace(ILLEGAL_FILENAME_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");

  return cleaned || fallback;
}

/** 文件名太长在 Windows 上会出问题，截断后再清一次尾部标点 */
function clampFilenamePart(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  /**
   * 按「码点」切，不能按 UTF-16 码元切。
   *
   * 一个 emoji（比如 😀）在 JS 里占两个码元，`slice(0, max)` 很可能正好切在
   * 它中间，留下半个代理项。半个代理项是非法字符串，后面
   * `encodeURIComponent` 会直接抛 URIError，整个导出接口变成 500 —— 用户看到
   * 的就是「点导出没反应」或者「页面跳到一个报错 JSON」。
   *
   * Array.from 按码点拆分，emoji 整体保留或整体丢弃，不会切一半。
   */
  const chars = Array.from(value).slice(0, max).join("");
  const sliced = chars.replace(/[.\s]+$/, "");

  return sliced || chars;
}

// ---------------------------------------------------------------------------
// 内容
// ---------------------------------------------------------------------------

export type ExportChapter = {
  title: string;
  content: string;
  /** 0 开始，跟数据库里的 Chapter.orderIndex 一致；显示时 +1 */
  orderIndex: number;
};

export type ExportProject = {
  title: string;
  genre?: string | null;
  description?: string | null;
};

/** 导出时的章节标题：「第 3 章 标题」。标题是空的就只留「第 3 章」。 */
export function chapterHeading(orderIndex: number, title: string): string {
  const number = orderIndex + 1;
  const trimmed = title.trim();

  return trimmed ? `第 ${number} 章 ${trimmed}` : `第 ${number} 章`;
}

/**
 * 正文规范化。
 *
 * 统一换行符（从别处粘进来的稿子常带 \r\n），去掉尾部空行 ——
 * 拼接时我们自己控制空行，正文自带的尾部空白会让章节间距忽大忽小。
 */
function chapterBody(content: string): string {
  return content.replace(/\r\n/g, "\n").trimEnd();
}

/** 无章节时的占位。导出空文件会让人以为「导出坏了」，一句话说明更清楚。 */
const EMPTY_PROJECT_NOTICE = "（这本书还没有章节）";

function buildProjectPlainText(
  title: string,
  chapters: ExportChapter[]
): string {
  const blocks: string[] = [title];

  if (chapters.length === 0) {
    blocks.push(EMPTY_PROJECT_NOTICE);

    return blocks.join("\n\n\n");
  }

  for (const chapter of chapters) {
    const heading = chapterHeading(chapter.orderIndex, chapter.title);
    const body = chapterBody(chapter.content);

    blocks.push(body ? `${heading}\n\n${body}` : heading);
  }

  // 章节之间空两行（三个换行）：粘到任何平台都能一眼看清分章
  return blocks.join("\n\n\n");
}

function buildProjectMarkdown(
  title: string,
  project: ExportProject,
  chapters: ExportChapter[]
): string {
  const lines: string[] = [`# ${title}`, ""];

  const meta: string[] = [];

  if (project.genre?.trim()) {
    meta.push(`分类：${project.genre.trim()}`);
  }

  meta.push(`共 ${chapters.length} 章`);

  lines.push(`> ${meta.join(" · ")}`, "");

  if (project.description?.trim()) {
    lines.push(project.description.trim(), "");
  }

  if (chapters.length === 0) {
    lines.push(EMPTY_PROJECT_NOTICE);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  for (const chapter of chapters) {
    lines.push(`## ${chapterHeading(chapter.orderIndex, chapter.title)}`, "");

    const body = chapterBody(chapter.content);

    if (body) {
      lines.push(body, "");
    }
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** 全书导出内容 */
export function buildProjectExport(
  project: ExportProject,
  chapters: ExportChapter[],
  format: ExportFormat
): string {
  const title = project.title.trim() || "未命名作品";

  return format === "md"
    ? buildProjectMarkdown(title, project, chapters)
    : buildProjectPlainText(title, chapters);
}

/** 单章导出内容 */
export function buildChapterExport(
  chapter: ExportChapter,
  format: ExportFormat
): string {
  const heading = chapterHeading(chapter.orderIndex, chapter.title);
  const body = chapterBody(chapter.content);

  if (format === "md") {
    return body ? `# ${heading}\n\n${body}\n` : `# ${heading}\n`;
  }

  return body ? `${heading}\n\n${body}\n` : `${heading}\n`;
}

// ---------------------------------------------------------------------------
// 文件名 + 下载响应头
// ---------------------------------------------------------------------------

/** 全书文件名：`作品名.txt` */
export function buildProjectExportFilename(
  projectTitle: string,
  format: ExportFormat
): string {
  const base = clampFilenamePart(
    sanitizeFilenamePart(projectTitle, "未命名作品"),
    60
  );

  return `${base}.${format}`;
}

/** 单章文件名：`作品名-第3章 标题.txt` */
export function buildChapterExportFilename(
  projectTitle: string,
  chapter: Pick<ExportChapter, "title" | "orderIndex">,
  format: ExportFormat
): string {
  // 作品名只留 20 字：单章文件名要同时装下书名和章名，总长得控制住
  const project = clampFilenamePart(
    sanitizeFilenamePart(projectTitle, "未命名作品"),
    20
  );

  const chapterName = clampFilenamePart(
    sanitizeFilenamePart(
      chapterHeading(chapter.orderIndex, chapter.title),
      "未命名章节"
    ),
    40
  );

  return `${project}-${chapterName}.${format}`;
}

/**
 * 生成 Content-Disposition。
 *
 * 中文文件名不能直接塞进 filename=，老浏览器会乱码 —— 那正是「导出功能
 * 看起来坏了」的经典原因。所以同时给两份：
 *   filename=      纯 ASCII 兜底（中文替换成下划线）
 *   filename*=     RFC 5987 的 UTF-8 百分号编码，现代浏览器优先用它
 *
 * encodeURIComponent 不编码 ' ( ) ! *，但 RFC 5987 要求这几个也转义，
 * 否则某些浏览器会拒绝整个头部。
 */
export function contentDispositionHeader(filename: string): string {
  const asciiFallback = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");

  const encoded = encodeRfc5987(filename) ?? encodeRfc5987(asciiFallback) ?? "";

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * RFC 5987 的百分号编码。
 *
 * encodeURIComponent 本身不编码 ' ( ) ! *，但 RFC 5987 要求这几个也转义，
 * 否则某些浏览器会拒绝整个头部。
 *
 * 传进来非法字符串（比如被截断的半个 emoji）时 encodeURIComponent 会抛
 * URIError，这里返回 null 交给调用方降级 —— 文件名再难看得好过整个导出 500。
 */
function encodeRfc5987(value: string): string | null {
  try {
    return encodeURIComponent(value).replace(
      /['()!*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
  } catch {
    return null;
  }
}
