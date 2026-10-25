<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# moyu-editor 项目规则

> 上面 `BEGIN:nextjs-agent-rules` 区块由 `next dev` 自动写入，不要手改。`next dev` 只替换标记块本身，本节内容在区块之外，不会被清掉。

## 启动 / 构建 / 测试

本机 PowerShell 禁用 `npm.ps1`，所有 npm 命令必须用完整路径 `C:\Program Files\nodejs\npm.cmd`。

| 目的 | 命令 |
|---|---|
| 一键验证（静态档：类型检查 + 单元测试，约 30-60 秒） | 双击 `verify.cmd`，或命令行 `.\verify.cmd` |
| 一键验证（全量档：另加 next build + 接口测试） | `verify.cmd -Full` |
| 开发启动（端口 3001） | `npm.cmd run app` |
| 只起服务（已构建过） | `npm.cmd run serve` |
| 类型检查 | `npm.cmd run typecheck` |
| 单元测试 | `npm.cmd run test` |
| 接口测试（**必须先 build**） | `npm.cmd run build` 然后 `npm.cmd run test:api` |

`next dev` 在本机不可用，开发一律 `npm run app`。

## 验收标准

提交 / 上线前必须同时满足：

1. `verify.cmd -Full` 退出码为 0；
2. 单元测试与接口测试数量不低于基线（unit 88、api 81），数量变少必须先解释清楚；
3. 新增或修改接口时，同步更新 `API_CONTRACT.md` 与 `API_INVENTORY.md`。

## 禁止改动

- `node_modules/`、`.next/`、`_p9/`、`_p10/`、`_p11/`、`backups/`、`ops-reports/`：生成物或历史验收产物。
- `.env*`、`prisma/*.db*`：含真实数据与密钥，不进 Git、不删不改。
- 演示账号 `demo@moyu.local` 只在上线前统一处理，平时不要动。

## 已知坑

- PowerShell 执行策略禁止直接跑 `.ps1`，必须经 `verify.cmd` 包一层 `-ExecutionPolicy Bypass`。
- 含中文的 `.ps1` 必须存成 **UTF-8 带 BOM**，否则 Windows PowerShell 5.1 按 ANSI 读会报语法错。
- dsh 沙箱内子进程管道被封（`spawn EPERM`）：`next build`、`test:api`、vitest 默认 forks 池都会中招。`verify.ps1` 已改用 threads 池，并对构建 / 接口测试自动标 SKIP；**真实打包必须在 dsh 外的普通窗口跑**。
- `scripts/api-test.mjs` 自带测试库（`test.db`）、假 AI（11499）、网站在 3002，不碰开发库；跑之前必须先 `npm run build`。
- `verify.log` 是生成物，已在 `.gitignore` 中忽略，不要提交。
