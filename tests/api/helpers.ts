/**
 * 接口测试的公共工具。
 *
 * 这里做三件事：
 * 1. 一个「带 Cookie 罐」的 fetch 封装 —— 登录一次，后续请求自动带上会话；
 * 2. 账号/作品的建与清，保证测试可以反复跑而不互相污染；
 * 3. 断言用的小工具（期望状态码 + 期望错误编号）。
 *
 * ⚠️ 这些测试打的是**真实的 HTTP 接口**，不是内存里调函数。
 * 所以它们能测出「路由写错了」「鉴权漏了」这类单元测试永远测不出来的问题。
 * 前提是网站跑着（`npm run test:api` 会自己起一个连测试库的实例）。
 */
import { expect } from "vitest";

export const BASE_URL = process.env.MOYU_BASE_URL || "http://127.0.0.1:3002";

/** 假 AI 服务，用来验证限流真的生效 */
export const FAKE_AI_URL = process.env.FAKE_AI_URL || "http://127.0.0.1:11499";

type Json = Record<string, unknown> | unknown[] | null;

/**
 * 一个最小的 Cookie 罐。
 * Node 的 fetch 不会自己记住 Cookie，而登录态就是靠 Cookie 传递的，
 * 所以得手动接住 Set-Cookie 再发回去。
 */
export class HttpClient {
  private cookies = new Map<string, string>();

  constructor(private baseUrl: string = BASE_URL) {}

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

      // 值被清空 = 服务端让这个 Cookie 失效（登出就是这么做的）
      if (value === "") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  /** 清掉所有本地 Cookie（模拟"这是一个全新浏览器"） */
  clearCookies() {
    this.cookies.clear();
  }

  async raw(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);

    if (this.cookies.size > 0) {
      headers.set("Cookie", this.cookieHeader());
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });

    this.absorb(response);

    return response;
  }

  async json<T = Json>(path: string, init: RequestInit = {}): Promise<{
    status: number;
    body: T & Record<string, unknown>;
  }> {
    const response = await this.raw(path, init);
    const text = await response.text();

    let body: unknown = null;

    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }

    return { status: response.status, body: body as T & Record<string, unknown> };
  }

  post(path: string, payload?: unknown) {
    return this.json(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
  }

  patch(path: string, payload?: unknown) {
    return this.json(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
  }

  /**
   * DELETE。可以带 JSON body —— 注销账号这种不可逆操作要求再输一次密码，
   * 密码就是放在 body 里的（不放 query，免得被写进访问日志）。
   */
  del(path: string, payload?: unknown) {
    return this.json(path, {
      method: "DELETE",
      ...(payload === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
    });
  }

  /**
   * 用邮箱密码登录。
   *
   * Auth.js 的表单登录要两步：先拿 CSRF token，再带着 token 和 Cookie
   * 去 POST /api/auth/callback/credentials —— 少一步都会被当成伪造请求。
   * 最后用 /api/auth/session 确认「真的登上去了」，而不是只看状态码。
   */
  async login(email: string, password: string): Promise<boolean> {
    const csrf = await this.json<{ csrfToken: string }>("/api/auth/csrf");

    if (!csrf.body?.csrfToken) {
      return false;
    }

    const form = new URLSearchParams({
      csrfToken: csrf.body.csrfToken,
      email,
      password,
      callbackUrl: `${this.baseUrl}/`,
    });

    await this.raw("/api/auth/callback/credentials", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Auth-Return-Redirect": "1",
      },
      body: form.toString(),
    });

    const session = await this.json<{ user?: { email?: string } }>(
      "/api/auth/session"
    );

    return Boolean(session.body?.user);
  }

  /** 退出登录（清掉服务端会话 Cookie） */
  async logout() {
    const csrf = await this.json<{ csrfToken: string }>("/api/auth/csrf");

    if (csrf.body?.csrfToken) {
      await this.raw("/api/auth/signout", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Auth-Return-Redirect": "1",
        },
        body: new URLSearchParams({ csrfToken: csrf.body.csrfToken }).toString(),
      });
    }

    this.clearCookies();
  }
}

export type TestAccount = {
  name: string;
  email: string;
  password: string;
};

/**
 * 拿一个可用的账号：先试登录，登不上就注册。
 * 这样测试可以反复跑 —— 第二次跑不会因为「邮箱已注册」而挂掉。
 */
export async function ensureAccount(account: TestAccount) {
  const client = new HttpClient();

  if (await client.login(account.email, account.password)) {
    return client;
  }

  await client.post("/api/auth/register", {
    name: account.name,
    email: account.email,
    password: account.password,
  });

  const ok = await client.login(account.email, account.password);

  if (!ok) {
    throw new Error(`测试账号登录失败：${account.email}（请检查测试库是否已迁移）`);
  }

  return client;
}

/** 建一个作品，返回 id */
export async function createProject(client: HttpClient, title: string) {
  const response = await client.post("/api/projects", { title, genre: "测试" });

  expect(response.status, `新建作品应返回 201，实际 ${response.status}`).toBe(201);

  return response.body.id as string;
}

/** 建一章，返回 id */
export async function createChapter(
  client: HttpClient,
  projectId: string,
  title: string
) {
  const response = await client.post(`/api/projects/${projectId}/chapters`, {
    title,
  });

  expect(response.status, `新建章节应返回 201，实际 ${response.status}`).toBe(201);

  return response.body.id as string;
}

/** 删掉作品，收尾用（作品不存在也不报错） */
export async function deleteProjectQuietly(
  client: HttpClient,
  projectId: string
) {
  await client.del(`/api/projects/${projectId}`).catch(() => undefined);
}

/**
 * 断言一个响应是「某种失败」，并且带上了对的错误编号。
 * 顺手把错误编号也查了 —— 这些编号是给用户报错时对照日志用的，
 * 少了它们排查就得靠猜。
 */
export function expectFailure(
  response: { status: number; body: Record<string, unknown> },
  status: number,
  code?: string
) {
  expect(response.status).toBe(status);

  if (code) {
    expect(response.body.code).toBe(code);
  }
}
