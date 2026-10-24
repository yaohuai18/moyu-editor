import { describe, expect, it } from "vitest";
import { AiError } from "@/lib/ai";
import { classifyError, safeErrorDetail } from "@/lib/log";

/**
 * AI 侧的错误必须能被日志编号认出来。
 *
 * 为什么单独写一个文件：第十一阶段做运维时发现，AI 上游挂掉时日志里打的是
 * `[UNKNOWN_ERROR]`，而运维手册让人去搜 `AI_PROVIDER_ERROR` —— 搜不到。
 * 错误编号的全部价值就在「能搜到」，认错了等于白记一遍。
 *
 * 这四个编号（AI_NOT_CONFIGURED / AI_PROVIDER_ERROR / AI_EMPTY_RESPONSE /
 * AI_INVALID_FORMAT）是**对外承诺过的编号**，改了会让人按手册排查时扑空，
 * 所以用测试钉住。
 */
describe("classifyError 认得 AI 错误", () => {
  const codes = [
    "AI_NOT_CONFIGURED",
    "AI_PROVIDER_ERROR",
    "AI_EMPTY_RESPONSE",
    "AI_INVALID_FORMAT",
  ] as const;

  for (const code of codes) {
    it(`${code} 归类到同名编号（而不是 UNKNOWN_ERROR）`, () => {
      expect(classifyError(new AiError(code))).toBe(code);
    });
  }

  it("带上游状态码时也不影响归类", () => {
    expect(classifyError(new AiError("AI_PROVIDER_ERROR", { upstreamStatus: 500 }))).toBe(
      "AI_PROVIDER_ERROR"
    );
  });
});

describe("classifyError 不误伤其它错误", () => {
  it("Prisma 的 P 开头错误码仍然归到数据库", () => {
    const error = Object.assign(new Error("connect failed"), { code: "P1001" });

    expect(classifyError(error)).toBe("DATABASE_ERROR");
  });

  it("P2025（记录不存在）仍然归到「章节不存在」，不是数据库故障", () => {
    const error = Object.assign(new Error("record not found"), { code: "P2025" });

    expect(classifyError(error)).toBe("CHAPTER_NOT_FOUND");
  });

  it("普通 Error 仍然归到 UNKNOWN_ERROR", () => {
    expect(classifyError(new Error("随便什么错"))).toBe("UNKNOWN_ERROR");
  });

  it("code 是未知字符串时不乱认", () => {
    const error = Object.assign(new Error("x"), { code: "SOMETHING_ELSE" });

    expect(classifyError(error)).toBe("DATABASE_ERROR");
  });

  it("非 Error 的输入不会崩", () => {
    expect(classifyError("字符串")).toBe("UNKNOWN_ERROR");
    expect(classifyError(null)).toBe("UNKNOWN_ERROR");
    expect(classifyError(undefined)).toBe("UNKNOWN_ERROR");
  });
});

describe("safeErrorDetail 不会把敏感内容带进日志", () => {
  it("只留类名和错误码，不带 message", () => {
    const error = Object.assign(new Error("file:./dev.db?password=hunter2"), {
      code: "P1001",
    });

    const detail = safeErrorDetail(error);

    expect(detail).toBe("Error:P1001");
    expect(detail).not.toContain("hunter2");
    expect(detail).not.toContain("dev.db");
  });

  it("AiError 只留类名和编号，不带上游原始报文", () => {
    // AiError 自己把 name 设成了 "AiError"，而它的 code 就是四个 AI 编号之一。
    // 两条拼起来正好是「能搜、又不会把上游报文带出去」的形态。
    const detail = safeErrorDetail(
      new AiError("AI_PROVIDER_ERROR", { upstreamStatus: 500 })
    );

    expect(detail).toBe("AiError:AI_PROVIDER_ERROR");
    expect(detail).not.toContain("500");
  });
});
