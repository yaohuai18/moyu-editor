#!/usr/bin/env node
/**
 * moyu-editor 数据库取证脚本（只读）
 *
 * 用途：验证技能第五节的「铁律一」执行器 —— 界面说「已保存」之后，
 *       到 SQLite 里把那一行真捞出来，证明它真的落盘了。
 *
 * 用法：
 *   node probe-db.cjs <输出json路径> [--email-prefix verify+] [--chapter-id <id>]
 *
 *   node probe-db.cjs E:\tmp\dbcheck.json
 *   node probe-db.cjs E:\tmp\dbcheck.json --chapter-id cmwpvrnl00005uhbwayh1xd9m
 *
 * 环境：
 *   DATABASE_URL 必须是 SQLite 文件的绝对路径，形如
 *     file:<项目根>/prisma/dev.db
 *   相对路径 file:./dev.db 会相对 process.cwd() 解析，很容易指向错的文件，
 *   所以这里强制要求绝对路径，否则直接报错退出（宁可不跑，也不要查错库）。
 *
 * 只读保证：脚本里没有任何 create / update / delete / $executeRaw，只有 find/count。
 */

const fs = require("node:fs");
const path = require("node:path");

// ---- 参数 ----
const argv = process.argv.slice(2);
const outPath = argv[0];

if (!outPath) {
  console.error("用法: node probe-db.cjs <输出json路径> [--email-prefix verify+] [--chapter-id <id>]");
  process.exit(2);
}

function flag(name, dflt) {
  const i = argv.indexOf(name);

  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

const emailPrefix = flag("--email-prefix", "verify+");
const chapterId = flag("--chapter-id", null);

// ---- 数据库地址校验 ----
const dbUrl = process.env.DATABASE_URL || "";

if (!dbUrl.startsWith("file:")) {
  console.error("DATABASE_URL 没设或不是 file: 协议。先设成绝对路径，例如：");
  console.error('  $env:DATABASE_URL = "file:E:/.../moyu-editor/prisma/dev.db"');
  process.exit(2);
}

const dbFile = dbUrl.slice("file:".length);

if (!path.isAbsolute(dbFile)) {
  console.error(`DATABASE_URL 里的路径不是绝对路径：${dbFile}`);
  console.error("相对路径会相对当前目录解析，可能查到别的库。请改用绝对路径。");
  process.exit(2);
}

if (!fs.existsSync(dbFile)) {
  console.error(`数据库文件不存在：${dbFile}`);
  process.exit(2);
}

// ---- Prisma client ----
// 本脚本已放在项目内（skills/verify-app/scripts/），项目根从脚本位置往上推三级：
//   scripts → verify-app → skills → <项目根>
// 换机器 / 换目录不用改；真需要指向别的项目时用 MOYU_PROJECT_ROOT 覆盖。
const PROJECT_ROOT =
  process.env.MOYU_PROJECT_ROOT || path.resolve(__dirname, "../../..");

const { PrismaClient } = require(
  path.join(PROJECT_ROOT, "node_modules", "@prisma", "client")
);

const prisma = new PrismaClient();

function write(payload) {
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
}

(async () => {
  const user = await prisma.user.findFirst({
    where: { email: { startsWith: emailPrefix } },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, name: true, createdAt: true },
  });

  // 按 chapterId 直查时，不需要账号存在。
  //
  // ⚠️ 这里刻意**不做** fallback：找不到 verify 账号时，绝不能退化成
  //    「查全库最新一章」——那会捞到真实作者的正文，然后被当成测试数据
  //    写进验证报告里。找不到就是找不到，返回 null 让人一眼看出问题。
  const chapter = chapterId
    ? await prisma.chapter.findUnique({ where: { id: chapterId } })
    : user
      ? await prisma.chapter.findFirst({
          where: { project: { userId: user.id } },
          orderBy: { updatedAt: "desc" },
        })
      : null;

  const project = chapter
    ? await prisma.project.findUnique({
        where: { id: chapter.projectId },
        select: { id: true, title: true, genre: true, updatedAt: true },
      })
    : null;

  const revisions = chapter
    ? await prisma.revision.count({ where: { chapterId: chapter.id } })
    : 0;

  const latestRevision = chapter
    ? await prisma.revision.findFirst({
        where: { chapterId: chapter.id },
        orderBy: { createdAt: "desc" },
        select: { chars: true, changeReason: true, createdAt: true },
      })
    : null;

  // 账号名下数据总量 —— 注销前用它确认「会删掉多少」，注销后用它确认「确实删干净了」
  const totals = user
    ? {
        projects: await prisma.project.count({ where: { userId: user.id } }),
        chapters: await prisma.chapter.count({ where: { project: { userId: user.id } } }),
        revisions: await prisma.revision.count({
          where: { chapter: { project: { userId: user.id } } },
        }),
      }
    : null;

  write({
    dbFile,
    emailPrefix,
    note: user
      ? undefined
      : `没有找到邮箱前缀为 "${emailPrefix}" 的账号。若这是清理之后的复查，属正常；若刚注册过账号仍查不到，说明 DATABASE_URL 指向了错误的库文件。`,
    user,
    project,
    chapter: chapter
      ? {
          id: chapter.id,
          title: chapter.title,
          contentLen: chapter.content.length,
          content: chapter.content,
          wordCount: chapter.wordCount,
          version: chapter.version,
          updatedAt: chapter.updatedAt,
        }
      : null,
    revisions,
    latestRevision,
    totals,
  });

  console.log(`OK -> ${outPath}`);
})().catch((error) => {
  write({ error: String(error), dbFile, emailPrefix });
  console.error("查询失败：" + String(error));
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
