/**
 * 一次性回填：把历史 Revision 的 chars（字数）补上。
 *
 * 为什么需要：chars 是后加的一列，加列之前的历史版本都是 0。
 * 不回填的话，版本历史列表上老版本会全部显示「0 字」。
 *
 * 用法：
 *   npm run db:backfill-chars
 *
 * 可重复执行：只处理 chars = 0 且 content 非空的记录。
 */
import { PrismaClient } from "@prisma/client";
import { countWords } from "../src/lib/wordCount";

const prisma = new PrismaClient();

async function main() {
  const targets = await prisma.revision.findMany({
    where: { chars: 0 },
    select: { id: true, content: true },
  });

  console.log(`待回填版本：${targets.length} 条`);

  let fixed = 0;

  for (const revision of targets) {
    const chars = countWords(revision.content);

    // 空正文本来就是 0 字，没必要写库
    if (chars === 0) {
      continue;
    }

    await prisma.revision.update({
      where: { id: revision.id },
      data: { chars },
    });

    fixed += 1;
  }

  const remaining = await prisma.revision.count({ where: { chars: 0 } });

  console.log(`已回填：${fixed} 条`);
  console.log(`仍为 0 字（真正空的版本）：${remaining} 条`);
}

main()
  .catch((error) => {
    console.error("回填失败：", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
