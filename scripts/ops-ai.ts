/**
 * AI 使用情况报表：`npm run ops:ai`
 *
 * 看七件事（默认看最近 7 天，`--days 30` 可改）：
 *   1. 每日调用量（成功 / 失败分开设，上游挂没挂一眼能看出来）
 *   2. 失败明细（按错误编号分组 —— 429 限流和上游故障分开看）
 *   3. 响应耗时（按模式的平均 / 最慢）
 *   4. 字符量（进多少字、出多少字 —— 费用的真实驱动因素）
 *   5. 费用估算（单价可配，默认按 DeepSeek 官方价的粗折算，只是量级参考）
 *   6. 高频用户（谁用得最多 —— 找异常刷量的）
 *   7. 额度用满的用户（每天顶到 30 次上限的人有几个）
 *
 * 隐私口径：报告里**不出现正文**（台账本来也只存字符数），
 * 用户邮箱打码成 `ab***@domain` —— 报告经常被截图发群里。
 */

import { Report, formatDuration, openOpsPrisma } from "./ops-lib";

/** 邮箱打码：保留前两字符和域名 */
function maskEmail(email: string) {
  const at = email.indexOf("@");

  if (at <= 0) return "??***";

  return `${email.slice(0, 2)}***${email.slice(at)}`;
}

/**
 * 费用估算的单价（元 / 百万字符）。
 *
 * 只是个量级参考：真实计费按 token 不按字符，且输入输出单价不同。
 * 默认值按「1 汉字 ≈ 0.6 token、DeepSeek V3 输入 ¥2/百万 token、输出 ¥8/百万 token」
 * 粗折算成字符单价（输入 ¥1.2 / 输出 ¥4.8，再取整保守一点）。
 * 要更准就在 .env 里配 AI_COST_INPUT_PER_M（输入）和 AI_COST_OUTPUT_PER_M（输出）。
 */
const DEFAULT_INPUT_PRICE = 1.5;
const DEFAULT_OUTPUT_PRICE = 5;

async function main() {
  const argDays = Number(process.argv.find((arg) => arg.startsWith("--days="))?.slice(7));
  const days = Number.isFinite(argDays) && argDays > 0 && argDays <= 365 ? Math.floor(argDays) : 7;
  const since = new Date(Date.now() - days * 86_400_000);

  // ⚠️ Prisma 在 SQLite 里把 DateTime 存成「整数毫秒」（不是 ISO 字符串）。
  // raw SQL 里拿 createdAt 跟字符串比，SQLite 会按「数字 < 文本」永远判假。
  // 所有日期条件都必须换成毫秒数比。
  const sinceMs = since.getTime();

  const report = new Report(
    "墨语编辑器 · AI 使用报表",
    `范围：最近 ${days} 天（${since.toISOString().slice(0, 10)} 起）`
  );

  let handle: Awaited<ReturnType<typeof openOpsPrisma>> | null = null;

  try {
    handle = await openOpsPrisma();
  } catch (error) {
    report.fail(
      "数据库连不上",
      error instanceof Error ? error.message.split("\n")[0] : String(error)
    );
    report.print();

    process.exitCode = 1;

    return;
  }

  const { prisma, env } = handle;

  // ── 1. 每日调用量 ────────────────────────────────────────────
  report.head(`1. 每日调用量（最近 ${days} 天）`);

  type DayRow = { day: string; ok: number; fail: number };

  const perDay = (await prisma.$queryRawUnsafe(
    `SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
            SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS fail
       FROM AiUsage
      WHERE createdAt >= ${sinceMs}
      GROUP BY day
      ORDER BY day DESC`
  )) as unknown as DayRow[];

  if (perDay.length === 0) {
    report.info("这段时间没有任何调用", "无趋势可看");
  } else {
    const totalOk = perDay.reduce((sum, row) => sum + Number(row.ok), 0);
    const totalFail = perDay.reduce((sum, row) => sum + Number(row.fail), 0);

    report.raw("      日期          成功   失败");
    for (const row of perDay.slice(0, 14)) {
      report.raw(
        `      ${row.day}   ${String(row.ok).padStart(5)}  ${String(row.fail).padStart(5)}`
      );
    }
    if (perDay.length > 14) report.raw(`      ……（共 ${perDay.length} 天，只列最近 14 天）`);

    report.ok(
      "汇总",
      `成功 ${totalOk} 次 ｜ 失败 ${totalFail} 次 ｜ 失败率 ${
        totalOk + totalFail > 0 ? Math.round((totalFail / (totalOk + totalFail)) * 100) : 0
      }%`
    );
  }

  // ── 2. 失败明细 ──────────────────────────────────────────────
  report.head("2. 失败明细（按错误编号）");

  type CodeRow = { errorCode: string | null; n: number };

  const byCode = (await prisma.$queryRawUnsafe(
    `SELECT errorCode, COUNT(*) AS n
       FROM AiUsage
      WHERE ok = 0 AND createdAt >= ${sinceMs}
      GROUP BY errorCode
      ORDER BY n DESC`
  )) as unknown as CodeRow[];

  if (byCode.length === 0) {
    report.ok("没有失败记录");
  } else {
    const explain: Record<string, string> = {
      RATE_LIMITED: "手太快被限流（每分钟 10 次）",
      DAILY_QUOTA_EXCEEDED: "当天 30 次额度用完",
      AI_PROVIDER_ERROR: "上游模型服务报错",
      AI_TIMEOUT: "上游响应超时",
      AI_INVALID_FORMAT: "上游返回的内容不是约定格式",
      AI_EMPTY_RESPONSE: "上游返回了空内容",
      AI_NOT_CONFIGURED: "AI 没配置（Key 缺失或写错）",
      AI_UPSTREAM_REJECTED: "上游拒绝了请求（Key 无效 / 余额不足）",
    };

    for (const row of byCode) {
      const code = row.errorCode ?? "UNKNOWN";

      report.raw(
        `      ${code.padEnd(24)} ×${String(row.n).padStart(4)}   ${explain[code] ?? "（未编入说明，去 src/lib/log.ts 查这个编号）"}`
      );
    }

    const providerErrors = byCode
      .filter((row) => (row.errorCode ?? "").startsWith("AI_"))
      .reduce((sum, row) => sum + Number(row.n), 0);

    if (providerErrors >= 20) {
      report.warn(
        "上游故障偏多",
        `${providerErrors} 次 —— 若持续出现，先看 AI_BASE_URL / AI_MODEL 是否还有效，再查上游平台状态`
      );
    } else {
      report.info("明细见上", `其中上游故障 ${providerErrors} 次`);
    }
  }

  // ── 3. 响应耗时 ──────────────────────────────────────────────
  report.head("3. 响应耗时（成功调用）");

  type ModeRow = { mode: string; n: number; avgMs: number | null; maxMs: number | null };

  const byMode = (await prisma.$queryRawUnsafe(
    `SELECT mode, COUNT(*) AS n, AVG(durationMs) AS avgMs, MAX(durationMs) AS maxMs
       FROM AiUsage
      WHERE ok = 1 AND durationMs IS NOT NULL
        AND createdAt >= ${sinceMs}
      GROUP BY mode`
  )) as unknown as ModeRow[];

  if (byMode.length === 0) {
    report.info("没有带耗时的成功记录", "（第十一阶段之前的记录没有 durationMs 字段）");
  } else {
    for (const row of byMode) {
      const modeName = row.mode === "diagnose" ? "诊断" : row.mode === "polish" ? "润色" : row.mode;

      report.raw(
        `      ${modeName.padEnd(6)} ${String(row.n).padStart(4)} 次   平均 ${formatDuration(
          Number(row.avgMs)
        )}   最慢 ${formatDuration(Number(row.maxMs))}`
      );

      if (Number(row.avgMs) > 30_000) {
        report.warn(`${modeName}平均耗时超过 30 秒`, "用户会以为卡死了，考虑加超时或分段处理");
      }
    }
    report.ok("耗时统计完成", "");
  }

  // ── 4. 字符量 ────────────────────────────────────────────────
  report.head("4. 字符量");

  const chars = (await prisma.$queryRawUnsafe(
    `SELECT SUM(inputChars) AS inChars, SUM(outputChars) AS outChars
       FROM AiUsage
      WHERE createdAt >= ${sinceMs}`
  )) as unknown as { inChars: number | null; outChars: number | null }[];

  const inChars = Number(chars[0]?.inChars ?? 0);
  const outChars = Number(chars[0]?.outChars ?? 0);

  report.raw(`      送进模型 ${(inChars / 10_000).toFixed(1)} 万字 ｜ 模型产出 ${(outChars / 10_000).toFixed(1)} 万字`);

  // ── 5. 费用估算 ──────────────────────────────────────────────
  report.head("5. 费用估算（量级参考）");

  const inputPrice = Number(env.AI_COST_INPUT_PER_M) || DEFAULT_INPUT_PRICE;
  const outputPrice = Number(env.AI_COST_OUTPUT_PER_M) || DEFAULT_OUTPUT_PRICE;
  const cost = (inChars / 1_000_000) * inputPrice + (outChars / 1_000_000) * outputPrice;

  report.raw(
    `      按输入 ¥${inputPrice} / 输出 ¥${outputPrice} 每百万字符估算：约 ¥${cost.toFixed(2)}`
  );
  report.raw(
    "      （真实账单按 token 计、进出单价不同，这里只用来判断量级和突变，别拿去对账）"
  );

  if (perDay.length >= 3 && inChars > 0) {
    report.ok("估算完成", `折算每天约 ¥${(cost / days).toFixed(2)}`);
  } else {
    report.info("样本还太少", "估算仅供参考");
  }

  // ── 6. 高频用户 ──────────────────────────────────────────────
  report.head("6. 高频用户（最近 30 天，前 5 名）");

  type UserRow = { email: string | null; name: string | null; n: number; failN: number };

  const topUsers = (await prisma.$queryRawUnsafe(
    `SELECT u.email, u.name, COUNT(*) AS n,
            SUM(CASE WHEN a.ok = 0 THEN 1 ELSE 0 END) AS failN
       FROM AiUsage a JOIN User u ON u.id = a.userId
      WHERE a.createdAt >= ${Date.now() - 30 * 86_400_000}
      GROUP BY a.userId
      ORDER BY n DESC
      LIMIT 5`
  )) as unknown as UserRow[];

  if (topUsers.length === 0) {
    report.info("最近 30 天没有用户调用过 AI");
  } else {
    report.raw("      用户                      次数   其中失败");
    for (const row of topUsers) {
      report.raw(
        `      ${maskEmail(row.email ?? "?").padEnd(24)} ${String(row.n).padStart(4)}   ${String(
          row.failN
        ).padStart(4)}`
      );
    }

    const top = Number(topUsers[0].n);

    if (top >= 200) {
      report.warn(
        "有用户 30 天调了 200 次以上",
        "正常写作用不满这个量，确认没有人在脚本刷接口（看第 2 节里他的失败构成）"
      );
    } else {
      report.ok("没有异常刷量迹象", `最高 ${top} 次`);
    }
  }

  // ── 7. 额度用满的用户 ────────────────────────────────────────
  report.head("7. 今天额度用满的用户");

  type QuotaRow = { email: string | null; n: number };

  // 「今天」按本地自然日算（和 src/lib/ai-usage.ts 的额度口径一致）
  const todayStart = new Date();

  todayStart.setHours(0, 0, 0, 0);

  const maxedOut = (await prisma.$queryRawUnsafe(
    `SELECT u.email, COUNT(*) AS n
       FROM AiUsage a JOIN User u ON u.id = a.userId
      WHERE a.ok = 1 AND a.createdAt >= ${todayStart.getTime()}
      GROUP BY a.userId
     HAVING n >= 30
      ORDER BY n DESC`
  )) as unknown as QuotaRow[];

  if (maxedOut.length === 0) {
    report.ok("今天没有用户顶到 30 次上限");
  } else {
    report.raw("      用户                      成功次数");
    for (const row of maxedOut) {
      report.raw(`      ${maskEmail(row.email ?? "?").padEnd(24)} ${String(row.n).padStart(4)}`);
    }

    report.info(
      `${maxedOut.length} 人用满`,
      "偶尔用满是正常重度用户；每天都满才需要考虑分级额度"
    );
  }

  await prisma.$disconnect();

  const file = report.write("ops-reports", "ai");

  report.print();

  if (file) console.log(`报告已写入：${file}`);

  process.exitCode = report.hasFailure ? 1 : 0;
}

main().catch((error) => {
  console.error("ops-ai 自己崩了：", error);
  process.exitCode = 1;
});
