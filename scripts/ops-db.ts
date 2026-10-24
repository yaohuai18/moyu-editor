/**
 * 数据库体检：`npm run ops:db`
 *
 * 七件事：
 *   1. 完整性（PRAGMA quick_check —— 库文件有没有内部损坏）
 *   2. 容量（库文件 / WAL 文件大小，页统计）
 *   3. 各表行数（看哪张表在疯长）
 *   4. 关键查询延迟抽样 + 索引使用（SQLite 没有 slow log，
 *      用「真的跑一遍关键查询 + EXPLAIN QUERY PLAN」做等价检查）
 *   5. 孤立数据（外键本该挡住的东西，再亲手数一遍兜底）
 *   6. 迁移状态（目录里的迁移 vs 数据库里的记录，有没有没跑的 / 跑挂的）
 *   7. 备份（backups/ 里最新一份是多久前的）
 *
 * 全程只读，不写任何业务数据。
 * 报告写到 ops-reports/db-*.txt。
 */

import fs from "node:fs";
import path from "node:path";
import {
  Report,
  daysBetween,
  formatBytes,
  formatDateTime,
  formatDuration,
  openOpsPrisma,
  sqliteFilePath,
} from "./ops-lib";

type ExplainRow = { detail: string };

async function main() {
  const report = new Report("墨语编辑器 · 数据库体检");
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

  // ── 1. 完整性 ────────────────────────────────────────────────
  report.head("1. 完整性（PRAGMA quick_check）");

  try {
    const rows = (await prisma.$queryRawUnsafe(
      "PRAGMA quick_check"
    )) as unknown as { quick_check?: string }[];

    const verdict = rows[0]?.quick_check ?? "未知";

    if (verdict === "ok") {
      report.ok("库文件完整", "quick_check = ok");
    } else {
      report.fail("库文件可能损坏", `quick_check 返回：${verdict}`);
    }
  } catch (error) {
    report.fail("完整性检查跑不了", error instanceof Error ? error.name : String(error));
  }

  // ── 2. 容量 ──────────────────────────────────────────────────
  report.head("2. 容量");

  const dbFile = sqliteFilePath(env.DATABASE_URL ?? process.env.DATABASE_URL ?? "");

  if (!dbFile) {
    report.info("不是 SQLite 文件库", "容量检查按托管数据库的方式另行处理");
  } else {
    try {
      const stat = fs.statSync(dbFile);
      const wal = `${dbFile}-wal`;

      let walSize = 0;

      if (fs.existsSync(wal)) walSize = fs.statSync(wal).size;

      report.ok("库文件", `${dbFile}，${formatBytes(stat.size)}`);
      report.raw(
        `      WAL 文件：${walSize > 0 ? formatBytes(walSize) : "无"}` +
          `（WAL 很大说明有检查点没合并，跑一次 npm run db:backup 会顺手做 checkpoint）`
      );
      report.raw(`      最后修改：${formatDateTime(stat.mtime)}`);
    } catch {
      report.fail("库文件读不到", dbFile);
    }

    try {
      const pages = (
        (await prisma.$queryRawUnsafe(
          "PRAGMA page_count"
        )) as unknown as { page_count: number }[]
      )[0];
      const size = (
        (await prisma.$queryRawUnsafe("PRAGMA page_size")) as unknown as {
          page_size: number;
        }[]
      )[0];

      report.raw(
        `      页统计：${pages?.page_count ?? "?"} 页 × ${size?.page_size ?? "?"} B/页`
      );
    } catch {
      // 页统计拿不到也不影响大局
    }
  }

  // ── 3. 各表行数 ──────────────────────────────────────────────
  report.head("3. 各表行数");

  try {
    const [users, projects, chapters, revisions, characters, styleProfiles, aiUsages] =
      await Promise.all([
        prisma.user.count(),
        prisma.project.count(),
        prisma.chapter.count(),
        prisma.revision.count(),
        prisma.character.count(),
        prisma.styleProfile.count(),
        prisma.aiUsage.count(),
      ]);

    report.raw(
      [
        `      用户 ${users}`,
        `作品 ${projects}`,
        `章节 ${chapters}`,
        `版本 ${revisions}`,
        `人物 ${characters}`,
        `风格档案 ${styleProfiles}`,
        `AI 台账 ${aiUsages}`,
      ].join(" ｜ ")
    );

    // 版本表是最容易疯长的：每次保存一条。给出人均参考值。
    if (chapters > 0) {
      const avgPerChapter = Math.round((revisions / chapters) * 10) / 10;

      report.ok(
        "行数统计完成",
        `平均每章 ${avgPerChapter} 条版本记录（>200 说明该做版本清理了，见 docs/数据库维护.md）`
      );
    } else {
      report.ok("行数统计完成", "还没有章节");
    }
  } catch (error) {
    report.fail("行数统计失败", error instanceof Error ? error.name : String(error));
  }

  // ── 4. 关键查询延迟 + 索引使用 ───────────────────────────────
  report.head("4. 关键查询（延迟抽样 + 索引使用）");

  // 每条都是界面上真实会跑的查询。 detail 里出现 SCAN 就说明索引没被用上。
  const probes: { name: string; sql: string; wantIndex: string }[] = [
    {
      name: "用户的作品列表",
      sql: "SELECT id, title FROM Project WHERE userId = (SELECT id FROM User LIMIT 1) ORDER BY updatedAt DESC",
      wantIndex: "Project_userId",
    },
    {
      name: "章节的版本历史（分页）",
      sql: "SELECT id, chars FROM Revision WHERE chapterId = (SELECT id FROM Chapter LIMIT 1) ORDER BY createdAt DESC LIMIT 20 OFFSET 0",
      wantIndex: "Revision_chapterId",
    },
    {
      // 注意：Prisma 在 SQLite 里把 DateTime 存成整数毫秒，条件必须用数值比
      name: "用户某天的 AI 用量",
      sql: "SELECT COUNT(*) FROM AiUsage WHERE userId = (SELECT id FROM User LIMIT 1) AND ok = 1 AND createdAt >= 0",
      wantIndex: "AiUsage_userId",
    },
    {
      name: "全站某天的 AI 调用",
      sql: "SELECT COUNT(*) FROM AiUsage WHERE createdAt >= 0",
      wantIndex: "AiUsage_createdAt",
    },
  ];

  for (const probe of probes) {
    try {
      const startedAt = Date.now();
      let rounds = 0;

      // 太快的查询单次计时没有意义，跑 20 次取平均
      for (let i = 0; i < 20; i++) {
        await prisma.$queryRawUnsafe(probe.sql);

        rounds += 1;
      }

      const avg = (Date.now() - startedAt) / rounds;
      const plan = (await prisma.$queryRawUnsafe(
        `EXPLAIN QUERY PLAN ${probe.sql}`
      )) as unknown as ExplainRow[];

      const planText = plan.map((row) => row.detail).join(" | ");
      const fullScan = /SCAN [A-Za-z_]+$/i.test(planText) && !/INDEX/.test(planText);

      if (fullScan) {
        report.warn(
          `${probe.name}`,
          `平均 ${formatDuration(avg)}，但执行计划在整表扫描：${planText}`
        );
      } else {
        report.ok(`${probe.name}`, `平均 ${formatDuration(avg)}，走了索引`);
      }
    } catch (error) {
      // 有的库一条数据都没有时子查询会是空 —— 这种算跳过不算失败
      report.warn(
        `${probe.name}`,
        `查询没跑成（库可能是空的）：${error instanceof Error ? error.name : String(error)}`
      );
    }
  }

  // ── 5. 孤立数据 ──────────────────────────────────────────────
  report.head("5. 孤立数据（外键之外的兜底检查）");

  const orphanChecks: { name: string; sql: string }[] = [
    {
      name: "没有作品归属的章节",
      sql: "SELECT COUNT(*) AS n FROM Chapter WHERE projectId NOT IN (SELECT id FROM Project)",
    },
    {
      name: "没有章节归属的版本",
      sql: "SELECT COUNT(*) AS n FROM Revision WHERE chapterId NOT IN (SELECT id FROM Chapter)",
    },
    {
      name: "没有作品归属的人物卡",
      sql: "SELECT COUNT(*) AS n FROM Character WHERE projectId NOT IN (SELECT id FROM Project)",
    },
    {
      name: "没有作品归属的风格档案",
      sql: "SELECT COUNT(*) AS n FROM StyleProfile WHERE projectId NOT IN (SELECT id FROM Project)",
    },
    {
      name: "没有用户归属的 AI 台账",
      sql: "SELECT COUNT(*) AS n FROM AiUsage WHERE userId NOT IN (SELECT id FROM User)",
    },
    {
      name: "没有用户归属的作品",
      sql: "SELECT COUNT(*) AS n FROM Project WHERE userId NOT IN (SELECT id FROM User)",
    },
  ];

  let orphanTotal = 0;

  for (const check of orphanChecks) {
    try {
      const rows = (await prisma.$queryRawUnsafe(check.sql)) as unknown as { n: number }[];
      const count = Number(rows[0]?.n ?? 0);

      orphanTotal += count;

      if (count > 0) {
        report.fail(check.name, `${count} 条 —— 这就是「删号没删干净」，要按 docs/备份恢复.md 里的流程处理`);
      } else {
        report.ok(check.name, "0 条");
      }
    } catch (error) {
      report.warn(check.name, `查不了：${error instanceof Error ? error.name : String(error)}`);
    }
  }

  if (orphanTotal === 0) {
    report.raw("      （AiUsage 里的 projectId / chapterId 有意不做外键 —— 用量是已经花掉的钱，");
    report.raw("        作品删了也不该消失，所以不在孤立检查之列。）");
  }

  // ── 6. 迁移状态 ──────────────────────────────────────────────
  report.head("6. 迁移状态");

  try {
    const migrationsDir = path.join(process.cwd(), "prisma", "migrations");
    const onDisk = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    const appliedRows = (await prisma.$queryRawUnsafe(
      "SELECT migration_name, finished_at FROM _prisma_migrations"
    )) as unknown as { migration_name: string; finished_at: Date | null }[];

    const appliedNames = new Set(appliedRows.map((row) => row.migration_name));
    const pending = onDisk.filter((name) => !appliedNames.has(name));
    const failed = appliedRows.filter((row) => !row.finished_at);

    report.ok(
      "迁移记录可读",
      `目录里 ${onDisk.length} 个，已应用 ${appliedNames.size} 个`
    );

    if (pending.length > 0) {
      report.fail(
        "有迁移没跑",
        `待应用：${pending.join("、")} —— 部署前必须先 npm run db:deploy`
      );
    } else {
      report.ok("没有待应用的迁移");
    }

    if (failed.length > 0) {
      report.fail(
        "有跑挂的迁移",
        failed.map((row) => row.migration_name).join("、")
      );
    } else {
      report.ok("没有跑挂的迁移");
    }
  } catch (error) {
    report.warn("迁移状态读不了", error instanceof Error ? error.name : String(error));
  }

  // ── 7. 备份 ──────────────────────────────────────────────────
  report.head("7. 备份（backups/）");

  try {
    const backupDir = path.join(process.cwd(), "backups");
    const files = fs
      .readdirSync(backupDir)
      .filter((name) => name.endsWith(".db") || name.endsWith(".sqlite") || name.endsWith(".zip"))
      .map((name) => {
        const full = path.join(backupDir, name);
        const stat = fs.statSync(full);

        return { name, mtime: stat.mtime, size: stat.size };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    if (files.length === 0) {
      report.warn(
        "一个备份都没有",
        "现在就跑一次 npm run db:backup（详见 docs/备份恢复.md）"
      );
    } else {
      const latest = files[0];
      const ageDays = daysBetween(latest.mtime);

      report.raw(
        `      一共 ${files.length} 份，最新：${latest.name}（${formatBytes(latest.size)}，${formatDateTime(latest.mtime)}）`
      );

      if (ageDays > 7) {
        report.warn("最新备份超过 7 天", `距今 ${Math.floor(ageDays)} 天，跑一次 npm run db:backup`);
      } else if (ageDays > 1) {
        report.warn("最新备份超过 1 天", "如果这是生产库，每天一备是底线");
      } else {
        report.ok("备份是新的", `距今 ${Math.floor(ageDays * 24)} 小时`);
      }

      const totalSize = files.reduce((sum, file) => sum + file.size, 0);

      report.raw(`      备份总占用：${formatBytes(totalSize)}（清理策略见 docs/数据库维护.md）`);
    }
  } catch {
    report.warn("backups/ 目录不存在", "跑一次 npm run db:backup 就会自动建");
  }

  await prisma.$disconnect();

  const file = report.write("ops-reports", "db");

  report.print();

  if (file) console.log(`报告已写入：${file}`);

  process.exitCode = report.hasFailure ? 1 : 0;
}

main().catch((error) => {
  console.error("ops-db 自己崩了：", error);
  process.exitCode = 1;
});
