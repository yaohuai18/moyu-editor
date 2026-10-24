import { describe, expect, it } from "vitest";
import { AiError, describeAiError } from "@/lib/ai";

/**
 * AI 错误翻译。
 *
 * 用户看到的每一句 AI 报错都从这里出。要求：
 *   1. 状态码分得清「是我们没配好（503）」和「上游抽风（502）」；
 *   2. 提示语必须是中文、能看懂、**不含 API Key 或上游原始报文**；
 *   3. 不是 AI 的错误就返回 null，交给别的分支处理（别抢别人的活）。
 */
describe("describeAiError", () => {
  it("没配密钥 → 503，并且提示找管理员而不是让用户重试", () => {
    const result = describeAiError(new AiError("AI_NOT_CONFIGURED"));

    expect(result?.status).toBe(503);
    expect(result?.message).toContain("尚未配置");
  });

  it("上游返回错误 → 502，带上游状态码方便排查", () => {
    const result = describeAiError(
      new AiError("AI_PROVIDER_ERROR", { upstreamStatus: 401 })
    );

    expect(result?.status).toBe(502);
    expect(result?.message).toContain("401");
  });

  it("上游没给状态码时也要有一句能看懂的话", () => {
    const result = describeAiError(new AiError("AI_PROVIDER_ERROR"));

    expect(result?.status).toBe(502);
    expect(result?.message).toContain("稍后重试");
  });

  it("上游返回空内容 / 格式不对 → 502，提示重试", () => {
    expect(describeAiError(new AiError("AI_EMPTY_RESPONSE"))?.status).toBe(502);
    expect(describeAiError(new AiError("AI_INVALID_FORMAT"))?.status).toBe(502);
  });

  it("不是 AI 错误就返回 null（不越界接管别的异常）", () => {
    expect(describeAiError(new Error("随便一个错"))).toBeNull();
    expect(describeAiError("字符串")).toBeNull();
    expect(describeAiError(null)).toBeNull();
  });

  it("任何情况下都不把密钥带进提示语", () => {
    process.env.AI_API_KEY = "sk-must-never-appear";

    const messages = [
      describeAiError(new AiError("AI_NOT_CONFIGURED"))?.message,
      describeAiError(new AiError("AI_PROVIDER_ERROR", { upstreamStatus: 500 }))?.message,
      describeAiError(new AiError("AI_INVALID_FORMAT"))?.message,
    ].join(" ");

    expect(messages).not.toContain("sk-must-never-appear");

    delete process.env.AI_API_KEY;
  });
});
