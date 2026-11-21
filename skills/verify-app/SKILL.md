---
name: verify-moyu
description: "moyu-editor 的项目验证技能。在独立端口 3003 起真实实例，按 features/ 功能地图用真实用户路径（浏览器 + REST）驱动应用，并用数据库取证证明行为。适用场景：任何代码改动后的验收；任何「改好了」声明需要可复现证据时；怀疑「界面看着对、底下坏着」时。界面：Web UI + REST API。"
---

# moyu-editor 验证技能（verify-moyu）

> 适用范围：`moyu-editor` 仓库任何代码改动之后的验收。
> 建立日期：2026-11-21。所有选择器、命令、断言均在当日**实测通过**，不是推测。
> 这份文件的唯一目的：把「改好了」从一句口头声明，变成一串别人能重跑的证据。

---

## 一、这份东西治什么病

验收时不看代码、只看界面。所以真正的风险不是「代码写错了」，而是：

1. Agent 说「改好了」，其实没跑起来；
2. 跑起来了，界面上看着也对，其实数据没写进库；
3. 写进库了，但改的是别的地方（A 功能修好、B 功能坏了）；
4. 全都对，但 Agent 报告里没留下**任何**能被复现的东西，下次出问题只能从头查。

这个项目**已经**有很扎实的自动化验证（`verify.cmd`：tsc + 96 个单元测试 + build + 87 个接口测试）。它覆盖了 1 和 3 的一半。**它完全没有覆盖的是第 2 条**——接口测试打的是 HTTP，不打浏览器，所以「页面上的按钮真的把字存进去了吗」从来没人验过。

这份技能补的就是这一层，并且强制留下证据。

---

## 二、三个铁律

**铁律一：界面说「已保存」不算证据，数据库里有那一行才算。**
所有 UI 路径验证，最后都必须落到一次 `scripts/probe-db.cjs` 的查询输出上。没有库输出 = 没验证。

**铁律二：验证前先确认 `.next` 比 `.src` 新。**
`next start` 跑的是**上次构建的产物**。改了代码不重新 build 就验证，验的是旧代码，会得出「全都对」的假结论。检查命令见第三节第 2 步。这一步跳过的验证结果**一律作废**。

**铁律三：用完的测试账号必须自己删掉。**
本技能用临时账号（`verify+<时间戳>@moyu.local`）走完整流程，结束时调 `DELETE /api/account` 注销。账号一删，作品、章节、版本历史、AI 台账全部级联删除，库里不留垃圾。**不允许**往 `demo@moyu.local` 或你自己的真实账号里塞测试数据。

---

## 三、前置检查（30 秒，每次都要做）

### 1. 起服务（独立端口 3003，不占用开发用的 3001）

在 DSH 沙箱里**可以**跑（实测通过，因为它不 spawn 子进程）：

```powershell
cd <项目根目录>
& 'C:\Program Files\nodejs\node.exe' '.\node_modules\next\dist\bin\next' start -p 3003
```

用后台 job 起（`run_in_background: true`）。**不要用 `npm.cmd run serve`**——它 spawn 子进程，沙箱会拦（`spawn EPERM`）。

### 2. 确认构建产物是新的（铁律二）

```powershell
$p = (Get-Location).Path   # 在项目根目录下执行
$build = (Get-Item (Join-Path $p '.next\BUILD_ID')).LastWriteTime
$newestSrc = Get-ChildItem (Join-Path $p 'src') -Recurse -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
"BUILD_ID 时间 : $build"
"src 最新改动  : $($newestSrc.LastWriteTime)  $($newestSrc.Name)"
if ($newestSrc.LastWriteTime -gt $build) { "!! 构建过期，必须重新 build，本次验证作废" } else { "OK 构建是新的" }
```

构建过期时的处理：
- 能在 dsh 外操作 → 直接双击 `verify.cmd -Full`（它含 `next build`）；
- 只能在 dsh 内 → `node .\node_modules\next\dist\bin\next build` 直接跑（不经 npm，绕开 spawn），实测可行但慢（约 1-2 分钟）；
- **都不做就继续验证 = 本次结果无效，报告里必须标注。**

### 3. 健康检查（这是 doctor 的锚点）

```powershell
$r = Invoke-WebRequest -Uri 'http://127.0.0.1:3003/api/health' -UseBasicParsing -TimeoutSec 15
"STATUS=$($r.StatusCode)"
$r.Content
```

通过标准：

| 字段 | 期望值 | 不满足说明什么 |
|---|---|---|
| HTTP 状态 | `200` | `503` = 数据库不通或有致命环境变量缺失 |
| `status` | `"ok"` | — |
| `database` | `"ok"` | 数据库连不上，后面全部无意义，停在这里报告 |
| `aiConfigured` | `true` | 为 `false` 时 AI 路径（诊断/润色）不可验，跳过并标注 |
| `issues[]` | 只允许 `level: "warn"` | 出现 `level: "fatal"` = 停 |

注意：`/api/health` **不需要登录**，所以它是「服务到底活着没」的唯一可靠判据。第 3 步不过，不要往下走。

---

## 四、四层验证，从便宜到贵

| 层 | 验什么 | 命令 | 耗时 | 沙箱内可跑 |
|---|---|---|---|---|
| L1 静态 | 类型、单元逻辑 | `.\verify.cmd` | 30-60 秒 | ✅ 部分（见下） |
| L2 接口 | 87 个 HTTP 用例 | `.\verify.cmd -Full` | 3-5 分钟 | ❌ 需 dsh 外 |
| L3 UI 路径 | 真人操作一遍 | 本文第五节 | 3-8 分钟 | ✅ |
| L4 数据 | 库里真有那一行 | `scripts/probe-db.cjs` | 5 秒 | ✅ |

**改动越靠近界面，越必须跑 L3 + L4。** 只改纯函数（`src/lib/*.ts`）可以只跑 L1。

### L1 在沙箱内的正确跑法

`verify.ps1` 里已经写明了沙箱限制（spawn EPERM），它自己会降级。直接跑：

```powershell
cd <项目根目录>
.\verify.cmd
```

如果它报 SKIP（沙箱拦了），把这两个直接跑（它们是直接 `& node`，不 spawn）：

```powershell
$node = 'C:\Program Files\nodejs\node.exe'
& $node '.\node_modules\typescript\bin\tsc' --noEmit
& $node '.\node_modules\vitest\vitest.mjs' run tests/unit --pool=threads
```

基线：**unit 96 通过**。数量变少 = 有测试被删或被跳过，先解释再继续。

---

## 五、L3 用户路径验证（核心）

### 5.0 建一个一次性账号

不走界面注册（省 3 步，也不会被注册页的校验文案干扰）：

```powershell
$ts = Get-Date -Format 'HHmmss'
$email = "verify+$ts@moyu.local"
$pw = ([guid]::NewGuid().ToString('N')).Substring(0,16)
$json = @{ name = 'verify-probe'; email = $email; password = $pw } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
Invoke-RestMethod -Uri 'http://127.0.0.1:3003/api/auth/register' -Method Post `
  -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 20
"EMAIL=$email"
"PW=$pw"
```

期望：`201`，返回 `{id, name, email}`。
注册接口对回环地址跳过限流（`isLoopbackIp` 判断），所以反复跑不会 429。

**把 email 和 pw 记下来**，后面登录和注销都要用。

### 5.1 登录（这条同时验证登录页本身）

浏览器操作顺序（在 3003 上，从 `/login` 开始）：

| 步骤 | 选择器 | 动作 | 期望 |
|---|---|---|---|
| 1 | `input[type=email]` | 输入 email | — |
| 2 | `input[type=password]` | 输入 pw，回车提交 | — |
| 3 | — | 等 2.5 秒 | URL 变成 `http://127.0.0.1:3003/` |
| 4 | — | 读页面文本 | 出现账号名 `verify-probe`、`我的作品`、`共 0 部` |

失败信号：URL 停在 `/login` 且页面出现 `邮箱或密码错误`。

### 5.2 建作品

| 步骤 | 选择器 | 动作 | 期望 |
|---|---|---|---|
| 1 | `input[placeholder="请输入作品名称"]` | 输入 `[verify] 冒烟 <时间戳>` | — |
| 2 | 文本为「创建作品」的 button | 点击 | — |
| 3 | — | 等 3 秒 | 出现 `共 1 部`、作品名、`1 个章节` |

注意：作品名带 `[verify]` 前缀，是为了万一清理失败时一眼能看出是垃圾数据。

### 5.3 进编辑页 + 自动保存（**最重要的一条**）

点 `a[href^="/projects/"]` 进编辑页。期望页面出现：`作品设置`、`导出`、`未修改`、`保存`、`章节`、`+ 新建章节`、`自动保存已开启（停笔约 1 秒后写入）`。

然后在正文框输入一段测试文本：

| 步骤 | 选择器 | 动作 |
|---|---|---|
| 1 | `textarea[placeholder^="在这里写正文"]` | 输入一段已知长度的中文文本 |
| 2 | — | **不要点保存**，等 1.2 秒以上（自动保存防抖就是这个时长） |

轮询读页面文本，抓这四种状态：

```
未修改  →  保存中…  →  已保存 HH:mm:ss   （正常链路）
                     ↘  保存失败，请检查网络   （失败）
        ↘  自动保存已暂停，你打的字还在编辑区里没丢  （409 冲突）
```

**通过标准（四条全部满足）：**

1. 状态最终变成 `已保存 <时间>`，不是停在 `保存中…` 或 `未修改`；
2. 顶部 `全书 N 字` 与 `本章 N 字` 都等于输入文本的字符数；
3. 右栏 `版本历史` 从 `0 / 0 条` 变成 `1 / 1 条`，且有一条 `编辑器保存 · N 字`；
4. 第五节 5.5 的数据库查询结果，`content` 与输入**完全一致**、`wordCount` 等于字符数、`version` 从 0 变 1、`revisions` = 1。

第 4 条是铁律一。前三条都对但第 4 条不对 = **这是真 bug，必须报告**（典型：前端乐观更新了 UI，但 PATCH 被静默丢弃）。

实测记录（2026-11-21 12:01:18，用于校准）：

```
输入 35 字 → 已保存 12:01:18 → 全书 35 字 / 本章 35 字
→ 版本历史 1 / 1 条「编辑器保存 · 35 字」
→ 库：contentLen=35 wordCount=35 version=1 revisions=1 content 与输入逐字一致
```

### 5.4 其他值得单独验的路径

见 `features/README.md`。按改动位置选：

- 动过 `src/lib/wordCount.ts` → 必须验字数（5.3 第 2 条）；
- 动过章节接口 / 乐观锁 → 必须验 409（双标签页同时改同一章）；
- 动过导出 → 必须验导出（点 `aria-label="导出选项"`，看菜单出现、**页面 URL 不变**、不出 500）；
- 动过 AI 相关 → 见 `features/README.md` 的 AI 一节（要假 AI 服务，参见项目根下 `scripts/fake-ai-server.mjs`，不在本技能目录内）。

### 5.5 数据库取证（铁律一的执行）

```powershell
$node = 'C:\Program Files\nodejs\node.exe'
$env:DATABASE_URL = "file:" + ((Get-Location).Path -replace '\\','/') + "/prisma/dev.db"
& $node '.\skills\verify-app\scripts\probe-db.cjs' `
  "$env:TEMP\dbcheck.json" --email-prefix 'verify+'
Get-Content "$env:TEMP\dbcheck.json" -Raw -Encoding UTF8
```

**参数顺序必须是「输出路径」在前、「`--email-prefix`」在后**（脚本把第一个参数当输出文件）。写反了它会老老实实建一个名叫 `--email-prefix` 的文件。

`probe-db.cjs` 做的事：找最新的 `verify+*` 账号 → 它名下的作品 → 最新章节 → 该章节的版本数，全部打印。**只读，不写库。**

为什么不用 `npx prisma studio` 之类：沙箱里 spawn 不通，而且 studio 要开端口、要人点，不可脚本化。

### 5.6 清理（必做，否则下次验证会看到上次的垃圾）

```powershell
# 用登录态调 DELETE；密码就是 5.0 生成的那个
$body = @{ password = '<5.0 生成的 pw>' } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod -Uri 'http://127.0.0.1:3003/api/account' -Method Delete `
  -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 20
```

⚠️ 这个请求必须**带着登录 Cookie**。用浏览器发（在页面上下文里 `fetch`），或者从浏览器导出 Cookie 后带上。最省事的做法：在验证页面的 browser 上下文里执行：

```js
await fetch('/api/account', {
  method: 'DELETE',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: '<pw>' }),
  credentials: 'include'
})
```

期望返回 `{"ok":true,"deleted":{...}}`。返回 `密码不正确，账号未删除` = 密码记错，不要重复试到把账号锁住（本项目没有锁定机制，但别乱试）。

注销后确认：重新访问首页应跳回 `/login`；`probe-db.cjs` 查不到 `verify+*` 账号。

然后关掉 3003 的服务 job 和浏览器。

---

## 六、判定表（报告里必须按这张表逐条写通过/未通过）

| # | 检查项 | 通过标准 | 证据 |
|---|---|---|---|
| 1 | 构建新鲜 | `.next/BUILD_ID` 晚于 src 最新改动 | 两个时间戳 |
| 2 | 服务活着 | `/api/health` 200 + `status:ok` + `database:ok` | 完整 JSON |
| 3 | 静态检查 | tsc 0 错；unit ≥ 96 通过 | 命令 + 数字 |
| 4 | 接口测试 | 87 用例通过（若跑了 L2） | 命令 + 数字 |
| 5 | 登录可用 | 跳转首页、显示账号名 | URL + 页面文本 |
| 6 | 建作品 | `共 1 部` | 页面文本 |
| 7 | 自动保存（UI） | 状态变 `已保存`，字数正确 | 状态时间戳 + 字数 |
| 8 | 自动保存（库） | content/wordCount/version/revisions 全部对 | probe-db 输出 |
| 9 | 清理干净 | 账号已删、无残留 | DELETE 返回 + 复查 |

任何一条未通过 → 报告写「未通过 + 具体现象 + 复现步骤」，**不允许**用「基本正常」「应该没问题」含糊过去。

---

## 七、选择器清单（实测于 2026-11-21）

这个项目**没有 `data-testid`**（`src/` 全仓 0 处），所以选择器全靠 `type` / `placeholder` / `aria-label` / 可见文本。它们稳定但要维护：

| 元素 | 选择器 | 来源 |
|---|---|---|
| 登录邮箱 | `input[type=email]` | `src/app/login/page.tsx:54` |
| 登录密码 | `input[type=password]` | `src/app/login/page.tsx:66` |
| 登录提交 | `button[type=submit]` | `src/app/login/page.tsx:82` |
| 新作品名称 | `input[placeholder="请输入作品名称"]` | `src/app/home-client.tsx:192` |
| 创建按钮 | 文本 `创建作品` / `创建中...` | `src/app/home-client.tsx:223` |
| 作品卡片链接 | `a[href^="/projects/"]` | 首页 |
| 章节标题框 | `input[placeholder="章节标题"]` | `editor-client.tsx:1514` |
| 正文档 | `textarea[placeholder^="在这里写正文"]` | `editor-client.tsx:1527` |
| 手动保存 | 文本 `保存` / `保存中…` | `editor-client.tsx:1363` |
| 导出菜单 | `aria-label="导出选项"` | `editor-client.tsx:2387` |
| 返回列表 | `aria-label="返回作品列表"` | `editor-client.tsx:1297` |
| 关闭版本预览 | `aria-label="关闭历史版本预览"` | `editor-client.tsx:2033` |

**文案型断言（改了字就要同步本文件）：**

- `未修改` / `保存中…` / `已保存` / `已保存 HH:mm:ss`
- `保存失败，请检查网络`
- `自动保存已暂停，你打的字还在编辑区里没丢。请选择：`
- `有改动尚未落盘，请等状态变回「已保存」`
- `自动保存已开启（停笔约 1 秒后写入）`
- `本章 N 字` / `全书 N 字` / `版本历史` / `N / N 条` / `编辑器保存 · N 字`

如果一个改动把这些文案改掉了，**同时**要改这份文件——否则下次验证会误报失败。这是有意的设计：文案就是用户看到的东西，改文案本身就该被人工过一眼。

---

## 八、已知限制（别假装能跑）

1. **沙箱内跑不了 `next build` 和 `npm run test:api`**（spawn EPERM）。这是 `verify.ps1` 第 7-8 行就写明的既有事实。绕法：直接 `& node .\node_modules\next\dist\bin\next build`，或到 dsh 外直接跑 `verify.cmd -Full`。
2. **无 testid**：见第七节。想改的话是加 `data-testid`，属于代码改动，需要单独批准。
3. **AI 路径要假服务**：真打 DeepSeek 费钱且不确定。项目根下 `scripts/fake-ai-server.mjs` + 端口 11499 是现成方案（接口测试就是用它），不在本技能目录内。
4. **浏览器是 DSH 的 browser_* 工具，不是 Playwright**。没有录制回放，每一步都是显式调用。好处是不用装依赖；坏处是没法一键重跑到 CI。
5. **时区敏感**：`已保存 HH:mm:ss` 是本地时间（Asia/Shanghai），断言时间时别用 UTC 比。
6. **`GET /api/projects/<id>` 不返回 `content` 和 `version`**（实测拿到 undefined / 0）。想断言正文或版本号，必须用 `GET /api/chapters/<id>`。拿列表接口断言会得到假的「内容为空」。
7. **改作品名不能 `PATCH /api/projects/<id>`** —— 那个接口只有 GET / DELETE，`PATCH` 回 **405**。走 `PATCH /api/projects/<id>/settings`，body 必须带 `title`（zod `.max(100)` 按 UTF-16 长度算，emoji 最多 50 个）。
8. **界面状态灯是双向不可信的**：实测出现过「显示保存失败、刷新后库里其实有 42 字」。所以铁律一不是保守，是必须——凡涉及「字有没有保住」，只看库。

---

## 九、维护约定

- 改了这个项目任何**用户可见文案**或**表单结构** → 同步第七节，改完立刻跑一遍第五节确认没写错。
- 单元/接口测试基线数字变了（现在是 unit 96 / api 87）→ 同步第四节和第六节。
- 删掉了某条路径涉及的功能 → 从 `features/` 里删掉对应文件，别留着骗人。
- 这份文件里的每个命令都**被真的跑过**才写进来。没跑过的写「未验证」三个字，不许写成肯定句。

### 9.1 定期维护轮（借自 pstack `maintain-verification-skill`）

功能地图在代码一变的瞬间就开始腐烂。除了上面的随改随同步，大改之后应做一轮完整维护，**结局必须三选一并明说**：

| 结局 | 含义 | 产出 |
|---|---|---|
| `clean` | 每个功能都过了源码核对 + 实跑，无需修正 | 报告，不交付任何改动 |
| `changed` | 有已证实的修正 | **一次**交付全部修正（改地图/脚本，不改产品代码） |
| `blocked` | 覆盖没跑完或修正无法安全落地 | 报告写清具体卡在哪 |

维护轮的硬规则：

1. **编辑范围只有本技能目录**（SKILL.md、`features/`、`scripts/`）。绝不在维护轮里改产品代码——地图说有而 app 没有的行为，要么是文档漂移（改地图），要么是产品回归（**上报并记录**，不许在文档里糊弄过去）。
2. **流程**：索引卫生（`features/` 文件不多不少不重复）→ 源码核对（每个功能文件对照源码查漂移，可并行只读）→ 对账 → **实跑**（每个功能至少真实驱动一次，源码干净也必须跑）→ 分诊（文档漂移改地图 / 工具缺口改脚本 / 产品缺陷记录上报）→ 结束。
3. **实跑三条不变量**，无论发生什么失败：① doctor 先行——首次驱动前、每个新会话、任何一次失败驱动之后都要重跑 doctor；doctor 看不到的卡死（进程活着 UI 死了）→ 重置状态或重启，不要硬试；② 证据在**具名位置**存活——每次清理后核实，不许假定；③ 本轮启动的东西不活过本轮——失败的迭代残留也要清（共享实例清残留，不杀实例）。
4. **到不了的功能**只能标 `verified-unreachable`，且必须写明具体前置条件（认证、外部状态、OS 限制）和尝试过的路径；地图里漏了这个前置条件 = 漂移，补进 `Gotchas`。
5. doctor 失败若因技能漂移（文案改了、选择器失效）→ 修本技能后**重试一次**；再失败才准标 `blocked`。

---

## 十、最小可用版本（只想 3 分钟确认没搞坏东西）

```powershell
# 1. health（不登录、最快）
(Invoke-WebRequest 'http://127.0.0.1:3003/api/health' -UseBasicParsing).Content

# 2. 类型 + 单元
cd <项目根目录>
& 'C:\Program Files\nodejs\node.exe' '.\node_modules\typescript\bin\tsc' --noEmit
& 'C:\Program Files\nodejs\node.exe' '.\node_modules\vitest\vitest.mjs' run tests/unit --pool=threads

# 3. 界面上真点一遍登录 → 建作品 → 打字 → 看到「已保存」

# 4. 查库确认落盘
& 'C:\Program Files\nodejs\node.exe' '<本目录>\scripts\probe-db.cjs' '<输出 json 路径>'
```

四步都过，才算「改完了」。
