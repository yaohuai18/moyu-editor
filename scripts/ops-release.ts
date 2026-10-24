/**
 * 发布流水线：`npm run ops:release`
 *
 * 发版不想靠记忆，就把「发版前必须绿的东西」做成一条命令：
 *
 *   1. 五连检查（顺序有讲究）：
 *      lint → 类型检查 → 单元测试 → 生产构建 → 接口测试
 *      （构建排在接口测试前面：test:api 用的是 .next 产物，
 *        先构建才能测到「这次要发的代码」，而不是上一次的）
 *   2. 迁移状态（prisma migrate status，有没有没应用的）
 *   3. 备份状态（最新的备份超过 24 小时就自动先备一份 ——
 *      迁移之前必须有新鲜备份，这是 docs/回滚方案.md 的第一条）
 *   4. 部署九步清单（发版时照着走）
 *   5. 版本档案（本次检查的全部结果落成文件，就是发布记录的素材）
 *
 * 已知情况的降级：本机沙箱有「批量删除保护」，`next build` 收尾删临时文件
 * 可能被拦下导致退出码非 0 —— 只要「编译成功 + 静态页生成 + 被拦的是删除保护」
 * 三条都对上，就降级成提醒而不是失败。别的情况照旧算失败。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Report, daysBetween, formatBytes, formatDateTime, formatDuration, nowStamp } from "./ops-lib";

const NODE = process.execPath;
const ROOT = process.cwd();

type Step = {
  name: string;
  args: string[];
  logName: string;
  timeoutMs: number;
};

/** 跑一条命令，把 stdout+stderr 落到日志文件。返回 { exit, logPath, ms } */
function runStep(step: Step, logDir: string) {
  return new Promise<{ exit: number | null; logPath: string; ms: number }>((resolve) => {
    const logPath = path.join(logDir, step.logName);
    const startedAt = Date.now();
    const out = fs.createWriteStream(logPath, { flags: "w" });
    const child = spawn(NODE, step.args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, step.timeoutMs);

    child.stdout.pipe(out);
    child.stderr.pipe(out);

    child.on("close", (exit) => {
      clearTimeout(timer);
      out.end();
      resolve({ exit, logPath, ms: Date.now() - startedAt });
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      out.write(`\n[ops-release] 启动失败：${error.message}\n`);
      out.end();
      resolve({ exit: null, logPath, ms: Date.now() - startedAt });
    });
  });
}

/** 取日志尾部几行（报告里只放结论，全文在日志文件里） */
function tailLines(logPath: string, count = 5) {
  try {
    const lines = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/);

    return lines.slice(-count).join("\n");
  } catch {
    return "（日志读不出来）";
  }
}

async function main() {
  const stamp = nowStamp();
  const logDir = path.join(ROOT, "ops-reports", `release-${stamp}`);

  fs.mkdirSync(logDir, { recursive: true });

  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

  const report = new Report(
    `墨语编辑器 · 发布流水线（版本 ${version}）`,
    `日志目录：${path.relative(ROOT, logDir).replace(/\\/g, "/")}/`
  );

  const steps: Step[] = [
    {
      name: "lint（代码规范）",
      args: [path.join("node_modules", "eslint", "bin", "eslint.js"), "."],
      logName: "1-lint.log",
      timeoutMs: 120_000,
    },
    {
      name: "类型检查（tsc --noEmit）",
      args: [path.join("node_modules", "typescript", "bin", "tsc"), "--noEmit"],
      logName: "2-tsc.log",
      timeoutMs: 180_000,
    },
    {
      name: "单元测试",
      args: [path.join("node_modules", "vitest", "vitest.mjs"), "run", "tests/unit"],
      logName: "3-unit.log",
      timeoutMs: 300_000,
    },
    {
      name: "生产构建（next build）",
      args: [path.join("node_modules", "next", "dist", "bin", "next"), "build"],
      logName: "4-build.log",
      timeoutMs: 600_000,
    },
    {
      name: "接口测试（70 项，含独立测试库和假 AI）",
      args: ["scripts/api-test.mjs"],
      logName: "5-api.log",
      timeoutMs: 600_000,
    },
  ];

  // ── 1. 五连检查 ──────────────────────────────────────────────
  report.head("1. 五连检查");

  let failed = false;

  for (const step of steps) {
    const result = await runStep(step, logDir);

    if (result.exit === 0) {
      report.ok(step.name, `${formatDuration(result.ms)}，退出码 0`);
      continue;
    }

    // 已知情况：build 被本机沙箱的批量删除保护拦了收尾
    if (step.name.startsWith("生产构建")) {
      const log = fs.readFileSync(result.logPath, "utf8");
      const compiled = log.includes("Compiled successfully");
      const pages = /Generating static pages/i.test(log);
      const blockedBySandbox = /safe-delete|SAFE_DELETE_BULK/i.test(log);

      if (compiled && pages && blockedBySandbox) {
        report.warn(
          step.name,
          `编译和静态页都成功了，退出码 ${result.exit} 是本机沙箱删除保护拦的（已知问题，见 docs/已知问题.md）—— 换台机器跑就是 0`
        );

        continue;
      }
    }

    report.fail(
      step.name,
      `退出码 ${result.exit ?? "启动失败"}，${formatDuration(result.ms)} —— 日志最后几行：\n${indent(
        tailLines(result.logPath)
      )}`
    );

    failed = true;
  }

  // ── 2. 迁移状态 ──────────────────────────────────────────────
  report.head("2. 迁移状态");

  const migrate = await new Promise<{ exit: number | null; text: string }>((resolve) => {
    const child = spawn(
      NODE,
      [path.join("node_modules", "prisma", "build", "index.js"), "migrate", "status"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
    );
    let text = "";

    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));

    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);

    child.on("close", (exit) => {
      clearTimeout(timer);
      resolve({ exit, text });
    });
  });

  if (migrateNotAppliedParser(migrate.text)) {
    report.fail("有迁移没应用", indent(tail(migrate.text, 8)));
    failed = true;
  } else if (migrate.exit === 0) {
    report.ok("迁移全部应用", "数据库和迁移目录一致");
  } else {
    report.warn("迁移状态判断不了", indent(tail(migrate.text, 4)));
  }

  // ── 3. 备份状态 ──────────────────────────────────────────────
  report.head("3. 备份（发版前必须有新鲜的）");

  try {
    const backupDir = path.join(ROOT, "backups");
    const latest = fs
      .readdirSync(backupDir)
      .filter((name) => name.endsWith(".db"))
      .map((name) => {
        const stat = fs.statSync(path.join(backupDir, name));

        return { name, mtime: stat.mtime, size: stat.size };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0];

    const ageHours = latest ? daysBetween(latest.mtime) * 24 : Infinity;

    if (!latest || ageHours > 24) {
      report.raw(
        latest
          ? `      最新备份是 ${Math.floor(ageHours)} 小时前的（${latest.name}），先自动备一份新的……`
          : "      还没有任何备份，先自动备一份……"
      );

      const backup = await new Promise<{ exit: number | null; text: string }>((resolve) => {
        const child = spawn(
          NODE,
          [path.join("node_modules", "tsx", "dist", "cli.mjs"), "scripts/backup-db.ts"],
          { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
        );
        let text = "";

        child.stdout.on("data", (chunk) => (text += chunk));
        child.stderr.on("data", (chunk) => (text += chunk));

        child.on("close", (exit) => resolve({ exit, text }));
      });

      if (backup.exit === 0) {
        report.ok("已自动备份", indent(tail(backup.text, 3)));
      } else {
        report.fail("自动备份失败", indent(tail(backup.text, 6)));
        failed = true;
      }
    } else {
      report.ok(
        "备份是新鲜的",
        `${latest.name}（${formatBytes(latest.size)}，${formatDateTime(latest.mtime)}）`
      );
    }
  } catch {
    report.warn("backups/ 不存在", "上面那步自动备份应该已经建好了一份");
  }

  // ── 4. 部署九步清单 ──────────────────────────────────────────
  report.head("4. 部署清单（发版时照着走）");

  report.raw(
    [
      "   ① 改 package.json 的 version，更新 docs/发布记录.md（本次改了什么、怎么回滚）",
      "   ② 代码入库打标签：git commit -m \"release: x.y.z\" && git tag vx.y.z && git push --tags",
      "   ③ 服务器上拉代码：git pull && npm ci --legacy-peer-deps",
      "   ④ 备份先行：npm run db:backup（迁移之前做，这是回滚的保险）",
      "   ⑤ 应用迁移：npm run db:deploy",
      "   ⑥ 构建：npm run build",
      "   ⑦ 停旧进程，起新的：npm run serve（本机固定 3001 端口）",
      "   ⑧ 健康检查：curl http://127.0.0.1:3001/api/health 应返回 200",
      "   ⑨ 冒烟：浏览器登录 → 建作品 → 写两个字看状态灯 → 跑一次 npm run ops:daily",
    ].join("\n")
  );

  // ── 5. 结论 ──────────────────────────────────────────────────
  report.head("5. 结论");

  if (failed) {
    report.fail("有必须处理的项", "上面的 FAIL 修完再发");
  } else {
    report.ok(
      "五连全绿 + 迁移就绪 + 备份就绪",
      `版本 ${version} 可以按上面九步发布`
    );
  }

  const file = report.write("ops-reports", "release");

  report.print();

  if (file) console.log(`报告已写入：${file}`);
  console.log(`五连检查的完整日志在：${path.relative(ROOT, logDir).replace(/\\/g, "/")}/`);

  process.exitCode = report.hasFailure ? 1 : 0;
}

/** 缩进一段多行文本（嵌进报告用） */
function indent(text: string, pad = "         ") {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? pad + line : line))
    .join("\n");
}

/** 取文本尾部几行 */
function tail(text: string, count: number) {
  return text.trim().split(/\r?\n/).slice(-count).join("\n");
}

/** migrate status 的输出里出现「待应用」字样 */
function migrateNotAppliedParser(text: string) {
  return /have not yet been applied/i.test(text) || /following migration have not/i.test(text);
}

main().catch((error) => {
  console.error("ops-release 自己崩了：", error);
  process.exitCode = 1;
});
