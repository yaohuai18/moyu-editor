/**
 * 进程内的简易请求频率限制（固定窗口计数）。
 *
 * ⚠️ 只适合单实例部署（本地开发 / 单台服务器）。
 * 多实例（负载均衡、Serverless）下每个实例各有各的 Map，限流会失效，
 * 那时必须换成 Redis / Upstash 之类的共享存储。
 *
 * 用法：
 *   const limit = checkRateLimit(`ai:${user.id}`, 10, 60_000);
 *   if (!limit.allowed) return 429;
 */

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const requests = new Map<string, RateLimitEntry>();

/**
 * Map 只增不减会一直吃内存，所以要清理过期条目。
 * 但每个请求都全表扫一遍也浪费，所以攒到一定规模才扫。
 */
const SWEEP_THRESHOLD = 500;

function sweep(now: number) {
  if (requests.size < SWEEP_THRESHOLD) {
    return;
  }

  for (const [key, entry] of requests) {
    if (entry.resetAt <= now) {
      requests.delete(key);
    }
  }
}

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; remaining: 0; retryAfter: number };

/**
 * 记一次请求并判断是否超限。
 *
 * @param key      限流维度，例如 `ai:用户id`、`login:IP`
 * @param limit    窗口内允许的请求数
 * @param windowMs 窗口长度（毫秒）
 */
export function checkRateLimit(
  key: string,
  limit = 10,
  windowMs = 60_000
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const current = requests.get(key);

  if (!current || current.resetAt <= now) {
    requests.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });

    return {
      allowed: true,
      remaining: limit - 1,
    };
  }

  if (current.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;

  return {
    allowed: true,
    remaining: limit - current.count,
  };
}

/** 只给测试用：清空所有计数 */
export function resetRateLimit() {
  requests.clear();
}
