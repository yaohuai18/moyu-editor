# 功能 01：注册 / 登录 / 注销

> 实测状态：登录 ✅、注销 ✅、API 注册 ✅、界面注册 ❌未实测。

---

## 1. 注册（走 API，不走界面）

界面注册多三步、还会被表单校验文案干扰，验证用不上。直接打接口：

```powershell
$ts = Get-Date -Format 'HHmmss'
$email = "verify+$ts@moyu.local"
$pw = ([guid]::NewGuid().ToString('N')).Substring(0,16)
$json = @{ name = 'verify-probe'; email = $email; password = $pw } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
Invoke-RestMethod -Uri 'http://127.0.0.1:3003/api/auth/register' -Method Post `
  -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 20
```

**断言**：`201`，返回 `{id, name, email}`，`email` 是**小写**（接口会 `toLowerCase().trim()`）。

**为什用 `verify+<时间戳>@moyu.local`**：`@moyu.local` 是这个项目的演示域名（`prisma/seed.ts:28` 里有硬校验，非该域名直接拒绝执行 seed）。用 `verify+` 前缀是为了 `probe-db.cjs` 能按前缀找到它、并且清理时不会误伤。

**为什么不会被限流**：注册接口对回环 IP 跳过限流（`api/auth/register/route.ts:26`），反复跑不会 429。

**重复邮箱**：返回 `409 {"error":"该邮箱已经注册"}`。看到这个说明时间戳撞了或上次没清理，换个时间戳。

---

## 2. 登录（走界面）

从 `/login` 开始，浏览器操作：

| 步骤 | 选择器 | 期望 |
|---|---|---|
| 1 | `input[type=email]` 输入 email | — |
| 2 | `input[type=password]` 输入 pw，回车 | — |
| 3 | 等 2.5 秒 | URL 变 `http://127.0.0.1:3003/` |
| 4 | 读页面文本 | 出现 `verify-probe`、`我的作品`、`共 0 部` |

**失败信号**：URL 停在 `/login` + 页面出现 `邮箱或密码错误`。

**注意**：这两个 input **没有 name 也没有 id**（`login/page.tsx:54,66`），只能靠 `type` 选。别写 `input[name=email]`，选不到。

---

## 3. 注销（走页面上下文里的 fetch）

注销需要**登录态 + 密码二次确认**（`api/account/route.ts:114`）。必须在浏览器上下文里发，才能自动带 Cookie：

```js
(async () => {
  const r = await fetch('/api/account', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: '<第 1 步的 pw>' }),
    credentials: 'include'
  });
  const body = await r.text();
  const after = await fetch('/api/account', { credentials: 'include' });
  return { status: r.status, body, afterStatus: after.status };
})()
```

**断言**：
- `status` = 200
- `body` = `{"ok":true,"deleted":{"userId":"...","projects":N,"chapters":N,"revisions":N,"aiUsages":N}}`
- `afterStatus` = **401**（账号没了，登录态自动失效——这是 tokenVersion/用户不存在的自然结果）

**再确认一次库**：跑 `scripts/probe-db.cjs`，`user` 应为 `null` 且带 `note` 提示。

**密码错了会怎样**：`400 {"error":"密码不正确，账号未删除"}`。不会锁账号，但别反复试。

---

## 已实测记录（2026-11-21 12:00-12:04）

```
注册 verify+120021@moyu.local → 201
登录（界面填表）→ 跳转 /，显示 verify-probe / 共 0 部
…（跑完 02、03）…
注销 → 200 {"ok":true,"deleted":{"userId":"cmwpvqwat...","projects":1,"chapters":1,"revisions":1,"aiUsages":0}}
再查 /api/account → 401
probe-db.cjs → user=null, note 提示没找到账号
```

整条链干净，无残留。

---

## 界面注册（未实测，改过注册页时才看）

`/register` 页字段（`register/page.tsx`）：

| 字段 | 选择器 |
|---|---|
| 笔名/昵称 | `input[placeholder="笔名或昵称"]` |
| 邮箱 | `input[type=email]` |
| 密码 | `input[placeholder="至少 8 位"]` |

注册成功后**不会自动登录**（接口注释写明：前端拿到 201 再调一次 `signIn`），要让验证脚本显式再登录一次。
