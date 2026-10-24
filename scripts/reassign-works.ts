/**
 * 把某个账号名下的作品整体转给另一个账号 —— `npm run works:move -- --from A --to B`
 *
 * 用途很具体：**上线前处理演示账号**。
 * 演示账号 demo@moyu.local 名下躺着早期做的作品（包括你自己写的），
 * 直接删账号会连作品一起级联删掉。正确顺序是：
 *   1. 你注册一个自己的账号
 *   2. 用这个脚本把作品搬过去
 *   3. 再删演示账号（或者干脆改掉它的密码继续用）
 *
 * 默认只预览不动手，确认无误再加 `--yes`。
 */

import { loadEffectiveEnv } from "./env-file";

const ROOT = process.cwd();

function readArg(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;

  return value && !value.startsWith("--") ? value : "";
}

async function main() {
  const from = readArg("from").toLowerCase().trim();
  const to = readArg("to").toLowerCase().trim();
  const confirmed = process.argv.includes("--yes");

  if (!from || !to) {
    console.log("用法：npm run works:move -- --from 原账号邮箱 --to 新账号邮箱 [--yes]");
    console.log("不加 --yes 只预览，不会真改。");
    process.exitCode = 1;
    return;
  }

  if (from === to) {
    console.error("[FAIL] 原账号和新账号是同一个。");
    process.exitCode = 1;
    return;
  }

  const { env, files } = loadEffectiveEnv(ROOT);

  if (!env.DATABASE_URL) {
    console.error("[FAIL] DATABASE_URL 没配置。");
    process.exitCode = 1;
    return;
  }

  process.env.DATABASE_URL = env.DATABASE_URL;

  console.log("墨语编辑器 · 作品转移");
  console.log(`配置来源：${files.join(" → ") || "进程环境变量"}`);

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  try {
    const source = await prisma.user.findUnique({
      where: { email: from },
      select: { id: true, email: true, name: true },
    });

    const target = await prisma.user.findUnique({
      where: { email: to },
      select: { id: true, email: true, name: true },
    });

    if (!source) {
      console.error(`\n[FAIL] 找不到原账号：${from}`);
      process.exitCode = 1;
      return;
    }

    if (!target) {
      console.error(
        `\n[FAIL] 找不到目标账号：${to}\n       先在网站上注册这个邮箱，再回来跑一次。`
      );
      process.exitCode = 1;
      return;
    }

    const projects = await prisma.project.findMany({
      where: { userId: source.id },
      select: { id: true, title: true, _count: { select: { chapters: true } } },
      orderBy: { updatedAt: "desc" },
    });

    console.log(`\n原账号：${source.email}（${source.name ?? "无名"}）`);
    console.log(`新账号：${target.email}（${target.name ?? "无名"}）`);
    console.log(`要搬的作品 ${projects.length} 部：`);

    for (const project of projects) {
      console.log(`  · ${project.title}（${project._count.chapters} 章）`);
    }

    if (projects.length === 0) {
      console.log("\n原账号名下没有作品，什么都不用做。");
      return;
    }

    if (!confirmed) {
      console.log("\n以上是预览。确认无误后加上 --yes 真搬：");
      console.log(`  npm run works:move -- --from ${from} --to ${to} --yes`);
      return;
    }

    const result = await prisma.project.updateMany({
      where: { userId: source.id },
      data: { userId: target.id },
    });

    console.log(`\n[ok]   已转移 ${result.count} 部作品到 ${target.email}`);
    console.log("      章节、版本历史、人物卡、风格档案都挂在作品下面，跟着一起走。");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("\n脚本崩了：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
