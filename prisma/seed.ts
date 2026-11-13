import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../src/lib/password";

const prisma = new PrismaClient();

/**
 * 演示账号的密码。
 *
 * 第六阶段之前是「写死的演示用户」，账号没有密码，谁都不用登录就能用。
 * 加了登录之后，如果这个账号还是没密码，库里已有的作品就会变成
 * **谁都进不去的孤儿数据**——所以这里给它补一个可用密码。
 *
 * 但密码**不能再写死在仓库里**：这个仓库是公开的，写死等于把钥匙贴在门上。
 * 现在的规则：
 * - 配了 `DEMO_USER_PASSWORD` → 用它（也可以用来轮换已泄露的旧密码；
 *   轮换同时递增 tokenVersion，旧登录会话立即失效）；
 * - 没配、且账号还没有密码 → 随机生成一个，只在本次输出里打印一次；
 * - 没配、且账号已有密码 → 不动、不打印（绝不打印一个没写进库的假密码）；
 * - `NODE_ENV=production` 且没配 → 直接拒绝执行。
 */
const DEMO_USER_EMAIL = process.env.DEMO_USER_EMAIL?.trim() || "demo@moyu.local";
const ENV_DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD?.trim() || null;

// 演示账号邮箱是「安全阀」：seed 会往这个邮箱名下灌演示数据，配了
// DEMO_USER_PASSWORD 时还会重置它的密码。手滑配成真实账号的邮箱，
// 等于一键清掉别人密码 —— 所以只允许演示域名，别的直接拒绝执行。
if (!DEMO_USER_EMAIL.endsWith("@moyu.local")) {
  console.error(
    `拒绝执行：DEMO_USER_EMAIL=${DEMO_USER_EMAIL} 不是演示域名（@moyu.local）。` +
      "演示账号会被灌入演示数据并可能重置密码，绝不能指向真实账号。"
  );
  process.exit(1);
}

/**
 * 种子数据脚本：可重复执行（idempotent）。
 * 已经有数据就只补缺的部分，不会重复造，也不会覆盖你写的内容。
 */
async function main() {
  if (process.env.NODE_ENV === "production" && !ENV_DEMO_PASSWORD) {
    console.error(
      "拒绝在 production 环境用随机演示密码建账号：请显式设置 DEMO_USER_PASSWORD，或不要在生产环境跑 db:seed。"
    );
    process.exit(1);
  }

  const demoPassword = ENV_DEMO_PASSWORD ?? randomBytes(12).toString("base64url");

  const user = await prisma.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    // 显式给了密码就以它为准（这是轮换已泄露密码的入口）；没给就绝不动已有账号的密码
    update: ENV_DEMO_PASSWORD
      ? {
          passwordHash: await hashPassword(demoPassword),
          // 轮换密码必须让旧会话立即失效：tokenVersion 是登录时写进 JWT 的
          // 「会话代次」，requireUser 每次都会和库里比对。只换哈希不递增，
          // 拿着旧 Cookie 的人还能继续用 —— 等于没换。
          tokenVersion: { increment: 1 },
        }
      : {},
    create: {
      email: DEMO_USER_EMAIL,
      name: "演示作者",
      passwordHash: await hashPassword(demoPassword),
    },
  });

  // 老账号补密码：只补「从来没有过密码」的，不动别人改过的密码。
  // 必须先写库、后打印 —— 随机密码只有真的进库了才允许打印，
  // 否则用户会拿着一个根本没生效的密码去登录，必然失败。
  if (!user.passwordHash) {
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(demoPassword) },
    });
  }

  if (ENV_DEMO_PASSWORD) {
    console.log(
      `演示账号 ${DEMO_USER_EMAIL} 的密码已按 DEMO_USER_PASSWORD 设置，旧登录会话已全部失效`
    );
  } else if (!user.passwordHash) {
    console.log(
      `演示账号密码（本次随机生成，只显示这一次）：${demoPassword}`
    );
    console.log(
      "要固定密码：在 PowerShell 里先执行 $env:DEMO_USER_PASSWORD='你的密码'，再跑 npm run db:seed"
    );
  } else {
    console.log(`演示账号 ${DEMO_USER_EMAIL} 已有密码，本次未改动`);
    console.log(
      "要轮换密码（比如旧的已泄露）：设 DEMO_USER_PASSWORD 后重跑本脚本，旧会话会全部失效"
    );
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
