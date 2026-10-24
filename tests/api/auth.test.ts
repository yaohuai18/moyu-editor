import { describe, expect, it } from "vitest";
import { API_ERROR_CODES } from "@/lib/log";
import { BASE_URL, HttpClient, ensureAccount, expectFailure } from "./helpers";

/**
 * 账户流程。
 *
 * 这一段是全站的地基：登录态一错，作品、章节、AI 全都跟着错，
 * 而且错法往往是「看起来能用，其实谁都能看别人的东西」。
 * 所以这里不光测「能登录」，更要测「登不上时是真的登不上」。
 */
const ACCOUNT = {
  name: "九期账号",
  email: "p9-account@test.local",
  password: "p9-account-123456",
};

describe("服务可达性", () => {
  it("健康检查能打开（说明服务已经在跑）", async () => {
    const client = new HttpClient();
    const response = await client.json("/api/health");

    expect(response.status, `连不上 ${BASE_URL}，请用 npm run test:api 启动`).toBe(200);
  });
});

describe("注册", () => {
  it("新邮箱可以注册，返回 201 且不回传密码", async () => {
    const client = new HttpClient();
    const email = `p9-reg-${Date.now()}@test.local`;

    const response = await client.post("/api/auth/register", {
      name: "九期新用户",
      email,
      password: "p9-register-123456",
    });

    expect(response.status).toBe(201);
    expect(response.body.email).toBe(email);
    // 响应里绝不能出现密码或哈希
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    expect(JSON.stringify(response.body)).not.toContain("p9-register-123456");
  });

  it("同一个邮箱注册两次，第二次 409", async () => {
    const client = new HttpClient();
    const email = `p9-dup-${Date.now()}@test.local`;
    const payload = { name: "重复", email, password: "p9-duplicate-123456" };

    const first = await client.post("/api/auth/register", payload);
    const second = await client.post("/api/auth/register", payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });

  it("密码太短或邮箱格式不对，一律 400", async () => {
    const client = new HttpClient();

    const shortPassword = await client.post("/api/auth/register", {
      name: "短密码",
      email: `p9-short-${Date.now()}@test.local`,
      password: "123",
    });

    const badEmail = await client.post("/api/auth/register", {
      name: "坏邮箱",
      email: "not-an-email",
      password: "p9-bademail-123456",
    });

    expect(shortPassword.status).toBe(400);
    expect(badEmail.status).toBe(400);
  });
});

describe("登录与退出", () => {
  it("密码正确能登录，会话里拿得到用户", async () => {
    const client = await ensureAccount(ACCOUNT);

    const session = await client.json<{ user?: { email?: string } }>(
      "/api/auth/session"
    );

    expect(session.body?.user?.email).toBe(ACCOUNT.email);
  });

  it("密码错误登录不上，拿不到会话（而且不告诉你错在哪）", async () => {
    const client = new HttpClient();
    const ok = await client.login(ACCOUNT.email, "definitely-wrong-password");

    expect(ok).toBe(false);

    const session = await client.json<{ user?: unknown }>("/api/auth/session");

    expect(session.body?.user).toBeFalsy();
  });

  it("不存在的邮箱登录不上", async () => {
    const client = new HttpClient();

    expect(await client.login("nobody@test.local", "whatever-123456")).toBe(false);
  });

  it("退出登录之后会话就没了", async () => {
    const client = await ensureAccount(ACCOUNT);

    expect(
      (await client.json<{ user?: unknown }>("/api/auth/session")).body?.user
    ).toBeTruthy();

    await client.logout();

    const after = await client.json<{ user?: unknown }>("/api/auth/session");

    expect(after.body?.user).toBeFalsy();
  });
});

describe("未登录访问受保护接口", () => {
  it("作品列表 401", async () => {
    const anonymous = new HttpClient();

    expectFailure(await anonymous.json("/api/projects"), 401, API_ERROR_CODES.auth);
  });

  it("新建作品 401", async () => {
    const anonymous = new HttpClient();

    expectFailure(await anonymous.post("/api/projects", { title: "偷建" }), 401);
  });

  it("AI 接口 401（不然谁都能烧你的额度）", async () => {
    const anonymous = new HttpClient();

    expectFailure(
      await anonymous.post("/api/ai/edit", {
        projectId: "x",
        chapterId: "y",
        content: "随便写点什么",
        mode: "polish",
      }),
      401
    );
  });

  it("AI 用量查询 401", async () => {
    const anonymous = new HttpClient();

    expectFailure(await anonymous.json("/api/ai/usage"), 401);
  });

  it("健康检查不需要登录（监控探针要能直接打）", async () => {
    const anonymous = new HttpClient();

    expect((await anonymous.json("/api/health")).status).toBe(200);
  });
});
