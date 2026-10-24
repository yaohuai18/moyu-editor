import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyError,
  logError,
  logRouteError,
  safeErrorDetail,
} from "@/lib/log";

/**
 * 错误日志。
 *
 * 这个模块唯一的价值是「让排查变容易，同时不把事故变大」。
 * 所以测试的重点不是格式好不好看，而是：
 *   - 不该进日志的字段（正文、密钥、Cookie）有没有真的被挡在外面；
 *   - 超长的东西（比如一不小心把整章正文塞进 detail）有没有被截断；
 *   - 异常分类分得对不对（数据库故障 vs 参数不合法）。
 */
describe("logError 的信息边界", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("只输出白名单字段，白名单之外的键直接丢掉", () => {
    logError("AI_PROVIDER_ERROR", {
      userId: "u1",
      chapterId: "c1",
      // 下面这些都不是 LogContext 的字段，运行时塞进来也必须被丢掉
      password: "123456",
      cookie: "next-auth.session-token=abc",
      apiKey: "sk-secret",
      content: "第一章的完整正文……",
    } as never);

    const output = errorSpy.mock.calls.flat().join(" ");

    expect(output).toContain("AI_PROVIDER_ERROR");
    expect(output).toContain("u1");
    expect(output).not.toContain("123456");
    expect(output).not.toContain("next-auth.session-token");
    expect(output).not.toContain("sk-secret");
    expect(output).not.toContain("完整正文");
  });

  it("detail 太长会被截断并压成一行（防止有人把正文塞进来）", () => {
    logError("UNKNOWN_ERROR", { detail: `第一行\n${"很长".repeat(500)}` });

    const output = errorSpy.mock.calls.flat().join(" ");

    expect(output).not.toContain("\n");
    expect(output.length).toBeLessThan(600);
  });

  it("没给 userId 时不会输出 userId:null 这种噪声", () => {
    logError("AUTH_FAILED", { status: 401 });

    const output = errorSpy.mock.calls.flat().join(" ");

    expect(output).not.toContain("userId");
    expect(output).toContain("401");
  });
});

describe("classifyError / safeErrorDetail", () => {
  it("Prisma 的连接类错误归为数据库错误", () => {
    const error = Object.assign(new Error("Can't reach database server"), {
      code: "P1001",
    });

    expect(classifyError(error)).toBe("DATABASE_ERROR");
  });

  it("P2025（记录不存在）归为「找不到」而不是数据库故障", () => {
    const error = Object.assign(new Error("Record not found"), { code: "P2025" });

    expect(classifyError(error)).toBe("CHAPTER_NOT_FOUND");
  });

  it("zod 校验错误归为参数不合法", () => {
    const error = new Error("invalid");
    error.name = "ZodError";

    expect(classifyError(error)).toBe("VALIDATION_FAILED");
  });

  it("其他异常兜底为 UNKNOWN_ERROR", () => {
    expect(classifyError(new Error("???"))).toBe("UNKNOWN_ERROR");
    expect(classifyError(undefined)).toBe("UNKNOWN_ERROR");
  });

  it("safeErrorDetail 只取类名和错误码，绝不带 message", () => {
    const error = Object.assign(
      new Error("postgresql://moyu:secret@db:5432/moyu 连接失败"),
      { code: "P1001" }
    );
    const detail = safeErrorDetail(error);

    expect(detail).toBe("Error:P1001");
    expect(detail).not.toContain("secret");
    expect(detail).not.toContain("postgresql://");
  });
});

describe("logRouteError", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("替掉 console.error(error)：不打印堆栈，只留编号和类名", () => {
    const error = Object.assign(new Error("连接串里带密码：postgres://a:b@c/d"), {
      code: "P1001",
    });

    const code = logRouteError(error, { userId: "u1", chapterId: "c1" });
    const output = errorSpy.mock.calls.flat().join(" ");

    expect(code).toBe("DATABASE_ERROR");
    expect(output).toContain("DATABASE_ERROR");
    expect(output).toContain("Error:P1001");
    expect(output).not.toContain("postgres://a:b@c/d");
    expect(output).not.toContain("at ");
  });
});
