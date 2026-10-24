/**
 * 给 scripts/ 下的自检脚本用的小工具：把 .env 系列文件读进来。
 *
 * 为什么不用 dotenv：项目里没装它，而这里的规则就几十行。
 * 更重要的是要**跟 Next.js 的加载顺序完全一致**，否则自检结论会跟
 * 真实运行时对不上 —— 这个坑第七阶段踩过一次（.env.production.local
 * 的优先级比 .env 高，把主服务的 Key 悄悄换掉了）。
 *
 * Next.js 的优先级（高 → 低）：
 *   进程环境变量 > .env.production.local > .env.local > .env.production > .env
 */

import fs from "node:fs";
import path from "node:path";

/** 从最不具体到最具体，后面的文件覆盖前面的 */
const ENV_FILES = [
  ".env",
  ".env.production",
  ".env.local",
  ".env.production.local",
] as const;

/** 解析一个 .env 文件，返回键值对。文件不存在就返回空对象。 */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const result: Record<string, string> = {};

  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    // 去掉成对的引号，和 dotenv 的行为保持一致
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * 组装出「真正生效的环境变量」。
 *
 * 返回的既有值，也有每个变量是从哪儿来的（方便自检报告里指出
 * 「你改了 .env 但 .env.local 把它盖住了」）。
 */
export function loadEffectiveEnv(root: string) {
  const merged: Record<string, string> = {};
  const origin: Record<string, string> = {};
  const found: string[] = [];

  for (const file of ENV_FILES) {
    const full = path.join(root, file);
    const parsed = parseEnvFile(full);

    if (Object.keys(parsed).length > 0) {
      found.push(file);
    }

    for (const [key, value] of Object.entries(parsed)) {
      merged[key] = value;
      origin[key] = file;
    }
  }

  // 进程环境变量优先级最高：命令行里写的 KEY=xxx 会盖掉文件里的
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value !== "") {
      merged[key] = value;
      origin[key] = "进程环境变量";
    }
  }

  return { env: merged, origin, files: found };
}

/**
 * DATABASE_URL 指向的 SQLite 文件在磁盘上的真实路径。
 *
 * 注意：Prisma 里 `file:./dev.db` 是**相对 schema.prisma 所在目录**（prisma/）
 * 解析的，不是相对项目根 —— 自己按根目录拼会找不到文件。
 */
export function resolveSqlitePath(root: string, databaseUrl: string) {
  const raw = databaseUrl.replace(/^file:/, "").split("?")[0];

  if (path.isAbsolute(raw)) {
    return raw;
  }

  return path.resolve(root, "prisma", raw);
}
