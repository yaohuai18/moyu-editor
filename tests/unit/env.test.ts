import { describe, expect, it } from "vitest";
import { getEnvSummary, inspectEnv, reportEnvOnBoot } from "@/lib/env";

/**
 * 环境变量体检。
 *
 * 这个模块的输出会进启动日志、也会进 /api/health 的响应体（谁都能打开），
 * 所以测试要盯两件事：**该报的有没有报出来**、**不该报的有没有漏出去**。
 */

/** 一份「配置齐全」的环境，各用例在它基础上改坏某一项 */
function healthyEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://user:pass@db:5432/moyu",
    AUTH_SECRET: "x".repeat(44),
    AUTH_URL: "https://moyu.example.com",
    AI_API_KEY: "sk-test",
    AI_MODEL: "deepseek-chat",
    AI_BASE_URL: "https://api.deepseek.com",
    ...overrides,
  };
}

const keys = (issues: { key: string }[]) => issues.map((i) => i.key);

describe("inspectEnv", () => {
  it("配置齐全时一个问题都不报", () => {
    expect(inspectEnv(healthyEnv())).toEqual([]);
  });

  it("缺数据库地址是致命问题（应用根本起不来）", () => {
    const issues = inspectEnv(healthyEnv({ DATABASE_URL: undefined }));

    expect(keys(issues)).toContain("DATABASE_URL");
    expect(issues.find((i) => i.key === "DATABASE_URL")?.level).toBe("fatal");
  });

  it("缺会话密钥是致命问题（登录会直接报错）", () => {
    const issues = inspectEnv(healthyEnv({ AUTH_SECRET: "" }));

    expect(issues.find((i) => i.key === "AUTH_SECRET")?.level).toBe("fatal");
  });

  it("会话密钥太短也算致命（短密钥可被暴力猜出，等于没有）", () => {
    const issues = inspectEnv(healthyEnv({ AUTH_SECRET: "abc" }));
    const issue = issues.find((i) => i.key === "AUTH_SECRET");

    expect(issue?.level).toBe("fatal");
    expect(issue?.message).toContain("太短");
  });

  it("缺 AI Key 只是提醒，不是致命问题（其余功能照常用）", () => {
    const issues = inspectEnv(healthyEnv({ AI_API_KEY: undefined }));

    expect(issues.find((i) => i.key === "AI_API_KEY")?.level).toBe("warn");
  });

  it("AI 地址用明文 http 会给提醒（正文会明文上网）", () => {
    const issues = inspectEnv(healthyEnv({ AI_BASE_URL: "http://api.example.com" }));

    expect(keys(issues)).toContain("AI_BASE_URL");
  });

  it("生产环境用本地 SQLite 会给提醒（只适合单机）", () => {
    const issues = inspectEnv(healthyEnv({ DATABASE_URL: "file:./dev.db" }));

    expect(keys(issues)).toContain("DATABASE_URL");
    expect(issues.find((i) => i.key === "DATABASE_URL")?.level).toBe("warn");
  });

  it("NEXT_PUBLIC_ 前缀 + 敏感字样的变量是致命错误（密钥会被打进浏览器）", () => {
    const issues = inspectEnv(
      healthyEnv({ NEXT_PUBLIC_AI_API_KEY: "sk-leaked" })
    );

    const issue = issues.find((i) => i.key === "NEXT_PUBLIC_AI_API_KEY");

    expect(issue?.level).toBe("fatal");
    expect(issue?.message).toContain("NEXT_PUBLIC_");
  });

  it("生产环境既没 AUTH_URL 也没 TRUST_HOST 会提醒（登录会报 UntrustedHost）", () => {
    const issues = inspectEnv(
      healthyEnv({ AUTH_URL: undefined, AUTH_TRUST_HOST: undefined })
    );

    expect(keys(issues)).toContain("AUTH_URL");
  });

  it("本地开发环境不套生产规则", () => {
    const issues = inspectEnv(
      healthyEnv({
        NODE_ENV: "development",
        AUTH_URL: undefined,
        DATABASE_URL: "file:./dev.db",
      })
    );

    // 开发环境用 sqlite、不配 AUTH_URL 都是正常的，不该报
    expect(issues).toEqual([]);
  });

  it("体检结论里绝不出现任何密钥的值", () => {
    const env = healthyEnv({ AI_API_KEY: "sk-super-secret-value" });
    const dumped = JSON.stringify(inspectEnv(env)) + JSON.stringify(getEnvSummary(env));

    expect(dumped).not.toContain("sk-super-secret-value");
    expect(dumped).not.toContain("pass@db");
    expect(dumped).not.toContain("x".repeat(44));
  });
});

describe("getEnvSummary", () => {
  it("只报「配了没」和长度，不返回值", () => {
    const summary = getEnvSummary(healthyEnv({ AUTH_SECRET: "y".repeat(40) }));

    expect(summary.auth.configured).toBe(true);
    expect(summary.auth.secretLength).toBe(40);
    expect(summary.database.kind).toBe("server");
    expect(summary.ai.model).toBe("deepseek-chat");
    // 摘要里根本没有装值的字段
    expect(Object.keys(summary.auth)).toEqual(["configured", "secretLength"]);
  });

  it("能区分本地文件库和网络数据库", () => {
    expect(getEnvSummary(healthyEnv({ DATABASE_URL: "file:./dev.db" })).database.kind).toBe(
      "sqlite"
    );
    expect(getEnvSummary(healthyEnv()).database.kind).toBe("server");
  });
});

describe("reportEnvOnBoot", () => {
  it("有致命问题时走 error 级别（部署平台好按级别告警）", () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg?: unknown) => logs.push(String(msg));
    console.error = (msg?: unknown) => errors.push(String(msg));

    try {
      reportEnvOnBoot(healthyEnv({ AUTH_SECRET: undefined }));
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    expect(errors.join("\n")).toContain("AUTH_SECRET");
    expect(logs).toEqual([]);
  });

  it("没问题时走 log 级别并说通过", () => {
    const logs: string[] = [];

    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg?: unknown) => logs.push(String(msg));
    console.error = (msg?: unknown) => logs.push(`ERR:${msg}`);

    try {
      reportEnvOnBoot(healthyEnv());
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    expect(logs.join("\n")).toContain("[ok]");
    expect(logs.join("\n")).not.toContain("ERR:");
  });
});
