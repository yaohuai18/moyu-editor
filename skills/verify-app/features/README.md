# 功能路径索引

按改动位置选要跑哪几条。**每条都标了实测状态**——「未实测」的步骤是照着源码写的，第一次跑要当心，跑完把结果补回去。

| 文件 | 验什么 | 实测状态 | 什么时候必须跑 |
|---|---|---|---|
| [01-auth.md](01-auth.md) | 注册 / 登录 / 注销 | ✅ 登录、注销已实测；注册走 API 已实测，走界面**未实测** | 动过 `src/app/login`、`register`、`src/auth.ts`、`api/account` |
| [02-home.md](02-home.md) | 首页列表 + 建作品 | ✅ 已实测 | 动过 `home-client.tsx`、`api/projects` |
| [03-chapter-autosave.md](03-chapter-autosave.md) | 正文打字 → 自动保存 → 落库 | ✅ 已实测（含 409 章节**未实测**） | **几乎每次都要跑**；动过 `editor-client.tsx` 必跑 |
| [04-version-history.md](04-version-history.md) | 版本历史列表 / 预览 / 恢复 | ⚠️ 列表已实测（1/1 条），预览与恢复**未实测** | 动过 `api/projects/[id]/revisions`、`api/chapters/[id]` 的版本写入 |
| [05-export.md](05-export.md) | 导出（单章 / 整本） | ✅ 已实测（接口 4 条全通、界面不跳走、500 不跳走）；emoji ✅ 已修、`CON` ⚠️ 口径订正（本机可建，风险在跨平台与下载器）、孤立 `\r` ❌ 仍坏 | 动过 `api/chapters/[id]/export`、`api/projects/[id]/export`、`src/lib/export.ts`、导出菜单 |
| [06-chapter-switch.md](06-chapter-switch.md) | 切章前保存保护 | ✅ 已实测（正常切章 + 保护 A 409 + 保护 B 保存失败，三条文案与源码一致） | 动过章节切换逻辑 |
| [07-ai.md](07-ai.md) | 文本诊断 / 轻度润色 / 用量台账 | ❌ **未实测**（需假 AI 服务） | 动过 `api/ai/*`、`ai-limits`、`ai-usage` |

---

## 怎么判断「该跑哪条」

| 你改了什么 | 最少要跑 |
|---|---|
| `src/lib/*.ts` 纯函数（字数、导出文件名切分、提示词拼装） | L1：tsc + vitest（对应单测应已覆盖） |
| 任何 `src/app/api/**/route.ts` | L1 + L2（`verify.cmd -Full` 的接口测试）+ 对应功能的 L3 |
| 任何 `src/app/**/*-client.tsx`（界面） | L1 + 对应功能的 L3 + L4 查库 |
| `prisma/schema.prisma` | L1 + `npx prisma migrate dev` + **全量 L3**（数据结构变了，所有路径都可能受影响） |
| 只改了文案 / 样式 | L3 至少要打开那个页面看没白屏 |

---

## 三条容易漏的

1. **导出文件名**：`AGENTS.md` 的技术债里写着「无 Windows 保留名黑名单」和「未处理孤立 `\r`」。其中 `CON` 已 **2026-11-23 复核订正**：本机文件系统能建 `CON.txt`（实测 7 字节、可回读），风险在跨平台与浏览器下载器，**别再把「Windows 不允许」当结论引用**。改这块时**一定要拿 `CON` 和孤立 `\r` 两个输入真试一次**，别只跑单测。
2. **切章保护**：`AGENTS.md` 明确记着「切章前必须先检查保存结果，否则保存失败照样切章，正文丢失」——这是个已修复的历史事故。任何碰切章逻辑的改动都要重验这条。
3. **`window.location.assign`**：`AGENTS.md` 记着「导出菜单不要用它，要 fetch + blob，否则导出 500 时整个编辑页被导航走」。验导出时要观察**页面 URL 有没有变**，变了就是回归了。
