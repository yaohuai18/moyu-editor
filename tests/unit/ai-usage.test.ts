import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AI 用量与每日额度。
 *
 * 这里把数据库整个换掉（vi.mock），只验证「算得对不对」和
 * 「记账失败时会不会把 AI 结果连坐」——前者关系到用户能不能用，
 * 后者关系到「AI 用一次坏一次」的错觉。
 */

const aiUsageMock = {
  count: vi.fn(),
  create: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: { aiUsage: aiUsageMock },
}));

const {
  DAILY_AI_LIMIT,
  countTodayUsage,
  getDailyQuota,
  recordAiFailure,
  recordAiUsage,
  startOfToday,
} = await import("@/lib/ai-usage");

describe("startOfToday", () => {
  it("取的是本地时间的当天零点", () => {
    const start = startOfToday(new Date("2026-09-25T22:16:51"));

    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(8); // 0 起算，8 = 九月
    expect(start.getDate()).toBe(25);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
  });

  it("凌晨也算「当天」的零点，不会退到前一天", () => {
    const start = startOfToday(new Date("2026-09-25T00:00:01"));

    expect(start.getDate()).toBe(25);
    expect(start.getHours()).toBe(0);
  });
});

describe("countTodayUsage / getDailyQuota", () => {
  beforeEach(() => {
    aiUsageMock.count.mockReset();
    aiUsageMock.create.mockReset();
  });

  it("只数「这个用户 + 今天」的记录", async () => {
    aiUsageMock.count.mockResolvedValue(7);

    const used = await countTodayUsage("u1");

    expect(used).toBe(7);

    const where = aiUsageMock.count.mock.calls[0][0].where;

    expect(where.userId).toBe("u1");
    expect(where.createdAt.gte.getHours()).toBe(0);
  });

  /**
   * 第十一阶段加的这张表里还躺着「失败」和「被限流」的记录。
   * 它们没有真的调用上游模型，**不该算进用户的次数里** ——
   * 漏掉这个过滤，上游抖一次用户就白扣一次，而且没人会马上发现。
   */
  it("台账里的失败记录不算已用额度", async () => {
    aiUsageMock.count.mockResolvedValue(0);

    await countTodayUsage("u1");

    expect(aiUsageMock.count.mock.calls[0][0].where.ok).toBe(true);
  });

  it("额度用满时剩余为 0，不会出现负数", async () => {
    aiUsageMock.count.mockResolvedValue(DAILY_AI_LIMIT + 5);

    const quota = await getDailyQuota("u1");

    expect(quota.used).toBe(DAILY_AI_LIMIT + 5);
    expect(quota.limit).toBe(DAILY_AI_LIMIT);
    expect(quota.remaining).toBe(0);
  });

  it("没用过时剩余就是整额", async () => {
    aiUsageMock.count.mockResolvedValue(0);

    const quota = await getDailyQuota("u1");

    expect(quota.remaining).toBe(DAILY_AI_LIMIT);
  });
});

describe("recordAiUsage", () => {
  beforeEach(() => {
    aiUsageMock.create.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("把用量按字段写进库（存长度，不存正文）", async () => {
    aiUsageMock.create.mockResolvedValue({ id: "a1" });

    const ok = await recordAiUsage({
      userId: "u1",
      projectId: "p1",
      chapterId: "c1",
      mode: "polish",
      model: "deepseek-chat",
      inputChars: 1200,
      outputChars: 1300,
    });

    expect(ok).toBe(true);

    const data = aiUsageMock.create.mock.calls[0][0].data;

    expect(data).toMatchObject({
      userId: "u1",
      projectId: "p1",
      chapterId: "c1",
      mode: "polish",
      model: "deepseek-chat",
      inputChars: 1200,
      outputChars: 1300,
    });
    // 表里根本没有「正文」这个字段，这是设计上的取舍
    expect(Object.keys(data)).not.toContain("content");
  });

  it("记账失败只写一条 warn 日志，**绝不往外抛**", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    aiUsageMock.create.mockRejectedValue(new Error("database is locked"));

    await expect(
      recordAiUsage({
        userId: "u1",
        mode: "diagnose",
        model: "m",
        inputChars: 1,
        outputChars: 1,
      })
    ).resolves.toBe(false);

    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("没传 projectId / chapterId 时写 null，不会因为缺字段而失败", async () => {
    aiUsageMock.create.mockResolvedValue({ id: "a2" });

    await recordAiUsage({
      userId: "u1",
      mode: "diagnose",
      model: "m",
      inputChars: 10,
      outputChars: 20,
    });

    const data = aiUsageMock.create.mock.calls[0][0].data;

    expect(data.projectId).toBeNull();
    expect(data.chapterId).toBeNull();
  });

  it("成功调用默认按 ok=true 记账，并带上耗时", async () => {
    aiUsageMock.create.mockResolvedValue({ id: "a3" });

    await recordAiUsage({
      userId: "u1",
      mode: "polish",
      model: "m",
      inputChars: 10,
      outputChars: 20,
      durationMs: 1234,
    });

    const data = aiUsageMock.create.mock.calls[0][0].data;

    expect(data.ok).toBe(true);
    expect(data.durationMs).toBe(1234);
    expect(data.errorCode).toBeNull();
  });
});

/**
 * 记失败。这是「失败率」和「谁被限流了」这两个运营指标的唯一数据来源 ——
 * 只记成功的话，上游挂掉反而在报表上看不出来。
 */
describe("recordAiFailure", () => {
  beforeEach(() => {
    aiUsageMock.create.mockReset();
    aiUsageMock.create.mockResolvedValue({ id: "f1" });
  });

  it("落库时 ok=false，并记下错误编号与耗时", async () => {
    await recordAiFailure({
      userId: "u1",
      projectId: "p1",
      chapterId: "c1",
      mode: "polish",
      model: "m",
      inputChars: 1200,
      durationMs: 8900,
      errorCode: "AI_PROVIDER_ERROR",
    });

    const data = aiUsageMock.create.mock.calls[0][0].data;

    expect(data.ok).toBe(false);
    expect(data.errorCode).toBe("AI_PROVIDER_ERROR");
    expect(data.durationMs).toBe(8900);
    // 失败时没有输出，outputChars 兜底成 0 而不是 undefined
    expect(data.outputChars).toBe(0);
  });

  it("被限流这类「还没开始调」的记录，字符数可以是 0", async () => {
    await recordAiFailure({
      userId: "u1",
      mode: "unknown",
      model: "m",
      inputChars: 0,
      errorCode: "RATE_LIMITED",
    });

    const data = aiUsageMock.create.mock.calls[0][0].data;

    expect(data.ok).toBe(false);
    expect(data.inputChars).toBe(0);
    expect(data.projectId).toBeNull();
  });

  it("写失败也**绝不往外抛**（记账不能把请求本身搞崩）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    aiUsageMock.create.mockRejectedValue(new Error("database is locked"));

    await expect(
      recordAiFailure({
        userId: "u1",
        mode: "diagnose",
        model: "m",
        inputChars: 1,
        errorCode: "AI_EMPTY_RESPONSE",
      })
    ).resolves.toBe(false);

    warnSpy.mockRestore();
  });
});
