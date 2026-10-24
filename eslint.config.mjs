import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 构建产物的临时目录（换构建输出目录时会留 .next-old / .next-trash-* 之类）。
    // 不忽略的话，里面成百上千个打包产物会把 lint 结果淹掉 ——
    // 第九阶段实测：漏了这条，一次 lint 报出 1.1 万个问题。
    ".next*/**",
    // 验收/演练脚本的产物与日志（含数据库文件），不是源码
    "_p*/**",
    "backups/**",
  ]),
]);

export default eslintConfig;
