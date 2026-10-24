/**
 * 日常巡检：`npm run ops:daily`
 *
 * 每天该看的七件事（顺序就是报告里的顺序）：
 *   1. 应用在不在
 *   2. 健康检查（数据库 + 必要环境变量）
 *   3. 未登录访问受保护接口应被拒（401）—— 登录墙还立着
 *   4. 登录 / 退出（用一个专用探测账号，不碰真实用户）
 *   5. 保存链路只读探针（列表 → 章节 GET，一个写操作都不做）
 *   6. 数据库（连得上 + 各表行数 + 库文件大小）
 *   7. AI 故障趋势（最近 24 小时台账里的失败 / 限流记录）
 *
 * 两条设计决定：
 *
 * - **应用没启动不判失败。** 日常巡检经常跑在「服务没开的机器」上
 *   （比如晚上在开发机上看一眼数据）。没启动就明确标出来，跳过应用侧检查，
 *   数据库和台账照查，退出码保持 0。「服务该开而没开」由部署平台报警，不归这里管。
 *
 * - **探测账号从 .env 读**（`OPS_EMAIL` / `OPS_PASSWORD`），没配时用演示账号。
 *   上线删演示账号前记得配一个专用账号，否则第 4、5 项会变成「提醒」。
 */

import { loadEffectiveEnv } from "./env-file";
import {
  OpsClient,
  Report,
  formatBytes,
  formatDuration,
  openOpsPrisma,
  probeAlive,
  sqliteFilePath,
} from "./ops-lib";

function resolveBaseUrl(env: Record<string, string>) {
  const fromEnv = env.OPS_BASE_URL?.trim();

  if (fromEnv) return fromEnv.replace(/\/+$/, "");

  const port = env.OPS_PORT?.trim() || "3001";

  return `http://127.0.0.1:${port}`;
}

async function main() {
  const { env } = loadEffectiveEnv(process.cwd());
  const baseUrl = resolveBaseUrl(env);
  const probeEmail = env.OPS_EMAIL?.trim() || "demo@moyu.local";
  const probePassword = env.OPS_PASSWORD?.trim() || "moyu-demo-2026";
  const usingDefaultProbe = !env.OPS_EMAIL?.trim();

  const report = new Report(
    "墨语编辑器 · 日常巡检",
    `目标：${baseUrl}（探测账号：${probeEmail}${usingDefaultProbe ? "，默认演示账号" : ""}）`
  );

  // ── 1. 应用在不在 ─────────────────────────────────────────────
  report.head("1. 应用");

  const alive = await probeAlive(baseUrl);

  let client: OpsClient | null = null;
  let loggedIn = false;

  if (!alive) {
    report.info(
      "应用未启动",
      `${baseUrl} 没有服务应答 —— 本条不是故障，应用侧检查全部跳过`
    );
    report.raw("      想查应用侧请先 `npm run serve`（或 `npm run app`）再跑一次。");
  } else {
    report.ok("应用在运行", baseUrl);

    client = new OpsClient(baseUrl);

    // ── 2. 健康检查 ────────────────────────────────────────────
    report.head("2. 健康检查（/api/health）");

    const health = await client.json<{
      status?: string;
      database?: string;
      aiConfigured?: boolean;
      issues?: { key: string; level: string; message: string }[];
    }>("/api/health");

    if (health.status === 200 && health.body.status === "ok") {
      report.ok("健康检查通过", `数据库 ${health.body.database}，AI 已配置：${health.body.aiConfigured ? "是" : "否（只能用诊断之外的都会报错）"}`);
    } else if (health.status === 503) {
      const issues = (health.body.issues ?? [])
        .map((issue) => `${issue.key}(${issue.level})`)
        .join("、");

      report.fail(
        "健康检查报 503",
        `数据库=${health.body.database ?? "未知"}${issues ? `，环境变量问题：${issues}` : ""}`
      );
    } else {
      report.fail("健康检查异常", `HTTP ${health.status}，不是 200 也不是 503`);
    }

    // ── 3. 登录墙 ──────────────────────────────────────────────
    report.head("3. 登录墙（不带 Cookie 访问受保护接口）");

    const anonymous = new OpsClient(baseUrl);
    const blocked = await anonymous.json("/api/projects");

    if (blocked.status === 401) {
      report.ok("未登录被正确拒绝", "GET /api/projects → 401");
    } else {
      report.fail(
        "登录墙可能失效",
        `未登录 GET /api/projects 返回 HTTP ${blocked.status}（应该是 401）`
      );
    }

    // ── 4. 登录 / 退出 ─────────────────────────────────────────
    report.head("4. 登录 / 退出");

    try {
      loggedIn = await client.login(probeEmail, probePassword);
    } catch {
      loggedIn = false;
    }

    if (loggedIn) {
      report.ok("探测账号登录成功", probeEmail);

      await client.logout();

      const after = await client.json<{ user?: unknown }>("/api/auth/session");

      if (after.body?.user) {
        report.fail("退出登录后仍有会话", "logout 之后 /api/auth/session 还报用户");
      } else {
        report.ok("退出登录生效");
      }

      // 登出后再登录回来，供后面两节用（免得每节都重登一遍）
      loggedIn = await client.login(probeEmail, probePassword);
    } else {
      report.warn(
        "探测账号登录失败",
        usingDefaultProbe
          ? "默认用演示账号，可能已被删除或改密。上线前请在 .env 配 OPS_EMAIL / OPS_PASSWORD 为专用探测账号"
          : "请检查 .env 里 OPS_EMAIL / OPS_PASSWORD 是否正确"
      );
    }

    // ── 5. 保存链路只读探针 ────────────────────────────────────
    report.head("5. 保存链路（只读）");

    if (!loggedIn) {
      report.skip("跳过", "上一节探测账号没登上");
    } else {
      const projects = await client.json<{
        items?: { id: string; title: string; chapterCount?: number }[];
        total?: number;
      }>("/api/projects?limit=5");

      if (projects.status !== 200 || !Array.isArray(projects.body.items)) {
        report.fail("作品列表读不出来", `GET /api/projects → HTTP ${projects.status}`);
      } else {
        report.ok(
          "作品列表可读",
          `共 ${projects.body.total ?? projects.body.items.length} 部，取到 ${projects.body.items.length} 部`
        );

        const first = projects.body.items[0];

        if (!first) {
          report.info("探测账号名下没有作品", "章节读取探针没有对象可测，不算故障");
        } else {
          // 章节列表在「项目详情」里返回（和编辑页首屏同一条链路）。
          // 注意 /api/projects/[id]/chapters 只有 POST（建章/调序），没有 GET。
          const detail = await client.json<{
            chapters?: { id: string; title: string; wordCount?: number }[];
          }>(`/api/projects/${first.id}`);

          const firstChapter = detail.body.chapters?.[0];

          if (detail.status !== 200 || !firstChapter) {
            report.warn(
              "项目详情读不出来或没有章节",
              `HTTP ${detail.status}，作品「${first.title}」`
            );
          } else {
            const chapter = await client.json<{
              id?: string;
              title?: string;
              version?: number;
              chars?: number;
            }>(`/api/chapters/${firstChapter.id}`);

            if (chapter.status === 200 && chapter.body.id) {
              report.ok(
                "章节可读（保存链路的读半边）",
                `「${chapter.body.title ?? "?"}」版本 ${chapter.body.version ?? "?"}`
              );
            } else {
              report.fail(
                "章节读不出来",
                `GET /api/chapters/${firstChapter.id} → HTTP ${chapter.status}`
              );
            }
          }
        }
      }

      // ── AI 额度接口（不真调模型，只看额度接口活着） ──────────
      const usage = await client.json<{
        used?: number;
        limit?: number;
        remaining?: number;
      }>("/api/ai/usage");

      if (
        usage.status === 200 &&
        typeof usage.body.used === "number" &&
        typeof usage.body.limit === "number"
      ) {
        report.ok(
          "AI 额度接口正常",
          `探测账号今天已用 ${usage.body.used}/${usage.body.limit}（这里不真调模型，不花钱）`
        );
      } else {
        report.fail("AI 额度接口异常", `GET /api/ai/usage → HTTP ${usage.status}`);
      }
    }
  }

  // ── 6. 数据库 ────────────────────────────────────────────────
  report.head("6. 数据库");

  let prismaHandle: Awaited<ReturnType<typeof openOpsPrisma>> | null = null;

  try {
    prismaHandle = await openOpsPrisma();
    const { prisma } = prismaHandle;

    const [users, projects, chapters, revisions, aiUsages] = await Promise.all([
      prisma.user.count(),
      prisma.project.count(),
      prisma.chapter.count(),
      prisma.revision.count(),
      prisma.aiUsage.count(),
    ]);

    report.ok("数据库连接正常", "SELECT 1 通过");
    report.raw(`      用户 ${users} ｜ 作品 ${projects} ｜ 章节 ${chapters} ｜ 版本 ${revisions} ｜ AI 台账 ${aiUsages}`);

    const dbFile = sqliteFilePath(process.env.DATABASE_URL ?? "");

    if (dbFile) {
      const { statSync } = await import("node:fs");

      report.raw(`      库文件：${dbFile}（${formatBytes(statSync(dbFile).size)}）`);
    }
  } catch (error) {
    report.fail(
      "数据库连不上",
      error instanceof Error ? error.message.split("\n")[0] : String(error)
    );
  }

  // ── 7. AI 故障趋势 ───────────────────────────────────────────
  report.head("7. AI 故障趋势（最近 24 小时）");

  report.raw("      说明：服务端错误日志打在进程 stdout 里，巡检脚本拿不到运行中的日志；");
  report.raw("      这里用 AI 台账的失败记录做等价指标（第十一阶段起失败/限流也记台账）。");

  if (prismaHandle) {
    const { prisma } = prismaHandle;
    const since = new Date(Date.now() - 86_400_000);

    const [okCount, failRows] = await Promise.all([
      prisma.aiUsage.count({ where: { ok: true, createdAt: { gte: since } } }),
      prisma.aiUsage.findMany({
        where: { ok: false, createdAt: { gte: since } },
        select: { errorCode: true },
      }),
    ]);

    const byCode = new Map<string, number>();

    for (const row of failRows) {
      const code = row.errorCode ?? "UNKNOWN";

      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    }

    const limited =
      (byCode.get("RATE_LIMITED") ?? 0) + (byCode.get("DAILY_QUOTA_EXCEEDED") ?? 0);
    const upstream = failRows.length - limited;
    const total = okCount + failRows.length;

    if (total === 0) {
      report.info("最近 24 小时没有 AI 调用", "无从谈趋势");
    } else {
      const rate = total > 0 ? Math.round((failRows.length / total) * 100) : 0;

      report.raw(
        `      成功 ${okCount} ｜ 失败 ${failRows.length}（其中被限流 ${limited}、上游/其他 ${upstream}）｜ 失败率 ${rate}%`
      );

      if (byCode.size > 0) {
        const detail = [...byCode.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([code, count]) => `${code}×${count}`)
          .join("、");

        report.raw(`      失败明细：${detail}`);
      }

      if (failRows.length === 0) {
        report.ok("没有失败记录");
      } else if (rate >= 50 && total >= 10) {
        report.fail(
          "AI 失败率过高",
          `${failRows.length}/${total}（≥50% 且样本 ≥10），大概率是上游模型或网络的问题，去看上游状态`
        );
      } else if (rate >= 30 && total >= 10) {
        report.warn("AI 失败率偏高", `${failRows.length}/${total}，建议盯一天再判断`);
      } else {
        report.ok("失败率在正常范围", `失败 ${failRows.length} 次`);
      }
    }

    // 顺手看一眼成功调用的平均耗时（有 durationMs 的才统计）
    const durations = await prisma.aiUsage.findMany({
      where: { ok: true, durationMs: { not: null }, createdAt: { gte: since } },
      select: { durationMs: true },
    });

    if (durations.length > 0) {
      const avg =
        durations.reduce((sum, row) => sum + (row.durationMs ?? 0), 0) /
        durations.length;

      report.ok("成功调用平均耗时", `${durations.length} 次，平均 ${formatDuration(avg)}`);
    }

    await prisma.$disconnect();
  } else {
    report.skip("跳过", "上一节数据库就没连上");
  }

  const file = report.write("ops-reports", "daily");

  report.print();

  if (file) console.log(`报告已写入：${file}`);

  process.exitCode = report.hasFailure ? 1 : 0;
}

main().catch((error) => {
  console.error("ops-daily 自己崩了：", error);
  process.exitCode = 1;
});
