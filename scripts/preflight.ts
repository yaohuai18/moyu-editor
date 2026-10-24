/**
 * 上线前自检 —— `npm run preflight`
 *
 * 一次跑完第八阶段文档里那些「手工确认」的项：
 *   1. 环境变量齐不齐（同时用「生产视角」再查一遍，把只在生产才会犯的错提前抖出来）
 *   2. 密钥会不会漏出去（构建产物里搜、.gitignore 挡没挡住 .env）
 *   3. 代码里有没有把错误堆栈甩给用户、日志里有没有打敏感信息
 *   4. 数据库连不连得上、迁移有没有全部应用、演示账号还在不在
 *   5. 构建产物是不是最新的
 *   6. 有没有可用的数据库备份
 *
 * 只报告，不修改任何东西。有 FAIL 就以退出码 1 结束，方便接进部署流水线。
 */

import fs from "node:fs";
import path from "node:path";
import { inspectEnv, getEnvSummary } from "../src/lib/env";
import type { EnvIssue } from "../src/lib/env";
import { loadEffectiveEnv, resolveSqlitePath } from "./env-file";

const ROOT = process.cwd();

type Level = "pass" | "warn" | "fail";

type Result = {
  section: string;
  level: Level;
  name: string;
  detail?: string;
};

const results: Result[] = [];
let sectionName = "总览";

function setSection(name: string) {
  sectionName = name;
}

function add(level: Level, name: string, detail?: string) {
  results.push({ section: sectionName, level, name, detail });
}

const ok = (name: string, detail?: string) => add("pass", name, detail);
const warn = (name: string, detail?: string) => add("warn", name, detail);
const bad = (name: string, detail?: string) => add("fail", name, detail);

/** 递归列文件；skip 里的目录名会被跳过 */
function walk(dir: string, skip: Set<string>, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) {
    return out;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skip.has(entry.name)) {
        continue;
      }

      walk(path.join(dir, entry.name), skip, out);
      continue;
    }

    out.push(path.join(dir, entry.name));
  }

  return out;
}

function readIfExists(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function relative(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, "/");
}

// ============================================================
// 一、环境变量
// ============================================================

setSection("一、环境变量");

const { env, files } = loadEffectiveEnv(ROOT);

if (files.length === 0) {
  warn(
    ".env 系列文件",
    "项目根目录没有任何 .env 文件，全部靠平台环境变量提供？确认一下"
  );
} else {
  ok(".env 系列文件", `按 Next.js 的优先级读取了：${files.join(" → ")}`);
}

// 同一份问题只报一次，但标出它影响哪些视角
type Merged = { issue: EnvIssue; views: string[] };
const merged = new Map<string, Merged>();

for (const [viewName, viewEnv] of [
  ["当前环境", env],
  ["生产视角", { ...env, NODE_ENV: "production" }],
] as const) {
  for (const issue of inspectEnv(viewEnv)) {
    const id = `${issue.key}::${issue.message}`;
    const existing = merged.get(id);

    if (existing) {
      existing.views.push(viewName);
      continue;
    }

    merged.set(id, { issue, views: [viewName] });
  }
}

for (const { issue, views } of merged.values()) {
  const where = `（${views.join(" / ")}）`;

  if (issue.level === "fatal") {
    bad(`${issue.key} ${where}`, issue.message);
  } else {
    warn(`${issue.key} ${where}`, issue.message);
  }
}

if (merged.size === 0) {
  ok("环境变量体检", "当前环境与生产视角都没有发现问题");
}

// ============================================================
// 二、密钥会不会漏出去
// ============================================================

setSection("二、密钥泄漏面");

const gitignore = readIfExists(path.join(ROOT, ".gitignore"));
const gitignoreLines = gitignore
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const ignores = (...patterns: RegExp[]) =>
  patterns.some((pattern) =>
    gitignoreLines.some((line) => pattern.test(line.replace(/^\//, "")))
  );

if (!gitignore) {
  bad(".gitignore 不存在", "没有它，.env 和数据库文件会被一起提交上去");
} else {
  const rules: Array<[string, boolean]> = [
    [".env 被忽略", ignores(/^\.env$/, /^\.env\*$/i)],
    [".env.example 被放行", ignores(/^!\.env\.example$/, /^!\.env\*$/i)],
    ["node_modules 被忽略", ignores(/^node_modules\/?$/)],
    [".next 被忽略", ignores(/^\.next\/?$/)],
    ["SQLite 数据库文件被忽略", ignores(/prisma\/\*\.db$/, /\*\.db$/, /\*\.sqlite$/)],
  ];

  for (const [name, satisfied] of rules) {
    if (satisfied) {
      ok(`.gitignore · ${name}`);
    } else {
      bad(`.gitignore · ${name}`, "补一条规则再说，别让它进 Git");
    }
  }
}

// 构建产物里搜密钥（这是「浏览器里看不到 Key」的静态证据）
const secrets: Array<[string, string]> = [
  ["AI_API_KEY", env.AI_API_KEY ?? ""],
  ["AUTH_SECRET", env.AUTH_SECRET ?? ""],
];
const staticDir = path.join(ROOT, ".next", "static");

if (!fs.existsSync(staticDir)) {
  warn("构建产物扫描", "还没构建过（没有 .next/static），跳过");
} else {
  const assetFiles = walk(staticDir, new Set()).filter((file) =>
    /\.(js|mjs|css|html|json|txt)$/i.test(file)
  );

  let totalBytes = 0;
  let hits = 0;

  for (const file of assetFiles) {
    // 单个文件超过 5MB 就不读了，正常产物不会有这么大的
    if (fs.statSync(file).size > 5 * 1024 * 1024) {
      continue;
    }

    const text = readIfExists(file);
    totalBytes += text.length;

    for (const [name, value] of secrets) {
      if (value.length >= 12 && text.includes(value)) {
        bad(`密钥泄漏 · ${name}`, `明文出现在 ${relative(file)}`);
        hits += 1;
      }
    }
  }

  if (hits === 0) {
    ok(
      "构建产物扫描",
      `扫了 ${assetFiles.length} 个文件、约 ${Math.round(totalBytes / 1024)} KB，没有密钥明文`
    );
  }
}

// ============================================================
// 三、代码里会不会泄露内部细节
// ============================================================

setSection("三、错误处理与日志");

const sourceFiles = walk(path.join(ROOT, "src"), new Set(["node_modules"]));

const stackLeaks = sourceFiles.filter((file) =>
  /\.stack\b/.test(readIfExists(file))
);

if (stackLeaks.length === 0) {
  ok("没有把 error.stack 返回给用户的地方");
} else {
  for (const file of stackLeaks) {
    bad("疑似泄露堆栈", `${relative(file)} 里出现了 .stack`);
  }
}

const rawMessageLeaks: string[] = [];
const sensitiveLogs: string[] = [];

for (const file of sourceFiles) {
  if (!/\.(ts|tsx)$/.test(file)) {
    continue;
  }

  const text = readIfExists(file);
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    // 接口里直接把 error.message 拼进响应体
    if (
      file.includes(`${path.sep}api${path.sep}`) &&
      /NextResponse\.json\(\s*\{\s*error:\s*(error|err|e)\.(message|stack)/.test(
        line
      )
    ) {
      rawMessageLeaks.push(`${relative(file)}:${index + 1}`);
    }

    // 日志里打敏感信息
    if (
      /console\.(log|error|warn|info)\(/.test(line) &&
      /(password|passwd|passwordHash|authorization|cookie|apikey|api_key|secret)/i.test(
        line
      )
    ) {
      sensitiveLogs.push(`${relative(file)}:${index + 1}  ${line.trim()}`);
    }
  });
}

if (rawMessageLeaks.length === 0) {
  ok("接口没有把原始报错塞进响应体");
} else {
  for (const item of rawMessageLeaks) {
    bad("疑似返回原始报错", item);
  }
}

if (sensitiveLogs.length === 0) {
  ok("日志里没有敏感字段");
} else {
  for (const item of sensitiveLogs) {
    warn("日志里可能出现敏感字段，人工确认一下", item);
  }
}

// ============================================================
// 四、数据库
// ============================================================

setSection("四、数据库");

const databaseUrl = env.DATABASE_URL ?? "";
const summary = getEnvSummary(env);

async function checkDatabase() {
  // 上面的同步检查跑完后 sectionName 已经飘到别处了，这里重新钉回来
  setSection("四、数据库");

  if (!databaseUrl) {
    bad("数据库连接地址", "DATABASE_URL 没配，后面的检查没法做");
    return;
  }

  if (summary.database.kind === "sqlite") {
    const dbPath = resolveSqlitePath(ROOT, databaseUrl);

    if (fs.existsSync(dbPath)) {
      const size = fs.statSync(dbPath).size;
      ok("SQLite 数据库文件存在", `${relative(dbPath)}（${Math.round(size / 1024)} KB）`);
      warn(
        "生产环境不建议用本地 SQLite 文件库",
        "单实例、单机跑没问题；要上多实例请换 Postgres"
      );
    } else {
      bad("SQLite 数据库文件不存在", `${relative(dbPath)} 找不到`);
    }
  } else if (summary.database.kind === "server") {
    ok("使用网络数据库", `类型 ${summary.database.kind}`);
  }

  // 真连一次
  process.env.DATABASE_URL = databaseUrl;

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  try {
    await prisma.$queryRaw`SELECT 1`;
    ok("数据库可以连接");
  } catch (error) {
    bad(
      "数据库连不上",
      error instanceof Error ? error.name : "未知错误（详情请看服务端日志）"
    );
    await prisma.$disconnect();
    return;
  }

  // 迁移：目录里的每个迁移都应该在 _prisma_migrations 里成功应用过
  const migrationsDir = path.join(ROOT, "prisma", "migrations");
  const localMigrations = fs.existsSync(migrationsDir)
    ? fs
        .readdirSync(migrationsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];

  try {
    const rows = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
    >`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;

    const applied = new Set(
      rows
        .filter((row) => row.finished_at && !row.rolled_back_at)
        .map((row) => row.migration_name)
    );

    const pending = localMigrations.filter((name) => !applied.has(name));

    if (pending.length === 0) {
      ok("迁移已全部应用", `共 ${localMigrations.length} 个迁移`);
    } else {
      bad(
        "有迁移没应用",
        `${pending.join(", ")} —— 正式环境用 npx prisma migrate deploy`
      );
    }
  } catch {
    warn("读不到迁移历史表", "_prisma_migrations 表不存在？数据库还没初始化过");
  }

  // 演示账号 / 演示数据
  try {
    const demoEmails = ["demo@moyu.local"];
    const demoUsers = await prisma.user.findMany({
      where: { email: { in: demoEmails } },
      select: {
        email: true,
        _count: { select: { projects: true } },
      },
    });

    if (demoUsers.length === 0) {
      ok("演示账号已经清掉了");
    } else {
      for (const user of demoUsers) {
        warn(
          `演示账号还在：${user.email}`,
          `名下有 ${user._count.projects} 部作品。上线前要么改掉密码继续用，` +
            `要么先把作品转给你自己的账号（npm run works:move）再删`
        );
      }
    }
  } catch {
    warn("演示账号检查", "查不到用户表，跳过");
  }

  // 上线前数据快照
  try {
    const [users, projects, chapters, revisions] = await Promise.all([
      prisma.user.count(),
      prisma.project.count(),
      prisma.chapter.count(),
      prisma.revision.count(),
    ]);

    ok(
      "数据快照",
      `用户 ${users} ｜ 作品 ${projects} ｜ 章节 ${chapters} ｜ 版本记录 ${revisions}`
    );
  } catch {
    // 表还没建全就算了
  }

  await prisma.$disconnect();
}

// ============================================================
// 五、构建产物
// ============================================================

setSection("五、构建产物");

const buildIdPath = path.join(ROOT, ".next", "BUILD_ID");

if (!fs.existsSync(buildIdPath)) {
  bad("没有构建产物", "先跑 npm run build，或直接 npm run app");
} else {
  const buildTime = fs.statSync(buildIdPath).mtimeMs;

  const watched = [
    ...walk(path.join(ROOT, "src"), new Set()),
    path.join(ROOT, "package.json"),
    path.join(ROOT, "prisma", "schema.prisma"),
  ].filter((file) => /\.(ts|tsx|css|json|prisma)$/.test(file));

  const newest = watched.reduce(
    (acc, file) => Math.max(acc, fs.statSync(file).mtimeMs),
    0
  );

  if (newest > buildTime) {
    const stale = watched
      .filter((file) => fs.statSync(file).mtimeMs > buildTime)
      .map(relative)
      .slice(0, 5);

    warn(
      "构建产物比源码旧",
      `最近改过：${stale.join(", ")} —— 上线前重新构建一次`
    );
  } else {
    ok("构建产物是最新的", `BUILD_ID 生成于 ${new Date(buildTime).toLocaleString("zh-CN")}`);
  }
}

// ============================================================
// 六、备份
// ============================================================

setSection("六、备份");

const backupDir = path.join(ROOT, "backups");

if (!fs.existsSync(backupDir)) {
  warn("还没有任何备份", "动手改字段、删数据之前先跑一次 npm run db:backup");
} else {
  const backups = fs
    .readdirSync(backupDir)
    .filter((name) => /\.(db|sqlite|sql|dump)$/i.test(name))
    .map((name) => ({
      name,
      time: fs.statSync(path.join(backupDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time);

  if (backups.length === 0) {
    warn("备份目录是空的", "npm run db:backup 生成一份");
  } else {
    const latest = backups[0];
    ok(
      `最近一次备份：${latest.name}`,
      `${new Date(latest.time).toLocaleString("zh-CN")}（共 ${backups.length} 份）`
    );
  }
}

// ============================================================
// 跑数据库检查（异步）并出报告
// ============================================================

async function main() {
  await checkDatabase();

  // 数据库那一段是异步的，条目会跑到后面去；按固定顺序重排一下再打印
  const sectionOrder = [
    "一、环境变量",
    "二、密钥泄漏面",
    "三、错误处理与日志",
    "四、数据库",
    "五、构建产物",
    "六、备份",
  ];

  const ordered = [...results].sort(
    (a, b) => sectionOrder.indexOf(a.section) - sectionOrder.indexOf(b.section)
  );

  let currentSection = "";

  console.log("\n墨语编辑器 · 上线前自检");
  console.log(`目录：${ROOT}`);
  console.log("=".repeat(64));

  for (const result of ordered) {
    if (result.section !== currentSection) {
      currentSection = result.section;
      console.log(`\n【${currentSection}】`);
    }

    const mark =
      result.level === "pass" ? "[PASS]" : result.level === "warn" ? "[WARN]" : "[FAIL]";

    console.log(`${mark} ${result.name}`);

    if (result.detail) {
      console.log(`       ${result.detail}`);
    }
  }

  const counts = {
    pass: results.filter((r) => r.level === "pass").length,
    warn: results.filter((r) => r.level === "warn").length,
    fail: results.filter((r) => r.level === "fail").length,
  };

  console.log(`\n${"=".repeat(64)}`);
  console.log(`通过 ${counts.pass} ｜ 提醒 ${counts.warn} ｜ 必须处理 ${counts.fail}`);

  console.log("\n下面这几件事没法自动查，上线前自己确认一遍：");
  console.log("  [ ] 生产数据库已经创建，而且**不是**开发用的那个库");
  console.log("  [ ] 数据库供应商已经打开自动备份");
  console.log("  [ ] 真的演练过一次恢复（备份 → 恢复到新库 → 能开站）");
  console.log("  [ ] prisma/migrations 目录已经提交到 Git（迁移历史就是靠它）");
  console.log("  [ ] 平台上的环境变量已经配好，而不是把 .env 文件传上去");
  console.log("  [ ] AUTH_URL 指向正式域名，HTTPS 证书正常");
  console.log("  [ ] 这次用的 AUTH_SECRET 就是长期要用的那个（换它会把所有人踢下线）");

  if (counts.fail > 0) {
    console.log("\n结论：有必须处理的问题，先解决再部署。");
    process.exitCode = 1;
  } else {
    console.log("\n结论：自动检查这一关过了。");
  }
}

main().catch((error) => {
  console.error("\n自检脚本自己崩了：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
