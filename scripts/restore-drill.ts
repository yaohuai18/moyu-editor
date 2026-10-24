/**
 * 备份恢复演练 —— `npm run db:restore-drill`
 *
 * 备份最坑的地方不是「有没有备份」，而是**你以为备份能用，真出事时发现打不开**。
 * 所以这份脚本做的是完整体检：造数据 → 备份 → 在另一个库里恢复 → 逐项核对
 * （账号还在不在、作品章节版本的关系有没有断）→ 清理。
 *
 * 三条硬规矩：
 * 1. **不碰生产库的恢复**：恢复出来的库放在 backups/ 里单独打开，
 *    绝不会覆盖 prisma/dev.db。演练的目的就是「不动现有数据」。
 * 2. **演练数据带明显标记**（drill@moyu.local），跑完就删干净，
 *    不会混进真实作品列表。
 * 3. 演练里**校验密码能验通**，而不只是「这条记录还在」——
 *    恢复后登不上是最常见的翻车方式。
 */

import fs from "node:fs";
import path from "node:path";
import { loadEffectiveEnv, resolveSqlitePath } from "./env-file";

const ROOT = process.cwd();
const DRILL_DIR = path.join(ROOT, "_p9");
const DRILL_EMAIL = "drill@moyu.local";
const DRILL_PASSWORD = "drill-password-2026";

type Check = { label: string; ok: boolean; detail?: string };

const checks: Check[] = [];

function record(label: string, ok: boolean, detail?: string) {
  checks.push({ label, ok, detail });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${label}${detail ? ` | ${detail}` : ""}`);
}

function timestamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** 把绝对路径转成 Prisma 认的 file: URL（Windows 上反斜杠要换成正斜杠） */
function fileUrl(absolutePath: string) {
  return `file:${absolutePath.replace(/\\/g, "/")}`;
}

async function main() {
  console.log("墨语编辑器 · 备份恢复演练");
  console.log("=".repeat(52));

  const { env, files } = loadEffectiveEnv(ROOT);
  const databaseUrl = env.DATABASE_URL ?? "";

  if (!databaseUrl) {
    record("DATABASE_URL 已配置", false);
    process.exitCode = 1;
    return;
  }

  if (!databaseUrl.startsWith("file:")) {
    console.log("\n当前连的不是本地 SQLite（看起来是托管数据库）。");
    console.log("托管数据库的恢复演练请用供应商的「恢复到新实例」功能，");
    console.log("或者手动：pg_restore -d <另一个新库> backup.dump，再核对数据。");
    return;
  }

  console.log(`配置来源：${files.join(" → ") || "进程环境变量"}`);

  process.env.DATABASE_URL = databaseUrl;

  const { PrismaClient } = await import("@prisma/client");
  const { verifyPassword } = await import("../src/lib/password");

  const source = new PrismaClient();

  // ---------- 一、造演练数据 ----------
  console.log("\n[1/6] 在源库创建演练数据");

  // 先清掉上一次演练可能残留的数据（同一个邮箱 = 同一批演练数据）
  await source.user.deleteMany({ where: { email: DRILL_EMAIL } });

  const { hashPassword } = await import("../src/lib/password");

  const drillUser = await source.user.create({
    data: {
      email: DRILL_EMAIL,
      name: "备份演练账号",
      passwordHash: await hashPassword(DRILL_PASSWORD),
    },
  });

  const drillProject = await source.project.create({
    data: {
      userId: drillUser.id,
      title: "【演练】备份恢复用作品",
      description: "这个作品只用于备份恢复演练，脚本跑完会自动删除",
      genre: "演练",
      styleProfile: {
        create: { tone: "平实", viewpoint: "第三人称", sentenceStyle: "长短句交替" },
      },
      characters: {
        create: [{ name: "演练角色", personality: "谨慎", speakingStyle: "话少" }],
      },
    },
  });

  const chapterTitles = ["演练第一章", "演练第二章"];

  for (const [index, title] of chapterTitles.entries()) {
    const chapter = await source.chapter.create({
      data: {
        projectId: drillProject.id,
        title,
        orderIndex: index,
        content: `${title}的初稿内容。`,
        wordCount: 8,
      },
    });

    // 每个章节写两次，制造两条版本记录
    for (const round of [1, 2]) {
      const content = `${title}第 ${round} 稿：雨停了，路上没有人。`;

      await source.chapter.update({
        where: { id: chapter.id },
        data: { content, wordCount: content.length, version: { increment: 1 } },
      });

      await source.revision.create({
        data: {
          chapterId: chapter.id,
          userId: drillUser.id,
          content,
          changeReason: `演练第 ${round} 次保存`,
        },
      });
    }
  }

  const sourceCounts = {
    users: await source.user.count(),
    projects: await source.project.count(),
    chapters: await source.chapter.count(),
    revisions: await source.revision.count(),
    characters: await source.character.count(),
  };

  record(
    "演练数据已创建",
    sourceCounts.chapters >= 2 && sourceCounts.revisions >= 4,
    `章节 ${sourceCounts.chapters} / 版本 ${sourceCounts.revisions}`
  );

  // ---------- 二、备份 ----------
  console.log("\n[2/6] 备份（先落盘 WAL，再复制文件）");

  const sourcePath = resolveSqlitePath(ROOT, databaseUrl);

  try {
    await source.$queryRawUnsafe("PRAGMA wal_checkpoint(FULL)");
    record("WAL 已落盘", true, "最近几次写入已写进主库文件");
  } catch (error) {
    record(
      "WAL 已落盘",
      false,
      `没成功：${error instanceof Error ? error.name : "unknown"}（备份可能少最后一次写入）`
    );
  }

  fs.mkdirSync(DRILL_DIR, { recursive: true });

  const backupPath = path.join(DRILL_DIR, `restore-drill-${timestamp()}.db`);
  fs.copyFileSync(sourcePath, backupPath);

  const sizeKb = Math.round(fs.statSync(backupPath).size / 1024);

  record("备份文件已生成", sizeKb > 0, `${path.relative(ROOT, backupPath)}（${sizeKb} KB）`);

  // ---------- 三、在独立库里恢复 ----------
  console.log("\n[3/6] 在独立数据库里打开这份备份（不动 prisma/dev.db）");

  const restored = new PrismaClient({ datasourceUrl: fileUrl(backupPath) });

  try {
    await restored.$queryRaw`SELECT 1`;
    record("恢复出来的库能打开", true, "说明文件没损坏、schema 认得出来");

    // ---------- 四、核对数据 ----------
    console.log("\n[4/6] 核对数据与关系完整性");

    const restoredCounts = {
      users: await restored.user.count(),
      projects: await restored.project.count(),
      chapters: await restored.chapter.count(),
      revisions: await restored.revision.count(),
      characters: await restored.character.count(),
    };

    for (const key of Object.keys(sourceCounts) as (keyof typeof sourceCounts)[]) {
      record(
        `${key} 数量一致`,
        restoredCounts[key] === sourceCounts[key],
        `源库 ${sourceCounts[key]} / 恢复库 ${restoredCounts[key]}`
      );
    }

    // 关系链：版本 → 章节 → 作品 → 用户，任何一环断了都说明恢复不完整
    const restoredUser = await restored.user.findUnique({
      where: { email: DRILL_EMAIL },
      include: {
        projects: {
          include: {
            chapters: { include: { revisions: true } },
            characters: true,
            styleProfile: true,
          },
        },
      },
    });

    record("演练账号还在", Boolean(restoredUser), DRILL_EMAIL);

    const restoredProject = restoredUser?.projects.find(
      (p) => p.id === drillProject.id
    );

    record("演练作品还在，且挂在同一个账号下", Boolean(restoredProject));

    record(
      "章节全部跟过来了",
      restoredProject?.chapters.length === chapterTitles.length,
      `恢复库 ${restoredProject?.chapters.length ?? 0} 章`
    );

    const revisionCount =
      restoredProject?.chapters.reduce((sum, c) => sum + c.revisions.length, 0) ?? 0;

    record("版本历史全部跟过来了", revisionCount >= 4, `${revisionCount} 条`);

    record(
      "人物卡与风格档案没丢",
      Boolean(restoredProject?.characters.length) && Boolean(restoredProject?.styleProfile)
    );

    // 每条版本都能顺着关系链找回作者
    const orphanRevisions = await restored.revision.count({
      where: {
        userId: drillUser.id,
        chapter: { project: { userId: drillUser.id } },
      },
    });

    record(
      "版本与章节/作品/用户的关联没断",
      orphanRevisions >= 4,
      `${orphanRevisions} 条版本能顺着关系链找回作者`
    );

    // ---------- 五、确认能登录、能读正文 ----------
    console.log("\n[5/6] 确认恢复后能登录、能读出正文");

    const passwordOk =
      Boolean(restoredUser?.passwordHash) &&
      (await verifyPassword(DRILL_PASSWORD, restoredUser!.passwordHash!));

    record(
      "密码能验通（恢复后登得上）",
      passwordOk,
      "用 bcrypt 对着恢复库里的哈希重新验了一次"
    );

    const firstChapter = restoredProject?.chapters
      .slice()
      .sort((a, b) => a.orderIndex - b.orderIndex)[0];

    record(
      "正文内容读得出来",
      Boolean(firstChapter?.content.includes("雨停了")),
      firstChapter?.content.slice(0, 20)
    );

    record(
      "版本号跟着一起恢复了",
      typeof firstChapter?.version === "number" && firstChapter.version > 0,
      `version=${firstChapter?.version}`
    );
  } finally {
    await restored.$disconnect();
  }

  // ---------- 六、清理 ----------
  console.log("\n[6/6] 清理演练数据");

  await source.user.deleteMany({ where: { email: DRILL_EMAIL } });

  const leftovers = await source.project.count({
    where: { title: { contains: "【演练】" } },
  });

  record("源库里的演练数据已删干净", leftovers === 0);

  await source.$disconnect();

  // ---------- 结论 ----------
  const failed = checks.filter((c) => !c.ok);

  console.log("\n" + "=".repeat(52));
  console.log(`共 ${checks.length} 项检查，通过 ${checks.length - failed.length}，失败 ${failed.length}`);

  if (failed.length === 0) {
    console.log("\n结论：备份可用，恢复流程走得通。");
    console.log(`备份文件留着做证据：${path.relative(ROOT, backupPath)}`);
    console.log("\n真要恢复线上数据时（务必先停服务）：");
    console.log("  1. 停掉跑着的 node 进程");
    console.log("  2. 把备份文件复制成 prisma/dev.db");
    console.log("  3. 删掉 prisma/dev.db-wal 和 prisma/dev.db-shm（如果有）");
    console.log("  4. 启动应用，随便打开一个作品确认正文对");
  } else {
    console.log("\n失败项：");

    for (const item of failed) {
      console.log(`  - ${item.label}${item.detail ? `（${item.detail}）` : ""}`);
    }

    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("\n演练脚本崩了：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
