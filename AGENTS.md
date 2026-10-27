<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# moyu-editor 项目规则

> 上面 `BEGIN:nextjs-agent-rules` 区块由 `next dev` 自动写入，不要手改。`next dev` 只替换标记块本身，本节内容在区块之外，不会被清掉。
>
> **本文件是本项目的唯一项目规则真源。** 全局 `C:\Users\牛\.dsh\AGENTS.md` 第四节只保留一行索引。
>
> 最后核验：**2026-10-27**。带 ★ 的条目属于易过期事实，使用前按下文「十、易过期事实与复核方式」实测，不得直接当现状。

## 一、定位与路径

- 面向中文网文作者的 AI 辅助编辑器。定位：开源 + 免费核心 + 付费高级。
- 路径：`C:\Users\牛\WorkBuddy\2026-09-24-20-12-07\moyu-editor`。
- **路径带日期但不是临时目录，别删别移。**
- 项目在 workspace 之外（workspace 是 `C:\Users\牛\Documents\deepseek-harness\default-workspace`），这决定了沙箱权限行为，见「七、已知坑」。

## 二、技术栈 ★（2026-10-27 核对 `package.json`）

Next.js 16.3.6 · React 19.2.8 · Prisma 6.19 · SQLite · bcryptjs · next-auth v5 beta · zod 4 · Tailwind 4 · Vitest 5。包管理器 npm，Node.js v22.22.2。

## 三、启动 / 构建 / 测试

本机 PowerShell 禁用 `npm.ps1`，所有 npm 命令必须走完整路径 `C:\Program Files\nodejs\npm.cmd`（下文简写 `npm.cmd`）。

| 目的 | 命令 | 说明 |
|---|---|---|
| 一键验证（静态档） | `.\verify.cmd` | 类型检查 + 单元测试，约 30-60 秒 |
| 一键验证（全量档） | `verify.cmd -Full` | 另加 `next build` + 接口测试 |
| 开发启动（端口 3001） | `npm.cmd run app` | = `next build && next start --port 3001`，**含构建** |
| 只起服务 | `npm.cmd run serve` | = `next start --port 3001`，**只用已有构建** |
| 类型检查 | `npm.cmd run typecheck` | `tsc --noEmit` |
| 单元测试 | `npm.cmd run test` | `vitest run tests/unit` |
| 接口测试 | 先 `npm.cmd run build`，再 `npm.cmd run test:api` | **必须先 build** |

- 服务地址：`http://localhost:3001`。也可双击 `start-moyu.bat`。
- **`app` 和 `serve` 的区别是「要不要现场构建」，不是「哪个正确」**：当前会话有写权限（danger-full-access 或普通窗口）用 `app`；只有 workspace 写权限、`next build` 会 `EPERM .next\trace-build` 时用 `serve` 打已有构建。
- `next dev` 在本机不可用（历史结论，具体原因未记录）。要开发就 `npm run app` 或改完代码手动 `build` 再 `serve`。

## 四、验收标准

提交 / 上线前必须同时满足：

1. `verify.cmd -Full` 退出码为 0；
2. 单元测试与接口测试数量不低于基线；数量变少必须先解释清楚；
3. 新增或修改接口时，在 `tests/api` 补接口级用例，并把变更写进 `README.md` 的接口说明。

> **纠错（2026-10-27 核实）**：本项目**没有** `API_CONTRACT.md` 与 `API_INVENTORY.md`，这两个文件名属于 NovelCraft。本节此前要求「同步更新这两个文档」是错误约定，已作废，不要再去找它们。

**当前测试基线** ★：

| 档 | 数量 | 核验时间 | 复核方式 |
|---|---|---|---|
| unit | **91 / 91 passed**（8 文件） | 2026-10-27 15:54 实测 | `npm.cmd run test` |
| api | **83 / 83** | 2026-10-24 记录，**本会话未复测** | `npm.cmd run build` 后 `npm.cmd run test:api` |

> 注：本项目 AGENTS.md 早前写的是 `unit 88、api 81`，已过期，现按实测改为 91 / 83。

## 五、禁止改动

- `node_modules/`、`.next/`、`_p9/`、`_p10/`、`_p11/`、`backups/`、`ops-reports/`：生成物或历史验收产物。
- `.env*`、`prisma/*.db*`：含真实数据与密钥，不进 Git、不删不改。
- 演示账号 `demo@moyu.local` 只在上线前统一处理，平时不要动。

## 六、仓库与推送

**双公开仓库，GitHub 那份是求职门面，优先维护它。** 两个仓库均已匿名访问 200（★ 2026-10-27 实测，复核方式：`curl -I` 目标 URL 看状态码）。

| 远端 | 地址 | 协议 | 备注 |
|---|---|---|---|
| `origin` | `git@github.com:yaohuai18/moyu-editor.git` | SSH | 2026-10-27 核实时是 SSH，不是 HTTPS |
| `gitee` | `https://gitee.com/huaiyao/moyu-editor.git` | HTTPS | 同名仓库 |

网页地址（对外就是这两个）：

- GitHub：https://github.com/yaohuai18/moyu-editor —— **求职门面，优先维护**
- Gitee：https://gitee.com/huaiyao/moyu-editor

- 推送用个人访问令牌 / SSH 密钥，**令牌与私钥不入库**；`.git/config` 已清理干净，不要往 remote URL 里塞令牌。
- 如果某次改用 HTTPS 推 GitHub，本机 schannel 会报 `AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)`，加 `-c http.sslBackend=openssl` 可过。**这是条件性措施，SSH 通道正常时不需要。**（★ 该坑记录于 HTTPS 时代，2026-10-27 remote 已改 SSH，未复测。）

**Gitee 的两个坑（已踩过，别再踩）：**

1. 未绑第三方账号 / 未开 2FA 的账号，用 API 建仓库会被**强制私有**；`PATCH private=false` 报 422「帐号安全评级较低」。绑微信/QQ 后即解除，**不需要实名认证**。
2. `PATCH /api/v5/repos/{owner}/{repo}` **必须带 `name` 参数**，否则报 400 `{"messages":["name is missing"]}`。

仓库公开性不要靠「页面上看着像公开」判断：匿名访问仓库主页返回 200 才算真公开。Gitee 的 `/tree/main` 匿名访问会触发安全验证码，那是反爬，不是私有。

## 七、已知坑

- PowerShell 执行策略禁止直接跑 `.ps1`，必须经 `verify.cmd` 包一层 `-ExecutionPolicy Bypass`。
- 含中文的 `.ps1` 必须存成 **UTF-8 带 BOM**，否则 Windows PowerShell 5.1 按 ANSI 读会报语法错。
- dsh 沙箱内子进程管道被封（`spawn EPERM`）：`next build`、`test:api`、vitest 默认 forks 池都会中招。`verify.ps1` 已改用 threads 池，并对构建 / 接口测试自动标 SKIP；**真实打包必须在 dsh 外的普通窗口跑**。
- **项目在 workspace 外**：只有 workspace 写权限的会话里，`next build` 会 `EPERM ... .next\trace-build`，只能 `serve`。
- `scripts/api-test.mjs` 自带测试库（`test.db`）、假 AI（11499）、网站在 3002，不碰开发库；跑之前必须先 `npm run build`。
- `verify.log` 是生成物，已在 `.gitignore` 中忽略，不要提交。

## 八、上线前必办的三个雷

没拆之前不许对外宣称「可以上线」：

1. **作废已泄露的 DeepSeek AI Key**；
2. **更换 `AUTH_SECRET`**；
3. **处理演示账号 `demo@moyu.local`**。

## 九、已知技术债（未修，改到这里时一并考虑）

- `saveNow` 没有 in-flight 去重 → 并发保存会出现假 409；
- 导出文件名未处理 Windows 保留名（`CON` / `PRN` / `COM1` 等）；
- 导出未处理孤立 `\r`；
- 调序接口零测试覆盖。

**已修但设计决策要保留（别改回去）**——2026-10-27 commit `a90098e`：

- 导出文件名必须**按 Unicode 码点切**，不能按 UTF-16 码元切。按码元截断会让 emoji 卡在截断边界留半个代理项，`encodeURIComponent` 抛 `URIError`，导出接口直接 500（曾用长度：书名 60 / 单章书名 20 / 章名 40，均按码元；现改为码点切 + 编码兜底退 ASCII）。
- 导出菜单**不要用 `window.location.assign`**，要 fetch + blob，否则导出 500 时整个编辑页被导航走。
- 切章前**必须先检查保存结果**，否则保存失败照样切章，正文丢失。

## 十、易过期事实与复核方式

下面这些别当永久结论，用之前先实测：

| 事实 | 当前值（核验日期） | 复核方式 |
|---|---|---|
| 测试数量 | unit 91 / api 83（2026-10-27 / 2026-10-24） | `npm.cmd run test`；api 需先 build |
| 最新提交 | `a90098e`（2026-10-27，main，工作树干净） | `git log -1 --oneline`、`git status` |
| 版本号 | `1.0.0-rc.2` | `package.json` |
| 仓库公开 | 两者匿名 200（2026-10-27） | `curl -I` |
| 远端协议 | origin=SSH、gitee=HTTPS（2026-10-27） | `git remote -v` |
| 网络可达 | 2026-10-26 曾 github/api/codeload/gitee 全通 | HEAD 请求目标域名 |

超过 30 天未复核的记录，不得作为当前状态引用。
