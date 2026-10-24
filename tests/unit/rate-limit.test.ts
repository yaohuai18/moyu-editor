import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, resetRateLimit } from "@/lib/rate-limit";

/**
 * 内存限流。
 *
 * 这是防「点快了」和「脚本刷」的那道闸，逻辑本身很短，
 * 但窗口边界算错就会变成「明明该放行却拒了」——
 * 用户看到的是「AI 用不了」，我们看到的是「莫名其妙的 429」。
 */
describe("checkRateLimit", () => {
  beforeEach(() => {
    resetRateLimit();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T10:00:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("额度内的请求全部放行，并报出剩余次数", () => {
    for (let i = 0; i < 3; i++) {
      const result = checkRateLimit("ai:u1", 3, 60_000);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2 - i);
    }
  });

  it("超出额度后拒绝，并给出还要等几秒", () => {
    for (let i = 0; i < 3; i++) {
      checkRateLimit("ai:u1", 3, 60_000);
    }

    const blocked = checkRateLimit("ai:u1", 3, 60_000);

    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);

    if (!blocked.allowed) {
      expect(blocked.retryAfter).toBeGreaterThan(0);
      expect(blocked.retryAfter).toBeLessThanOrEqual(60);
    }
  });

  it("不同 key 互不影响（限的是「每个人」不是「全站」）", () => {
    for (let i = 0; i < 3; i++) {
      checkRateLimit("ai:u1", 3, 60_000);
    }

    expect(checkRateLimit("ai:u1", 3, 60_000).allowed).toBe(false);
    expect(checkRateLimit("ai:u2", 3, 60_000).allowed).toBe(true);
  });

  it("窗口过期后重新放行", () => {
    for (let i = 0; i < 3; i++) {
      checkRateLimit("ai:u1", 3, 60_000);
    }

    expect(checkRateLimit("ai:u1", 3, 60_000).allowed).toBe(false);

    // 刚好 60 秒后：窗口重置
    vi.setSystemTime(new Date("2026-09-25T10:01:00"));

    const after = checkRateLimit("ai:u1", 3, 60_000);

    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(2);
  });

  it("窗口还剩一点时不会提前重置", () => {
    for (let i = 0; i < 3; i++) {
      checkRateLimit("ai:u1", 3, 60_000);
    }

    vi.setSystemTime(new Date("2026-09-25T10:00:59"));

    expect(checkRateLimit("ai:u1", 3, 60_000).allowed).toBe(false);
  });
});
