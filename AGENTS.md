<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# moyu-editor 项目规则

> 上面 `BEGIN:nextjs-agent-rules` 区块由 `next dev` 自动写入，不要手改。

## 一、定位

面向中文网文作者的 AI 辅助编辑器。定位：开源 + 免费核心 + 付费高级。

## 二、技术栈

Next.js 16.4.6 · React 19.2.8 · Prisma 6.19 · SQLite · bcryptjs · next-auth v5 beta · zod 4.6.7 · Tailwind 4 · Vitest 5。包管理器 npm，Node.js ≥ 24。

## 三、启动 / 构建 / 测试

Windows PowerShell 禁用 `npm.ps1`，npm 命令请走完整路径 `C:\Program Files\nodejs\npm.cmd`（下文简写 `npm.cmd`）。

| 目的 | 命令 | 说明 |
|---|---|---|
| 一键验证（静态档） | `.\verify.cmd` | 类型检查 + 单元测试，约 30-60 秒 |
| 一键验证（全量档） | `verify.cmd -Full` | 另加 `next build` + 接口测试 |
| 开发启动（端口 3001） | `npm.cmd run app` | = `next build && next start --port 3001`，**含构建** |
| 只起服务 | `npm.cmd run serve` | = `next start --port 3001`，**只用已有构建** |
| 类型检查 | `npm.cmd run typecheck` | `tsc --noEmit` |
| 单元测试 | `npm.cmd run test` | `vitest run tests/unit` |
| 接口测试 | 先 `npm.cmd run build`，再 `npm.cmd run test:api` | **必须先 build** |

- 服务地址：`http://localhost:3001`。

## 四、验收标准

提交 / 上线前必须同时满足：

1. `verify.cmd -Full` 退出码为 0；
2. 单元测试与接口测试数量不低于基线；数量变少必须先解释清楚；
3. 新增或修改接口时，在 `tests/api` 补接口级用例，并把变更写进 `README.md` 的接口说明。

**当前测试基线**：unit 96 / api 87（`npm.cmd run test` 与 build 后 `npm.cmd run test:api` 实测）。

## 五、禁止改动

- `node_modules/`、`.next/`、`backups/`、`ops-reports/`：生成物或历史验收产物。
- `.env*`、`prisma/*.db*`：含真实数据与密钥，不进 Git、不删不改。

## 六、仓库与推送

| 远端 | 地址 | 备注 |
|---|---|---|
| GitHub | https://github.com/yaohuai18/moyu-editor | 主仓库 |
| Gitee | https://gitee.com/huaiyao/moyu-editor | 国内镜像 |

- 推送用个人访问令牌 / SSH 密钥，令牌与私钥不入库。
- HTTPS 推 GitHub 时如遇 schannel 报错（`AcquireCredentialsHandle failed`），加 `-c http.sslBackend=openssl` 可过。

## 七、已知坑

- PowerShell 执行策略禁止直接跑 `.ps1`，必须经 `verify.cmd` 包一层 `-ExecutionPolicy Bypass`。
- 含中文的 `.ps1` 必须存成 **UTF-8 带 BOM**，否则 Windows PowerShell 5.1 按 ANSI 读会报语法错。
- `scripts/api-test.mjs` 自带测试库（`test.db`）、假 AI（11499）、网站在 3002，不碰开发库；跑之前必须先 `npm run build`。
- `verify.log` 是生成物，已在 `.gitignore` 中忽略，不要提交。

## 八、已知技术债

- 导出文件名未处理 Windows 保留名（`CON` / `PRN` / `COM1` 等）；
- 导出未处理孤立 `\r`；
- 调序接口零测试覆盖；
- npm audit 剩余 3 high / 9 moderate 全在开发工具链（prisma CLI 依赖链的 deepmerge-ts、vitest/mocker、minimatch），修复需 Prisma 6→7 大版本升级，待定。

**已修但设计决策要保留（别改回去）**：

- 导出文件名必须**按 Unicode 码点切**，不能按 UTF-16 码元切。按码元截断会让 emoji 卡在截断边界留半个代理项，`encodeURIComponent` 抛 `URIError`，导出接口直接 500。
- 导出菜单**不要用 `window.location.assign`**，要 fetch + blob，否则导出 500 时整个编辑页被导航走。
- 切章前**必须先检查保存结果**，否则保存失败照样切章，正文丢失。
