# API 接口说明

全部接口都在 `/api` 下，请求和响应都是 JSON（登录相关除外，见第四节）。

**通用规矩**

- 除 `/api/health` 和注册/登录外，**所有接口都要登录**，靠 Cookie 里的会话
- 所有数据查询都用当前登录用户的 id 过滤，**没有"按 id 拿任意数据"的口子**
- 归属校验三态分清：**未登录 → 401、不是你的 → 403、不存在 → 404**
- 失败响应带 `code` 字段（错误编号），排查时照 [错误代码说明](错误代码说明.md) 搜日志

---

## 一、账号与登录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册。成功 201，邮箱已存在 409，格式不对 400 |
| GET/POST | `/api/auth/[...nextauth]` | Auth.js 自己处理（登录、登出、CSRF、会话查询） |
| GET | `/api/account` | 账号资料 + 数据概况（作品/章节/版本/AI 调用条数） |
| PATCH | `/api/account` | 改昵称。body `{ name }`，1–50 字 |
| POST | `/api/account/password` | 改密码。body `{ currentPassword, newPassword }` |
| DELETE | `/api/account` | 注销账号。body `{ password }`，级联删除全部数据 |

**改密码的两个行为要知道**

1. 当前密码错 → **400 + `code: INVALID_CREDENTIALS`**。
   刻意不用 401 —— 前端的 401 处理是"直接踢回登录页"，而这里只是这一次输入错了。
2. 改成功 → 服务端把 `User.tokenVersion` +1，**所有设备（包括当前这个）的登录态立刻失效**。
   响应里的 `reloginRequired: true` 就是这个意思，前端应当引导重新登录。

**注销账号**是不可逆的：作品、章节、版本历史、人物卡、风格档案、AI 用量台账
全部一起删（靠数据库的级联外键，不是手写删除顺序）。
响应里的 `deleted` 字段会告诉你删掉了多少东西，日志里也有一条
`[ACCOUNT_DELETED]`。

---

## 二、作品与章节

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/projects?limit=24&offset=0` | 我的作品列表（分页） |
| POST | `/api/projects` | 新建作品，自动带一章 + 空风格档案。成功 201 |
| GET | `/api/projects/[id]` | 作品详情 + 章节列表（**不含正文**）+ 风格档案 + 人物卡 |
| PATCH | `/api/projects/[id]/settings` | 改作品名/简介/类型 + 风格档案三字段 |
| DELETE | `/api/projects/[id]` | 删作品，级联删章节/版本/人物卡 |
| POST | `/api/projects/[id]/chapters` | 新建章节 |
| PATCH | `/api/projects/[id]/chapters` | 批量调序。body `{ orderedIds: string[] }`，顺序即最终顺序；缺参数 400，含不属于本作品的 id 会被拒 |
| GET | `/api/chapters/[id]` | 取章节全文（含 `version`） |
| PATCH | `/api/chapters/[id]` | 保存章节（**这是唯一会留版本记录的入口**） |
| DELETE | `/api/chapters/[id]` | 删章节，并把后续章节的顺序号补齐不留空档 |

**列表分页的响应结构**

```json
{ "items": [ ... ], "total": 37, "limit": 24, "offset": 0, "hasMore": true }
```

- 页大小常量在 `src/lib/pagination.ts`。
  **服务端首屏（`src/app/page.tsx`）和这个接口必须用同一个数字**，
  否则会出现「首屏 24 部，点加载更多后第 25 部被跳过」这种错位。
- `limit` 上限 100，超了返回 400（不是静默截断）。

**保存章节的请求体**

```json
{ "title": "可选", "content": "可选", "version": 3 }
```

- `version` 是**客户端看到的那一版的版本号**（乐观锁，见第五节）
- 不传 `version` → 跳过冲突检查（兼容脚本和老客户端）
- 保存成功 → `version` +1，并新增一条 `Revision`
- 正文长度卡两次：zod 卡 100000 字符，再按去空白字数校验；
  超了返回 400

---

## 三、版本历史

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/projects/[id]/revisions?chapterId=xxx&limit=10&offset=0` | **列表只回摘要**：`id / changeReason / createdAt / chars` |
| GET | `/api/projects/[id]/revisions/[revisionId]` | 取某一条的**全文** |
| POST | `/api/projects/[id]/revisions/[revisionId]/restore` | 恢复这一版 |

**为什么要分成两个接口**

一章 3 万字、列 30 条的话，带上正文就是 90 万字的响应，手机上直接卡住。
所以列表只回摘要，用户点开哪一条才取哪一条的全文。
列表查询**不读 `content` 列** —— 字数已经存在 `Revision.chars` 里了。

**恢复版本的三个要点**

1. 会**整段替换**当前正文，所以前端必须先让用户确认（提示里要带上版本时间）
2. 恢复本身也会新增一条版本记录（`changeReason: "从历史版本恢复"`），
   当前正文不会丢，还能再退回去
3. 回滚也会把 `Chapter.version` +1 —— 否则另一个标签页能拿旧版本号把回滚覆盖掉

---

## 四、AI

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/ai/edit` | body `{ projectId, chapterId, content, mode }`，`mode` 是 `diagnose` 或 `polish` |
| GET | `/api/ai/usage` | 今日额度 `{ used, limit, remaining, resetAt }` |

**入参里没有 `projectContext`** —— 风格档案由服务端按 `projectId` 自己查库。
客户端传的东西是可以伪造的，AI 的上下文不能信任客户端。

`/api/ai/edit` 的失败分支：

| 状态 | `code` | 什么情况 |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | 参数格式不对 / mode 乱传 |
| 400 | `PAYLOAD_TOO_LARGE` | 正文超长 |
| 401 | `AUTH_FAILED` | 未登录 / 会话失效 |
| 403 | `PROJECT_ACCESS_DENIED` | 章节不是你的 |
| 404 | — | 章节不存在，或章节不属于这个作品 |
| 429 | `RATE_LIMITED` | 一分钟内第 11 次，带 `retryAfter` |
| 429 | `DAILY_QUOTA_EXCEEDED` | 今日额度用满（默认 30 次），带 `used` / `limit` |
| 502 | `AI_PROVIDER_ERROR` 等 | 上游报错、返回空、返回的不是 JSON |
| 503 | `AI_NOT_CONFIGURED` | 服务端没配 Key 或模型名 |

**两种 429 必须分清楚**：一个是「等几十秒」，一个是「等明天 0 点」。
前端就是靠 `code` 区分的（`editor-client.tsx` 里的 `DAILY_QUOTA_EXCEEDED` 分支）。

成功响应里带 `usage: { used, limit, remaining }` 和 `durationMs`，
前端直接用它刷新额度显示，不必再打一次 `/api/ai/usage`。

**用量记账的两条硬规矩**

- 记账失败**不抛异常**，只写一条 warn 日志 —— 已经生成好的润色稿必须交给用户
- **失败的调用不记账** —— 上游挂了不该扣用户次数

---

## 五、并发保存（乐观锁）

同一个章节在两个标签页里都打开了，哪边先保存，另一边就会拿着过期内容再覆盖一次。
`Chapter.version` 就是挡这个的：

```
客户端保存时带上 version
   ↓ 和库里一致    → 正常写入，version +1
   ↓ 对不上        → 409 + code: VERSION_CONFLICT，响应回当前版本号
                     服务端内容一个字都不动
```

前端拿到 409 之后**不许自动重试**（写不进去，只会刷屏），要做的是：

1. 暂停自动保存（`conflict` 状态）
2. 把提示挂出来，并明确告诉用户「你打的字还在，没丢」
3. **禁止切章** —— 切过去会把冲突的一边冲掉，那正是还没保存的正文
4. 给两条出路：「刷新取最新版」/「用我的内容覆盖」
   （后者会先拉最新版本号再写，对方那一版仍留在版本历史里，可回滚）

---

## 六、健康检查

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | **唯一免登录接口**，给拨测和部署用 |

- 全部正常 → **200**
- 数据库不通 / 有 fatal 级环境问题 → **503**
- 响应里只有「哪个变量名有问题、什么性质」，没有值、没有连接串、没有堆栈
- 带 `Cache-Control: no-store`，不会被缓存

---

## 七、自己写脚本调接口时

脚本登录两步走（少了 CSRF 那步会被当成伪造请求）：

```bash
# 1. 拿 CSRF token（同时会把 CSRF Cookie 存下来）
curl -c jar.txt -s http://127.0.0.1:3001/api/auth/csrf

# 2. 带 token 和 Cookie 去登录
curl -b jar.txt -c jar.txt -s -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Auth-Return-Redirect: 1" \
  --data "csrfToken=上一步的token&email=你的邮箱&password=你的密码&callbackUrl=http://127.0.0.1:3001/" \
  http://127.0.0.1:3001/api/auth/callback/credentials

# 3. 确认登上去了（别只看状态码）
curl -b jar.txt -s http://127.0.0.1:3001/api/auth/session
```

`tests/api/helpers.ts` 里的 `HttpClient` 就是把这三步封起来了，
写脚本时可以直接参考那份实现。
