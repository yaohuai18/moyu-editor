import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";

const prisma = new PrismaClient();

/**
 * 演示账号的密码。
 *
 * 第六阶段之前是「写死的演示用户」，账号没有密码，谁都不用登录就能用。
 * 加了登录之后，如果这个账号还是没密码，库里已有的作品就会变成
 * **谁都进不去的孤儿数据**——所以这里给它补一个可用密码，
 * 让老作品仍然能登进去看到。正式上线前请改掉或删掉这个账号。
 */
const DEMO_USER_EMAIL = "demo@moyu.local";
const DEMO_USER_PASSWORD = "moyu-demo-2026";

/**
 * 种子数据脚本：可重复执行（idempotent）。
 * 已经有数据就只补缺的部分，不会重复造，也不会覆盖你写的内容。
 */
async function main() {
  const user = await prisma.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    update: {},
    create: {
      email: DEMO_USER_EMAIL,
      name: "演示作者",
      passwordHash: await hashPassword(DEMO_USER_PASSWORD),
    },
  });

  // 老账号补密码：只补「从来没有过密码」的，不动别人改过的密码
  if (!user.passwordHash) {
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(DEMO_USER_PASSWORD) },
    });
    console.log(`已为演示账号 ${DEMO_USER_EMAIL} 补上登录密码`);
  }

  // 作品：没有就建，有就复用
  let project = await prisma.project.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });

  if (!project) {
    project = await prisma.project.create({
      data: {
        userId: user.id,
        title: "我的第一部小说",
        description: "一个用于测试的小说项目",
        genre: "都市",
      },
    });
    console.log("已创建演示作品");
  }

  // 风格档案：一对一。没有就建；已经有但字段空着，就把空的补上（不动你填过的）
  const styleDefaults: Record<string, string> = {
    tone: "克制、细腻",
    viewpoint: "第三人称限知",
    sentenceStyle: "长短句结合，避免过度工整",
    forbiddenWords: "不由得、心中一震、眸子",
  };

  const styleProfile = await prisma.styleProfile.findUnique({
    where: { projectId: project.id },
  });

  if (!styleProfile) {
    await prisma.styleProfile.create({
      data: { projectId: project.id, ...styleDefaults },
    });
    console.log("已创建风格档案");
  } else {
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(styleDefaults)) {
      if (!(styleProfile as unknown as Record<string, string | null>)[key]) {
        patch[key] = value;
      }
    }
    if (Object.keys(patch).length > 0) {
      await prisma.styleProfile.update({
        where: { projectId: project.id },
        data: patch,
      });
      console.log("已补齐风格档案空缺字段：" + Object.keys(patch).join("、"));
    }
  }

  // 章节：一章都没有才建
  const chapterCount = await prisma.chapter.count({
    where: { projectId: project.id },
  });

  if (chapterCount === 0) {
    await prisma.chapter.create({
      data: {
        projectId: project.id,
        title: "第一章 初见",
        content: "这里是第一章的示例内容。",
        orderIndex: 0,
        wordCount: 15,
      },
    });
    console.log("已创建第一章");
  }

  // 人物卡：一张都没有才建
  const characterCount = await prisma.character.count({
    where: { projectId: project.id },
  });

  if (characterCount === 0) {
    await prisma.character.createMany({
      data: [
        {
          projectId: project.id,
          name: "周砚",
          description: "三十出头的旧货商，专门收售老物件，话少。",
          personality: "表面冷淡、内里念旧",
          speakingStyle: "短句，很少解释，常用反问句",
          forbiddenWords: "呢、啦、人家",
        },
        {
          projectId: project.id,
          name: "林晚",
          description: "报社的校对员，习惯把每件事都记在随身的小本子上。",
          personality: "较真、敏感、嘴硬心软",
          speakingStyle: "句子偏长，喜欢用具体的数字和细节",
          forbiddenWords: "随便、无所谓",
        },
      ],
    });
    console.log("已创建两张人物卡");
  }

  console.log("初始化完成");
  console.log("用户ID：", user.id);
  console.log("作品ID：", project.id);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
