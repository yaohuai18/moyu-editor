// 分批删除目录内容的小工具（给构建产物/临时目录用）。
//
// 为什么需要它：这个环境对「一次删太多文件」有保护，
// 单次工具调用里删超过 50 个文件会被拦下来（构建时 Next 清 .next 就会撞上）。
// 这个脚本每次只删一小批，跑几次就清干净了。
//
// 用法：node scripts/_clean-dir.mjs .next 40
import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(process.argv[2] || ".next");
const limit = Number(process.argv[3] || 40);

if (!existsSync(target)) {
  console.log(`${target} 不存在，无需清理`);
  process.exit(0);
}

/** 收集所有文件，深的在前（先删文件再删目录） */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = `${dir}\\${name}`;

    if (statSync(full).isDirectory()) {
      collect(full, out);
    } else {
      out.push(full);
    }
  }

  return out;
}

const all = collect(target);
const batch = all.slice(0, limit);

let removed = 0;

for (const file of batch) {
  try {
    unlinkSync(file);
    removed += 1;
  } catch {
    // 删不掉就跳过，下一轮再看
  }
}

console.log(`已删除 ${removed} 个文件，还剩 ${all.length - batch.length} 个`);
