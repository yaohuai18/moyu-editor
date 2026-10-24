/**
 * 数据库备份 —— `npm run db:backup`
 *
 * 本地开发用的是 SQLite 文件，备份就是「把文件复制一份」，
 * 但有一个细节不能省：**先把 WAL 里的内容落盘**。
 * SQLite 开着 WAL 模式时，最近几次写入还在 dev.db-wal 里，
 * 直接 copy dev.db 会丢掉刚写的东西 —— 备份了个「稍微旧一点」的库。
 *
 * 托管数据库（Postgres 之类）不在这里备份：请用供应商的自动备份，
 * 或按脚本末尾打印的命令用 pg_dump 手动导。
 */

import fs from "node:fs";
import path from "node:path";
import { loadEffectiveEnv, resolveSqlitePath } from "./env-file";

const ROOT = process.cwd();

/** 超过这个数量就提醒清理，但不自动删 —— 备份这东西宁可多 */
const KEEP_HINT = 20;

function timestamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

async function main() {
  const { env, files } = loadEffectiveEnv(ROOT);
  const databaseUrl = env.DATABASE_URL ?? "";

  console.log("墨语编辑器 · 数据库备份");
  console.log(`配置来源：${files.join(" → ") || "进程环境变量"}`);

  if (!databaseUrl) {
    console.error("\n[FAIL] DATABASE_URL 没配置，不知道要备份哪个库。");
    process.exitCode = 1;
    return;
  }

  if (!databaseUrl.startsWith("file:")) {
    console.log("\n这个库不是本地 SQLite 文件，脚本不自动备份。");
    console.log("托管数据库请用供应商的自动备份功能，或者手动执行：");
    console.log('  pg_dump "$DATABASE_URL" -Fc -f backup-$(date +%Y%m%d).dump');
    console.log("\n恢复：");
    console.log('  pg_restore -d "$DATABASE_URL" --clean backup-YYYYMMDD.dump');
    return;
  }

  const dbPath = resolveSqlitePath(ROOT, databaseUrl);

  if (!fs.existsSync(dbPath)) {
    console.error(`\n[FAIL] 找不到数据库文件：${dbPath}`);
    process.exitCode = 1;
    return;
  }

  // 落盘 WAL，保证复制出来的是「当前这一刻」的完整数据
  process.env.DATABASE_URL = databaseUrl;

  try {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();

    try {
      await prisma.$queryRawUnsafe("PRAGMA wal_checkpoint(FULL)");
      console.log("[ok]   已把 WAL 里的改动落盘");
    } finally {
      await prisma.$disconnect();
    }
  } catch (error) {
    console.warn(
      "[warn] WAL 落盘没成功（库可能正被占用），继续复制，但请确认刚才的改动已保存",
      error instanceof Error ? error.name : ""
    );
  }

  const backupDir = path.join(ROOT, "backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const dest = path.join(backupDir, `moyu-${timestamp()}.db`);
  fs.copyFileSync(dbPath, dest);

  const sizeKb = Math.round(fs.statSync(dest).size / 1024);

  console.log(`[ok]   备份完成：${path.relative(ROOT, dest).replace(/\\/g, "/")}（${sizeKb} KB）`);

  const existing = fs.readdirSync(backupDir).filter((name) => name.endsWith(".db"));

  if (existing.length > KEEP_HINT) {
    console.log(
      `[warn] backups/ 里已经有 ${existing.length} 份了，腾地方的话手动删最早的那几份`
    );
  }

  console.log("\n恢复到这份备份（服务要先停掉）：");
  console.log(`  1. 停掉跑着的 node 进程`);
  console.log(`  2. 把 ${path.basename(dest)} 复制回 prisma/dev.db`);
  console.log("  3. 顺手删掉 prisma/dev.db-wal 和 prisma/dev.db-shm（如果有）");
  console.log("  4. 重新启动应用，随便打开一个作品看正文对不对");
}

main().catch((error) => {
  console.error("\n备份脚本崩了：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
