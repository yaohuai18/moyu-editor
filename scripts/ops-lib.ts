/**
 * 运维脚本的公共零件。
 *
 * 第十一阶段把「每天要看的东西」做成了三条命令：
 *   npm run ops:daily     日常检查（应用 / 登录 / 保存 / AI / 数据库 / 日志）
 *   npm run ops:db        数据库体检（容量 / 慢查询 / 索引 / 备份 / 迁移 / 孤立数据）
 *   npm run ops:ai        AI 使用情况（次数 / 耗时 / 失败率 / 限流 / 费用估算）
 *   npm run ops:release   发布流水线（五连检查 + 迁移 + 备份 + 部署清单）
 *
 * 这个文件只放它们共用的东西，不含任何业务判断。
 *
 * 两条铁律（和 src/lib/log.ts 一致）：
 *   1. **报告里不许出现密钥、Cookie、正文、完整连接串。**
 *      运维报告经常被截图发群里，是最容易泄漏的地方。
 *   2. **报告要能落成文件。** PowerShell 抓原生命令的中文输出会按 GBK 解码，
 *      直接看 stdout 经常是乱码；写 UTF-8 文件再打开才靠得住。
 */

import fs from "node:fs";
import path from "node:path";
import { loadEffectiveEnv } from "./env-file";

export const ROOT = process.cwd();

/** 报告里一行结果的级别 */
export type Level = "ok" | "warn" | "fail" | "info" | "skip";

const MARKS: Record<Level, string> = {
  ok: "[ok]  ",
  warn: "[warn]",
  fail: "[FAIL]",
  info: "[info]",
  skip: "[skip]",
};

const WIDTH = 78;

/** 一行分隔线 */
export function rule(char = "─") {
  return char.repeat(WIDTH);
}

export function nowStamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export function nowReadable() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return "未知";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(ms: number) {
  if (!Number.isFinite(ms)) return "未知";

  if (ms < 1000) return `${Math.round(ms)}ms`;

  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** 天数差（四舍五入到天） */
export function daysBetween(from: Date, to: Date = new Date()) {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 一份体检报告。
 *
 * 用法就三步：`add()` 记账 → `render()` 出文本 → `write()` 落文件。
 * 每条都带级别，最后按级别汇总 —— 「有几条要处理」比「一共几条」重要得多。
 */
export class Report {
  private lines: string[] = [];
  private counts: Record<Level, number> = {
    ok: 0,
    warn: 0,
    fail: 0,
    info: 0,
    skip: 0,
  };

  constructor(
    private title: string,
    private subtitle?: string
  ) {}

  /** 原样加一行（表格、说明文字用） */
  raw(text = "") {
    this.lines.push(text);
    return this;
  }

  /** 加一个小节标题 */
  head(text: string) {
    this.lines.push("");
    this.lines.push(rule());
    this.lines.push(text);
    this.lines.push(rule());
    return this;
  }

  /** 记一条结果。名字短一点、细节放 detail，报告才好扫 */
  add(level: Level, name: string, detail?: string) {
    this.counts[level] += 1;
    this.lines.push(
      `  ${MARKS[level]} ${name}${detail ? ` — ${detail}` : ""}`
    );
    return this;
  }

  ok(name: string, detail?: string) {
    return this.add("ok", name, detail);
  }

  warn(name: string, detail?: string) {
    return this.add("warn", name, detail);
  }

  fail(name: string, detail?: string) {
    return this.add("fail", name, detail);
  }

  info(name: string, detail?: string) {
    return this.add("info", name, detail);
  }

  skip(name: string, detail?: string) {
    return this.add("skip", name, detail);
  }

  get summary() {
    return { ...this.counts };
  }

  /** 有没有「必须处理」的项 —— 决定退出码 */
  get hasFailure() {
    return this.counts.fail > 0;
  }

  render() {
    const out: string[] = [];

    out.push(this.title);
    if (this.subtitle) out.push(this.subtitle);
    out.push(`时间：${nowReadable()}`);
    out.push(`目录：${ROOT}`);
    out.push(...this.lines);

    out.push("");
    out.push(rule());
    out.push("汇总");
    out.push(rule());
    out.push(
      `  通过 ${this.counts.ok} ｜ 提醒 ${this.counts.warn} ｜ ` +
        `必须处理 ${this.counts.fail} ｜ 跳过 ${this.counts.skip} ｜ 说明 ${this.counts.info}`
    );
    out.push("");

    if (this.counts.fail > 0) {
      out.push("  ✘ 有「必须处理」的项目，退出码非 0。");
    } else if (this.counts.warn > 0) {
      out.push("  △ 没有必须处理的项，但有值得看一眼的项。");
    } else {
      out.push("  ✔ 全部正常。");
    }

    out.push("");

    return out.join("\n");
  }

  /** 落成 UTF-8 文件，返回相对路径。写不出来不抛异常（报告不该把命令搞崩） */
  write(dirName = "ops-reports", prefix = "report") {
    const target = path.isAbsolute(dirName) ? dirName : path.join(ROOT, dirName);

    try {
      fs.mkdirSync(target, { recursive: true });

      const file = path.join(target, `${prefix}-${nowStamp()}.txt`);

      fs.writeFileSync(file, this.render(), "utf8");

      return path.relative(ROOT, file).replace(/\\/g, "/");
    } catch {
      return null;
    }
  }

  /** 同时打到终端和文件 */
  print() {
    const text = this.render();

    process.stdout.write(`${text}\n`);

    return text;
  }
}

/**
 * 带 Cookie 罐的 HTTP 客户端。
 *
 * Node 的 fetch 不会自己记住 Cookie，而登录态就是靠 Cookie 传的，
 * 所以得手动接住 Set-Cookie 再发回去。
 *
 * 这里刻意不 import tests/api/helpers.ts 里那个同名东西 ——
 * 那个文件 import 了 vitest，运维脚本不想被测试框架拴住。
 */
export class OpsClient {
  private cookies = new Map<string, string>();

  constructor(private baseUrl: string) {}

  get base() {
    return this.baseUrl;
  }

  private cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorb(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";")[0];
      const eq = pair.indexOf("=");

      if (eq <= 0) continue;

      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);

      if (value === "") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  get cookieCount() {
    return this.cookies.size;
  }

  async raw(pathname: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);

    if (this.cookies.size > 0) {
      headers.set("Cookie", this.cookieHeader());
    }

    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });

    this.absorb(response);

    return response;
  }

  async json<T = Record<string, unknown>>(
    pathname: string,
    init: RequestInit = {}
  ): Promise<{ status: number; body: T }> {
    const response = await this.raw(pathname, init);
    const text = await response.text();

    let body: unknown = null;

    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 200) };
    }

    return { status: response.status, body: body as T };
  }

  post(pathname: string, payload?: unknown) {
    return this.json(pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
  }

  patch(pathname: string, payload?: unknown) {
    return this.json(pathname, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
  }

  /**
   * 邮箱密码登录。
   *
   * Auth.js 的表单登录要两步：先拿 CSRF token，再带着 token 和 Cookie
   * 去 POST /api/auth/callback/credentials。少一步会被当成伪造请求。
   * 最后用 /api/auth/session 确认真的登上去了，而不是只看状态码。
   */
  async login(email: string, password: string) {
    const csrf = await this.json<{ csrfToken?: string }>("/api/auth/csrf");

    if (!csrf.body?.csrfToken) {
      return false;
    }

    await this.raw("/api/auth/callback/credentials", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Auth-Return-Redirect": "1",
      },
      body: new URLSearchParams({
        csrfToken: csrf.body.csrfToken,
        email,
        password,
        callbackUrl: `${this.baseUrl}/`,
      }).toString(),
    });

    const session = await this.json<{ user?: { email?: string } }>(
      "/api/auth/session"
    );

    return Boolean(session.body?.user);
  }

  /** 退出登录 */
  async logout() {
    const csrf = await this.json<{ csrfToken?: string }>("/api/auth/csrf");

    if (csrf.body?.csrfToken) {
      await this.raw("/api/auth/signout", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Auth-Return-Redirect": "1",
        },
        body: new URLSearchParams({
          csrfToken: csrf.body.csrfToken,
        }).toString(),
      });
    }

    this.cookies.clear();
  }
}

/**
 * 检查地址上有没有人在听。
 *
 * 用 `HEAD /` 而不是 `/api/health`：这一步只是想确认「有没有服务」，
 * 健康与否交给后面那一步专门判。
 */
export async function probeAlive(baseUrl: string, timeoutMs = 3000) {
  try {
    await fetch(baseUrl, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * 按项目自己的 .env 打开一个 Prisma 客户端。
 *
 * 为什么不用 `import { prisma } from "@/lib/prisma"`：
 * 那个模块走的是 Next 的路径别名和单例，只在 Next 运行时里成立；
 * 脚本里得自己把 DATABASE_URL 摆好再动态 import。
 *
 * ⚠️ 这里**只读**。运维脚本不写业务数据 ——
 * 唯一会写的是「发布前备份」，那个走 npm run db:backup。
 */
export async function openOpsPrisma() {
  const { env, files, origin } = loadEffectiveEnv(ROOT);

  if (!env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL 没配置（.env 里应该有），不知道该连哪个库。"
    );
  }

  process.env.DATABASE_URL = env.DATABASE_URL;

  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient();

  // 连得上再往下走，省得后面每条都在报同一个错
  await client.$queryRawUnsafe("SELECT 1");

  return {
    prisma: client,
    env,
    envFiles: files,
    /** 每个变量是从哪个文件来的，排查「改了没生效」时有用 */
    envOrigin: origin,
  };
}

/**
 * DATABASE_URL 指向的 SQLite 文件路径（托管数据库返回 null）。
 * 需要 stat 文件大小、判断库在哪的时候用。
 */
export function sqliteFilePath(databaseUrl: string) {
  if (!databaseUrl.startsWith("file:")) {
    return null;
  }

  const raw = databaseUrl.replace(/^file:/, "").split("?")[0];

  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, "prisma", raw);
}

/**
 * 从日志文本里数出「每种错误编号出现了几次」。
 *
 * 认得 src/lib/log.ts 的 `[CODE] {"...":...}` 单行格式。
 * 这个正则有意写得宽松一点：格式未来微调（比如多打一个字段）也不该让统计归零。
 */
export function countLogCodes(text: string) {
  const counts = new Map<string, number>();
  let matched = 0;

  for (const match of text.matchAll(/\[([A-Z][A-Z0-9_]{3,40})\]/g)) {
    const code = match[1];

    // 日志里还有 [ok] / [warn] 这种小写短标签，上面的正则已经把它们排除了；
    // 这里再挡一下 Next.js 自己的 [Error] / [WebServer] 之类
    if (!/^[A-Z][A-Z0-9_]+$/.test(code)) continue;

    counts.set(code, (counts.get(code) ?? 0) + 1);
    matched += 1;
  }

  return { counts, matched };
}
