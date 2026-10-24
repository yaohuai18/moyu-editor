/**
 * 统一的错误记录（生产环境排查用）。
 *
 * 两条铁律：
 * 1. **只记「谁的、哪儿的、什么错」，不记正文和凭据。**
 *    日志文件往往比数据库更宽松（会同步到日志平台、会被运维翻看），
 *    所以密码、Cookie、Authorization、API Key、数据库连接串、
 *    用户正文这两个字在这里一律不许出现。
 * 2. **错误编号固定不变。**用户截图报错时，看到 `AI_PROVIDER_ERROR`
 *    就能直接定位到是哪一段代码打的日志，不需要他描述「点了哪个按钮」。
 *
 * 编号是给「排查」用的，所以对外只暴露粗粒度的那几个（见 API_ERROR_CODES），
 * 具体到「是数据库连不上还是表不存在」这类细节只进服务端日志。
 */

/** 全量错误编号（服务端日志用） */
export type ErrorCode =
  // 账户
  | "AUTH_FAILED" // 未登录 / 会话失效
  | "LOGIN_FAILED" // 邮箱密码不对
  | "REGISTER_FAILED" // 注册失败
  | "ACCOUNT_UPDATED" // 昵称等资料被改（非错误，留痕用）
  | "PASSWORD_CHANGED" // 密码被改（非错误，留痕用）
  | "PASSWORD_MISMATCH" // 改密码/注销时当前密码填错
  | "ACCOUNT_DELETED" // 账号及其全部数据被删（非错误，留痕用）
  // 权限
  | "PROJECT_ACCESS_DENIED" // 作品不是你 的（403）
  | "PROJECT_NOT_FOUND" // 作品不存在（404）
  | "CHAPTER_ACCESS_DENIED"
  | "CHAPTER_NOT_FOUND"
  // 入参
  | "VALIDATION_FAILED" // 参数不合法（400）
  | "PAYLOAD_TOO_LARGE" // 正文超长（400）
  // 频控与额度
  | "RATE_LIMITED" // 每分钟次数超了（429）
  | "DAILY_QUOTA_EXCEEDED" // 今日额度用完（429）
  // 并发
  | "VERSION_CONFLICT" // 别人先存了（409）
  // AI
  | "AI_NOT_CONFIGURED" // 服务端没配 Key（503）
  | "AI_PROVIDER_ERROR" // 上游报错（502）
  | "AI_INVALID_FORMAT" // 上游返回解析不了（502）
  | "AI_EMPTY_RESPONSE" // 上游返回空（502）
  // 数据库 / 兜底
  | "DATABASE_ERROR"
  | "UNKNOWN_ERROR";

/** 日志里允许出现的上下文字段（白名单，其余一律丢掉） */
export type LogContext = {
  /** 用户 id（不是邮箱，id 本身无法登录） */
  userId?: string | null;
  projectId?: string | null;
  chapterId?: string | null;
  /** AI 调用模式：diagnose / polish */
  mode?: string | null;
  /** 上游 HTTP 状态码之类的一行说明，**不许塞正文** */
  detail?: string | null;
  /** 耗时（毫秒），排查慢请求用 */
  durationMs?: number | null;
  /** 接口层要回的 HTTP 状态码 */
  status?: number | null;
};

/** detail 最多留这么长，防止有人不小心把正文塞进来 */
const DETAIL_MAX_LENGTH = 200;

/**
 * 把一段可能很长的文本压成一行短说明。
 * 换行会破坏日志的一行一条结构，所以一并压平。
 */
function shrinkDetail(detail: string) {
  const oneLine = detail.replace(/\s+/g, " ").trim();

  return oneLine.length > DETAIL_MAX_LENGTH
    ? `${oneLine.slice(0, DETAIL_MAX_LENGTH)}…`
    : oneLine;
}

/**
 * 记录一条错误日志。
 *
 * 用 console.error 是因为它同时满足两个场景：
 *   - 本地 / 自建服务器：直接进终端和 nohup 日志文件
 *   - Vercel / 各类托管平台：平台会自动按 stderr 收集并按级别告警
 * 以后接入 Sentry 之类的服务时，只要改这一个函数，所有调用点都跟着生效。
 */
export function logError(code: ErrorCode, context: LogContext = {}) {
  const payload: Record<string, unknown> = { code };

  if (context.userId) payload.userId = context.userId;
  if (context.projectId) payload.projectId = context.projectId;
  if (context.chapterId) payload.chapterId = context.chapterId;
  if (context.mode) payload.mode = context.mode;
  if (typeof context.status === "number") payload.status = context.status;
  if (typeof context.durationMs === "number") payload.durationMs = context.durationMs;
  if (context.detail) payload.detail = shrinkDetail(context.detail);

  // 单行输出：`[错误编号] {字段}`。用 JSON 是为了以后接日志平台能直接解析。
  console.error(`[${code}]`, JSON.stringify(payload));
}

/**
 * 记录「非致命但值得看一眼」的情况，例如用量落库失败。
 * 这类失败不应该把已经返回给用户的 AI 结果弄没，所以单独一个函数提醒自己。
 */
export function logWarn(code: ErrorCode, context: LogContext = {}) {
  const payload: Record<string, unknown> = { code };

  if (context.userId) payload.userId = context.userId;
  if (context.projectId) payload.projectId = context.projectId;
  if (context.chapterId) payload.chapterId = context.chapterId;
  if (context.mode) payload.mode = context.mode;
  if (context.detail) payload.detail = shrinkDetail(context.detail);

  console.warn(`[${code}]`, JSON.stringify(payload));
}

/** Prisma 的报错都带一个 P 开头的 code（P1001 连不上、P2025 记录不存在……） */
function prismaErrorCode(error: unknown): string | null {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;

    return typeof code === "string" ? code : null;
  }

  return null;
}

/**
 * AI 侧的四个错误编号（与 src/lib/ai.ts 的 AiErrorCode 一致）。
 *
 * 这里**故意不从 ai.ts import** —— ai.ts 顶部有一道「被客户端组件 import 就抛错」
 * 的护栏，把 log.ts 和它绑在一起会让日志这个基础模块平白多一层依赖。
 * 用结构化的方式认（看有没有这四个 code 之一），够用且不引入耦合。
 */
const AI_ERROR_CODES = new Set<string>([
  "AI_NOT_CONFIGURED",
  "AI_PROVIDER_ERROR",
  "AI_EMPTY_RESPONSE",
  "AI_INVALID_FORMAT",
]);

/**
 * 认一下这个异常是不是 AiError。
 *
 * 第十一阶段补的：以前 AI 上游挂掉时，日志里打的是 `[UNKNOWN_ERROR]`，
 * 而运维手册让人去搜 `AI_PROVIDER_ERROR` —— 搜不到。
 * 错误编号的价值就在于「能搜到」，认错了等于白记。
 */
function aiErrorCode(error: unknown): ErrorCode | null {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;

    if (typeof code === "string" && AI_ERROR_CODES.has(code)) {
      return code as ErrorCode;
    }
  }

  return null;
}

/**
 * 把任意异常归类到一个错误编号。
 * 只用来决定日志里打哪个编号，不改变对外的响应。
 */
export function classifyError(error: unknown): ErrorCode {
  // AI 侧先认：AiError 也是 Error，且它的 code 不是 Prisma 的 P 开头
  const aiCode = aiErrorCode(error);

  if (aiCode) {
    return aiCode;
  }

  const prismaCode = prismaErrorCode(error);

  if (prismaCode) {
    // P2025 = 要操作的记录不存在，属于「用户操作的对象没了」，不是数据库故障
    if (prismaCode === "P2025") {
      return "CHAPTER_NOT_FOUND";
    }

    return "DATABASE_ERROR";
  }

  if (error instanceof Error && error.name === "ZodError") {
    return "VALIDATION_FAILED";
  }

  return "UNKNOWN_ERROR";
}

/**
 * 从异常里取一段**安全**的说明：只要类名和 Prisma 错误码，
 * 不要 message —— Prisma 的初始化错误里可能带连接串片段，
 * 上游 SDK 的报错里可能带请求头。
 */
export function safeErrorDetail(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = prismaErrorCode(error);

  return code ? `${name}:${code}` : name;
}

/**
 * 接口 catch 块里的统一出口。
 *
 * 存在的意义主要是**替换掉 `console.error(error)`** ——
 * 那个写法会把整个异常对象连同堆栈丢进日志，而 Prisma 的初始化异常
 * message 里是带连接串的。这里只留类名和错误码，够定位就行。
 *
 * 返回归好类的错误编号，调用方如果想在响应里带个 code 可以直接用。
 */
export function logRouteError(error: unknown, context: LogContext = {}) {
  const code = classifyError(error);

  logError(code, {
    ...context,
    detail: context.detail ?? safeErrorDetail(error),
    status: context.status ?? 500,
  });

  return code;
}

/**
 * 给用户看的错误编号。
 *
 * 有意比内部编号更粗：用户不需要知道「是 P1001 还是 P2002」，
 * 只需要一个能在日志里搜到的标签。
 */
export const API_ERROR_CODES = {
  auth: "AUTH_FAILED",
  access: "PROJECT_ACCESS_DENIED",
  validation: "VALIDATION_FAILED",
  /** 改密码/注销时当前密码不对。刻意用 400 而不是 401 —— 401 会被前端当成
   *  「会话过期」直接踢回登录页，而这里只是这一次输入错了。 */
  credentials: "INVALID_CREDENTIALS",
  rateLimited: "RATE_LIMITED",
  quota: "DAILY_QUOTA_EXCEEDED",
  conflict: "VERSION_CONFLICT",
  ai: "AI_PROVIDER_ERROR",
  database: "DATABASE_ERROR",
} as const;
