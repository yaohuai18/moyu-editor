# moyu-editor

## 定位
- 类型：**求职门面项目**。面向中文网文作者的 AI 辅助编辑器
- 目标：开源 + 免费核心 + 付费高级；对外能拿出一个真实可跑、有测试、有公开仓库的产品
- 主要使用者：中文网文作者（终端用户）；老板本人（产品方向）；AI 助手（开发与验证执行方）
- 当前状态：活跃。版本 `1.0.0-rc.2`。本地 main 领先双远端 5 个提交（截至 2026-11-13 未推送），工作树除 PROJECT.md（未跟踪）外干净；GitHub 与 Gitee 双公开仓库均可匿名访问

## 范围
- 主要功能：账号与作品管理、章节编辑与调序、导出、AI 辅助生成、保存与版本相关能力；配套 Prisma 数据层与运维脚本（备份、恢复演练、日报、发布）
- 不负责什么：
  - 不做 AI 模型训练与推理部署，AI 能力依赖外部 API
  - 不是长篇创作平台（那是 NovelCraft 的范围）
  - **本项目没有 `API_CONTRACT.md` / `API_INVENTORY.md`**——这两个文件属 NovelCraft，不要来这儿找

## 结构
- 项目根目录：`C:\Users\牛\WorkBuddy\2026-09-24-20-12-07\moyu-editor`
  - **路径带日期但不是临时目录，别删别移**
  - 项目在 DSH workspace 之外，这直接决定沙箱写入权限行为
- 入口：Next.js 应用，服务地址 `http://localhost:3001`
- 核心目录：`src/`、`prisma/`（schema 与迁移）、`tests/unit`、`tests/api`、`scripts/`、`docs/`
- 现有文档：`README.md`（含接口说明）、`AGENTS.md`（执行规则真源）、`CLAUDE.md`

## 技术与运行
- 主要技术：Next.js 16.4.6 · React 19.2.8 · Prisma 6.19 + SQLite · next-auth v5 beta · zod 4.6.7 · Tailwind 4 · Vitest 5 · bcryptjs。包管理器 npm
- 启动方式：`npm.cmd run app`（= 构建 + 起服务，端口 3001）或 `npm.cmd run serve`（只用已有构建）；也可双击 `start-moyu.bat`。
  - **`app` 与 `serve` 的区别是「要不要现场构建」，不是「哪个正确」**：有写权限用 `app`；只有 workspace 写权限、`next build` 会 `EPERM .next\trace-build` 时用 `serve`
  - `next dev` 在本机不可用
- 验证方式：`.\verify.cmd`（类型检查 + 单元测试，约 30-60 秒）/ `verify.cmd -Full`（另加 `next build` + 接口测试）
  - 当前测试基线：unit **94 / 94 passed**（8 文件）；api **87 / 87**（6 文件）——2026-11-13 实测，`verify.cmd -Full` 全绿
- 外部依赖：npm 生态；AI 能力需外部 Key（在 `.env`，**不读**）
- 本地模型或 MCP：无

## 风险与边界
- 可自动执行：只读浏览源码与测试、读 `README.md`/`AGENTS.md`、跑类型检查与单元测试、`git status`/`git log`、生成补丁建议
- 必须人工确认：改源码、装或升级依赖、跑 `next build`、改 Prisma schema 或迁移、起服务占端口
- 禁止自动执行：读 `.env*` 与 `prisma/*.db*`；动 `node_modules/`、`.next/`、`_p9/`、`_p10/`、`_p11/`、`backups/`、`ops-reports/`；`git push`；改 remote；改 `AUTH_SECRET`；动演示账号 `demo@moyu.local`；把令牌或私钥写进 remote URL
- 敏感信息规则：**`.env*` 可能存在敏感配置（含 DeepSeek AI Key 与 `AUTH_SECRET`），禁止 AI 自动读取**；`AGENTS.md` 第八节记了上线前必拆的三个雷——作废已泄露的 DeepSeek AI Key、更换 `AUTH_SECRET`、处理演示账号 `demo@moyu.local`，**没拆之前不许对外宣称「可以上线」**
- **默认只允许在测试分支、测试目录或明确批准后写入**：本目录属正式项目区，任何改动先复制副本或在批准的分支/目录上动

## 当前状态
- 已确认：双远端（`origin` = SSH `git@github.com:yaohuai18/moyu-editor.git`，`gitee` = HTTPS）；两个网页均匿名 200（2026-10-27 复核）；GitHub 那份是求职门面，优先维护。**origin 的 SSH 通道 2026-11-13 实测不通**（connection refused），HTTPS 匿名 ls-remote 正常；推送前需修复 SSH 或走 HTTPS 一次性推送
- 待确认：生产部署形态未记录；`.env` 里 Key/AUTH_SECRET 是否已轮换（红线内无法核验，由老板处理）
- 已知问题：`AGENTS.md` 第九节技术债——`saveNow` in-flight 去重**已修**（2026-11-13）；导出文件名未处理 Windows 保留名（`CON`/`PRN`/`COM1`）；导出未处理孤立 `\r`；调序接口零测试覆盖；Prisma 6→7 升级待办（npm audit 剩余 high 在 prisma CLI 依赖链）；演示密码明文永久留在公开仓库历史（历史不可改，按已泄露处理）
- 下一步：推送本地 5 个提交（先解决 SSH 通路，需老板批准）；三个上线前雷待拆（DeepSeek Key 作废换新、AUTH_SECRET 更换、演示账号改密，均需老板操作）；清理约 1.34 GiB 生成物（需批准）；`AGENTS.md` 状态字段同步

## 维护
- 创建日期：2026-10-30
- 信息来源：`AGENTS.md`（全文）、`package.json`、`README.md`（仅文档存在性，未通读 52KB 正文）、目录结构
- 最后核对日期：2026-11-13
