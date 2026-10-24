import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { API_ERROR_CODES } from "@/lib/log";
import {
  HttpClient,
  createChapter,
  createProject,
  deleteProjectQuietly,
  ensureAccount,
  expectFailure,
} from "./helpers";

/**
 * 账号数据管理：改昵称 / 改密码 / 注销账号。
 *
 * 这里的重点不是「功能能跑」，而是三件容易出事的地方：
 * 1. **改密码之后旧会话必须失效** —— 会话是 Cookie（JWT），
 *    服务端不存会话记录，改了密码如果不主动踢人，别人拿着旧 Cookie
 *    还能一直登到它自己过期；
 * 2. **注销要把关联数据删干净** —— 作品、章节、版本、AI 台账一条不留，
 *    不能出现"账号没了但数据还挂在库里"的孤儿；
 * 3. **注销/改密码前必须验当前密码** —— 光有登录态不够，
 *    否则一次 XSS 或者别人临时用一下你的电脑就能把账号删了。
 */
const USER = {
  name: "十期账号甲",
  email: "p10-account-a@test.local",
  password: "p10-account-a-123456",
};

const OTHER = {
  name: "十期账号乙",
  email: "p10-account-b@test.local",
  password: "p10-account-b-123456",
};

let user: HttpClient;
let other: HttpClient;

beforeAll(async () => {
  user = await ensureAccount(USER);
  other = await ensureAccount(OTHER);
});

afterAll(async () => {
  // 账号可能已经被「注销」用例删掉了，这里的清理失败就失败，不管
  for (const account of [USER, OTHER]) {
    const client = new HttpClient();

    if (await client.login(account.email, account.password)) {
      await client.del("/api/account", { password: account.password });
    }
  }
});

describe("账号信息", () => {
  it("未登录时三个接口都是 401", async () => {
    const anonymous = new HttpClient();

    expectFailure(
      await anonymous.json("/api/account"),
      401,
      API_ERROR_CODES.auth
    );
    expectFailure(await anonymous.patch("/api/account", { name: "谁" }), 401);
    expectFailure(
      await anonymous.del("/api/account", { password: "whatever-123" }),
      401
    );
  });

  it("读回来的是自己的邮箱和自己的数据量", async () => {
    const projectId = await createProject(user, "十期账号统计用作品");

    try {
      const chapterId = await createChapter(user, projectId, "第一章");
      await user.patch(`/api/chapters/${chapterId}`, {
        content: "写一句，好留下版本记录。",
      });

      const info = await user.json<{
        email: string;
        stats: { projects: number; chapters: number; revisions: number };
      }>("/api/account");

      expect(info.status).toBe(200);
      expect(info.body.email).toBe(USER.email);
      expect(info.body.stats.projects).toBeGreaterThan(0);
      expect(info.body.stats.chapters).toBeGreaterThan(0);
      expect(info.body.stats.revisions).toBeGreaterThan(0);
    } finally {
      await deleteProjectQuietly(user, projectId);
    }
  });

  it("改昵称成功，读回来是新昵称", async () => {
    const updated = await user.patch("/api/account", { name: "十期改名后" });

    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("十期改名后");

    const info = await user.json<{ name: string }>("/api/account");

    expect(info.body.name).toBe("十期改名后");

    // 改回去，别影响别的用例读到的名字
    await user.patch("/api/account", { name: USER.name });
  });

  it("昵称为空或超长是 400", async () => {
    expectFailure(await user.patch("/api/account", { name: "" }), 400);
    expectFailure(await user.patch("/api/account", { name: "  " }), 400);
    expectFailure(
      await user.patch("/api/account", { name: "长".repeat(51) }),
      400
    );
  });
});

describe("修改密码", () => {
  it("当前密码不对时是 400（不是 401），并且旧密码照常能登录", async () => {
    const response = await user.post("/api/account/password", {
      currentPassword: "绝对不是我的密码",
      newPassword: "brand-new-password-123",
    });

    // 关键：这里不能用 401 —— 前端的 401 处理是"直接踢回登录页"，
    // 而这里只是这一次输入错了
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(API_ERROR_CODES.credentials);

    const stillWorks = new HttpClient();

    expect(await stillWorks.login(USER.email, USER.password)).toBe(true);
  });

  it("新密码太短 / 与旧密码相同都是 400", async () => {
    expectFailure(
      await user.post("/api/account/password", {
        currentPassword: USER.password,
        newPassword: "short",
      }),
      400
    );

    expectFailure(
      await user.post("/api/account/password", {
        currentPassword: USER.password,
        newPassword: USER.password,
      }),
      400
    );
  });

  it("改密码成功后：旧密码登不上、新密码能登上、旧会话立即失效", async () => {
    const NEW_PASSWORD = "p10-account-a-new-987654";

    // 这个 client 是"另一台设备"：先登录拿到 Cookie，改密码之后再用它
    const otherDevice = new HttpClient();

    expect(await otherDevice.login(USER.email, USER.password)).toBe(true);
    expect((await otherDevice.json("/api/account")).status).toBe(200);

    try {
      const changed = await user.post("/api/account/password", {
        currentPassword: USER.password,
        newPassword: NEW_PASSWORD,
      });

      expect(changed.status).toBe(200);

      // ① 旧会话（改密码之前拿到的 Cookie）必须失效
      expectFailure(
        await otherDevice.json("/api/account"),
        401,
        API_ERROR_CODES.auth
      );

      // ② 旧密码不能再用
      const withOld = new HttpClient();

      expect(await withOld.login(USER.email, USER.password)).toBe(false);

      // ③ 新密码可以
      const withNew = new HttpClient();

      expect(await withNew.login(USER.email, NEW_PASSWORD)).toBe(true);
    } finally {
      // 无论断言成功还是失败，都把密码改回原样 ——
      // 否则这个文件第二次跑的时候，beforeAll 用旧密码登不上、
      // 会一路挂到"测试账号登录失败"，看着像功能坏了其实是测试自己没收拾干净
      const restore = new HttpClient();

      if (await restore.login(USER.email, NEW_PASSWORD)) {
        await restore.post("/api/account/password", {
          currentPassword: NEW_PASSWORD,
          newPassword: USER.password,
        });
      }

      user = await ensureAccount(USER);
    }
  });
});

describe("注销账号", () => {
  it("密码不对时不删任何东西（400）", async () => {
    const projectId = await createProject(user, "十期注销前保护");

    try {
      const attempt = await user.del("/api/account", { password: "错的密码" });

      expect(attempt.status).toBe(400);
      expect(attempt.body.code).toBe(API_ERROR_CODES.credentials);

      // 账号和作品都还在
      expect((await user.json("/api/account")).status).toBe(200);
      expect((await user.json(`/api/projects/${projectId}`)).status).toBe(200);
    } finally {
      await deleteProjectQuietly(user, projectId);
    }
  });

  it("注销后账号与全部关联数据都被删掉，不留孤儿", async () => {
    // 用专门的账号，避免把上面的 user 弄没了
    const victim = new HttpClient();
    const email = `p10-account-gone-${Date.now()}@test.local`;
    const password = "p10-account-gone-123456";

    const registered = await victim.post("/api/auth/register", {
      name: "十期待注销",
      email,
      password,
    });

    expect(registered.status).toBe(201);

    expect(await victim.login(email, password)).toBe(true);

    const projectId = await createProject(victim, "即将跟着账号一起消失");
    const chapterId = await createChapter(victim, projectId, "也会消失的一章");

    await victim.patch(`/api/chapters/${chapterId}`, {
      content: "写点东西，好让版本表和用量表都有记录。",
    });

    // 直接查库确认"注销前确实有数据"，否则这个用例可能什么都没验证到
    const before = {
      projects: await prisma.project.count({ where: { user: { email } } }),
      chapters: await prisma.chapter.count({
        where: { project: { user: { email } } },
      }),
      revisions: await prisma.revision.count({
        where: { chapter: { project: { user: { email } } } },
      }),
    };

    expect(before.projects).toBeGreaterThan(0);
    expect(before.chapters).toBeGreaterThan(0);
    expect(before.revisions).toBeGreaterThan(0);

    const removed = await victim.del("/api/account", { password });

    expect(removed.status).toBe(200);

    // ① 账号没了
    expect(
      await prisma.user.count({ where: { email } })
    ).toBe(0);

    // ② 作品 / 章节 / 版本一条不留（这个账号名下）
    expect(await prisma.project.count({ where: { user: { email } } })).toBe(0);
    expect(
      await prisma.chapter.count({ where: { project: { user: { email } } } })
    ).toBe(0);
    expect(
      await prisma.revision.count({
        where: { chapter: { project: { user: { email } } } },
      })
    ).toBe(0);
    expect(await prisma.aiUsage.count({ where: { user: { email } } })).toBe(0);

    // ③ 数据是真的没了，不是"换个账号还能看到"
    const afterLogin = new HttpClient();

    expect(await afterLogin.login(email, password)).toBe(false);

    expectFailure(
      await afterLogin.json(`/api/projects/${projectId}`),
      401,
      API_ERROR_CODES.auth
    );
  });

  it("注销只影响自己：乙注销后甲的数据还在", async () => {
    const projectId = await createProject(user, "十期的私有作品");

    try {
      // 路人乙注销
      const byeBye = new HttpClient();

      expect(await byeBye.login(OTHER.email, OTHER.password)).toBe(true);
      expect((await byeBye.del("/api/account", { password: OTHER.password })).status).toBe(
        200
      );

      // 甲的一切照旧
      expect((await user.json("/api/account")).status).toBe(200);
      expect((await user.json(`/api/projects/${projectId}`)).status).toBe(200);
    } finally {
      await deleteProjectQuietly(user, projectId);
    }
  });
});
