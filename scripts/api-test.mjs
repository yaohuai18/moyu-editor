// 接口测试的一键运行器：起测试库 → 起假 AI → 起网站 → 跑测试 → 全部收摊。
//
// 为什么要有这么个脚本，而不是让测试自己去连一个已经跑着的服务：
//   1. 测试需要**一个连测试库的实例**。对着开发库跑，测试建的作品会混进
//      boss 的作品列表里 —— 那是事故，不是测试。
//   2. 测试需要**假 AI 服务**。真打 DeepSeek 的测试，费钱、慢、还不确定。
//   3. 手动「先开三个窗口再跑测试」的流程，只要忘一步就会得到看不懂的报错。
//
// 用法：
//   npm run build        （先构建，脚本不会替你构建，太慢且容易掩盖问题）
//   npm run test:api
//
// 调试用：如果已经自己起好了服务，设 MOYU_BASE_URL 就会跳过起服务这一步。
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE = process.execPath;
const APP_PORT = Number(process.env.API_TEST_PORT || 3002);
const FAKE_PORT = Number(process.env.FAKE_AI_PORT || 11499);
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}`;
const TEST_DB_URL = "file:./test.db";
const LOG = join(ROOT, "_p9", "api-test.log");

const lines = [];
const say = (text) => {
  lines.push(text);
  console.log(text);
};

const children = [];

function start(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  child.stdout?.on("data", (chunk) => lines.push(`[${label}] ${chunk}`.trimEnd()));
  child.stderr?.on("data", (chunk) => lines.push(`[${label}!] ${chunk}`.trimEnd()));

  children.push(child);

  return child;
}

function stopAll() {
  for (const child of children) {
    if (!child.killed && child.pid) {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已经退出就算了
      }
    }
  }
}

/** 轮询等到接口能应答（或超时） */
async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        return true;
      }
    } catch {
      // 还没起来，继续等
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`${label} 在 ${timeoutMs / 1000} 秒内没有就绪：${url}`);
}

async function main() {
  // ---------- 前置检查 ----------
  if (!existsSync(join(ROOT, ".next", "BUILD_ID"))) {
    console.error(
      [
        "找不到构建产物（.next/BUILD_ID）。",
        "接口测试打的是构建后运行的真实服务，所以先构建一次：",
        "",
        "  npm run build",
        "",
      ].join("\n")
    );

    process.exit(2);
  }

  const skipServer = Boolean(process.env.MOYU_BASE_URL);
  const baseUrl = process.env.MOYU_BASE_URL || BASE_URL;

  // ---------- 1. 假 AI 服务 ----------
  if (!skipServer) {
    say(`[1/4] 启动假 AI 服务（127.0.0.1:${FAKE_PORT}）`);
    start("fake-ai", NODE, [join(ROOT, "scripts", "fake-ai-server.mjs")]);
    await waitFor(`${FAKE_URL}/stats`, 15_000, "假 AI 服务");
    say("      假 AI 就绪");
  }

  // ---------- 2. 测试库 ----------
  if (!skipServer) {
    say(`[2/4] 准备测试库（prisma/test.db）`);

    const migrate = spawn(
      NODE,
      [join(ROOT, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          DATABASE_URL: TEST_DB_URL,
          PRISMA_ENGINES_MIRROR:
            process.env.PRISMA_ENGINES_MIRROR ||
            "https://registry.npmmirror.com/-/binary/prisma",
        },
      }
    );

    let migrateOut = "";

    migrate.stdout?.on("data", (c) => (migrateOut += c));
    migrate.stderr?.on("data", (c) => (migrateOut += c));

    const code = await new Promise((resolve) => migrate.on("exit", resolve));

    if (code !== 0) {
      throw new Error(`测试库迁移失败：\n${migrateOut}`);
    }

    say("      测试库已是最新结构");
  }

  // ---------- 3. 被测服务 ----------
  if (!skipServer) {
    say(`[3/4] 启动被测服务（${baseUrl}，连测试库，AI 指向假服务）`);

    start("app", NODE, [
      join(ROOT, "node_modules", "next", "dist", "bin", "next"),
      "start",
      "--port",
      String(APP_PORT),
    ], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: TEST_DB_URL,
        // 假 Key：接口测试只验证「我们的代码怎么处理上游的回应」，
        // 不验证真实服务商支不支持某个参数
        AI_API_KEY: "fake-key-for-tests",
        AI_BASE_URL: `${FAKE_URL}/v1`,
        AI_MODEL: "fake-model",
        AUTH_SECRET: "api-test-secret-must-be-at-least-32-chars-long",
        AUTH_TRUST_HOST: "true",
        // 关掉启动自检里的环境提醒噪声
        MOYU_QUIET_BOOT: "1",
      },
    });

    await waitFor(`${baseUrl}/api/health`, 60_000, "被测服务");
    say("      被测服务就绪");
  } else {
    say(`[跳过] 用已运行的服务：${baseUrl}`);
  }

  // ---------- 4. 跑测试 ----------
  say("[4/4] 运行接口测试");

  const vitest = spawn(
    NODE,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "tests/api"],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MOYU_BASE_URL: baseUrl,
        FAKE_AI_URL: FAKE_URL,
        // 测试里要直接查库（比如把用量刷满），所以这个进程也得连测试库
        DATABASE_URL: TEST_DB_URL,
      },
    }
  );

  let output = "";

  vitest.stdout.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  vitest.stderr.on("data", (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
  });

  const exitCode = await new Promise((resolve) => vitest.on("exit", resolve));

  lines.push(`--- vitest 输出（共 ${output.length} 字符）---`);

  return exitCode;
}

let code = 1;

try {
  code = await main();
} catch (error) {
  console.error(`\n运行接口测试失败：${error.message}`);
  code = 1;
} finally {
  stopAll();
  // 服务是自己起的，进程退出后再留几百毫秒让端口释放
  await new Promise((r) => setTimeout(r, 800));

  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(ROOT, "_p9"), { recursive: true });
    writeFileSync(LOG, lines.join("\n"), "utf8");
  } catch {
    // 日志写不出来不影响测试结论
  }
}

process.exit(code);
