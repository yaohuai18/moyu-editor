# 功能 05：导出

> 实测状态：✅ **已实测**（2026-11-21 12:3x，moyu 起在 3003，`.next/BUILD_ID=mjHxcz6sxf9t0gYT2PvOr`）。
> 三条历史边界：emoji ✅ 已修好、Windows 保留名 ⚠️ 口径已订正（本机可创建，风险在跨平台与下载器）、孤立 `\r` ❌ 仍会坏。

---

## 入口（实测修正过的一处）

顶部按钮文本是 **`导出`**（`editor-client.tsx:2372`）。点它才弹出菜单。

`aria-label="导出选项"` 是**下拉菜单容器**（`role="menu"`，`editor-client.tsx:2386-2387`），不是触发按钮。写选择器时别搞反：

```js
// 触发
[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '导出')
// 菜单
document.querySelector('[role="menu"][aria-label="导出选项"]')
```

菜单四项（顺序固定）：全书 `纯文本（.txt）`、全书 `Markdown（.md）`、当前章 `纯文本（.txt）`、当前章 `Markdown（.md）`。

---

## 一、接口实测结果（4 条全通）

| 请求 | 状态 | Content-Type | 文件名（filename*） |
|---|---|---|---|
| `GET /api/projects/<pid>/export?format=txt` | 200 | `text/plain; charset=utf-8` | `<作品名>.txt` |
| `GET /api/projects/<pid>/export?format=md` | 200 | `text/markdown; charset=utf-8` | `<作品名>.md` |
| `GET /api/chapters/<cid>/export?format=txt` | 200 | `text/plain; charset=utf-8` | `<作品名>-第 N 章 <章名>.txt` |
| `GET /api/chapters/<cid>/export?format=md` | 200 | `text/markdown; charset=utf-8` | `<作品名>-第 N 章 <章名>.md` |

**Content-Disposition 双份是对的**：`filename="[verify] ____ 122007.txt"`（ASCII 兜底）+ `filename*=UTF-8''%5Bverify%5D%20...`（RFC 5987）。中文名不会乱码。

**内容格式**（实测 body）：

```
[verify] 切章测试 122007⏎⏎⏎第 1 章 第一章⏎⏎第一章的内容：…⏎⏎⏎第 2 章 第2章⏎⏎…
```

- 章节之间是**三个换行**（空两行）
- 开头是作品名
- md 版多 `# 作品名` + `> 分类：都市 · 共 2 章`

**限流**：每用户每分钟 20 次导出（`api/chapters/[id]/export/route.ts:45`），超了返回 429 + `Retry-After`。正常手点摸不到，但批量压测要等。

---

## 二、三条历史边界，实测结论

### ✅ emoji 卡在截断边界 —— 已修好，不会再 500

作品名设成 92 个码点（59 个 A + 3 个 emoji + 30 个 B，UTF-16 长度 95）：

```
输出文件名（filename*）: AAAA…(59个A)…😀.txt
ASCII 兜底            : AAAA…(59个A)…__.txt
状态                   : 200
```

**emoji 整体保留，没有被切半个，接口没 500。**

原因在 `src/lib/export.ts:81`：`Array.from(value).slice(0, max).join("")` 按**码点**切；万一还是出了半个代理项，`encodeRfc5987` 里 `try/catch` 会返回 `null` 并降级到 ASCII 兜底（`:286-294`）。两层保险都在，这条技术债可以划掉。

### ⚠️ Windows 保留名 —— 口径订正：不是「Windows 不允许」，是跨平台/下载器不友好

作品名设成 `CON`，导出：

```
status: 200
filename*: CON.txt
filename : CON.txt
```

接口照常返回 200，文件名就是 `CON.txt`。**2026-11-23 复核订正**：本文件原来写「Windows 不允许创建名为 `CON` 的文件」，这个结论不成立——同机实测（提权后 `cmd /c "echo hello> CON.txt"`）在 `E:\...\.sandbox\moyu-acceptance\order4\` 与 `C:\Users\牛\Downloads` 两处都建出 7 字节文件，`type CON.txt` 回读 `hello`，`dir` 也列得出来；更早那次 `Access to the path ... is denied` 是沙箱/工具层拦截，被误记成了操作系统行为。真实后果是**兼容性而非可写性**：其他平台、浏览器下载器或解压工具有可能改名成 `CON (1).txt` 或直接拒绝，用户可能看到「点了导出没反应」，但根因在下游工具，不是这台机器写不了文件。

`sanitizeFilenamePart`（`src/lib/export.ts:44`）只过滤 `\ / : * ? " < > |` 和控制字符，**没有保留名黑名单**。

**可选加固**（不是修 bug，是提高跨平台/下载器兼容性的加固；要加就照抄）：

```ts
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
// sanitize 之后：
const safe = WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
```

### ❌ 孤立 `\r` —— 实测确认仍会漏出去

正文设成 `第一行\r孤立回车在这里\r\n正常换行在这里`，导出 body（JSON 转义）：

```
"第 2 章 第2章\n\n第一行\r孤立回车在这里\n正常换行在这里\n"
```

`\r\n` 被规范化成 `\n`，但**孤立的 `\r` 原样留在导出文件里**（`chapterBody` 只做 `.replace(/\r\n/g, "\n")`，`export.ts:119`）。

后果：粘进某些平台（尤其是纯文本编辑器、老式论坛）会出现诡异换行或整行被吞。

**修法**：`content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd()`。

---

## 三、界面导出：500 时页面不跳走 ✅

这是 `AGENTS.md` 明令「不要用 `window.location.assign`」的那条设计决策。实测两条：

| 场景 | 结果 |
|---|---|
| 正常点「导出」→「纯文本（.txt）」 | `location.href` **没变**，编辑器还在（textarea 在），菜单自动关闭，无报错 |
| **模拟 500**（页面内 patch fetch 让 `/export` 返回 500） | `location.href` **没变**，编辑器还在，顶部 `role="alert"` 显示 `导出失败（模拟）` |

**结论：这条设计现在是生效的。** 以后如果有人改回 `window.location.assign`，验法就是：制造一次 500，看 URL 有没有离开 `/projects/<id>`。

制造 500 的脚本（可直接复用）：

```js
if (!window.__origFetch) window.__origFetch = window.fetch;
window.fetch = (...a) => {
  const u = typeof a[0] === 'string' ? a[0] : (a[0]?.url || '');
  if (u.includes('/export')) return Promise.resolve(new Response('{"error":"导出失败（模拟）"}', { status: 500, headers: {'content-type':'application/json'} }));
  return window.__origFetch.apply(this, a);
};
// …点导出、点菜单项、读 location.href 和 [role="alert"]…
window.fetch = window.__origFetch;   // 用完必须还原
```

---

## 四、实测中新发现的坑（写文档时现学到的）

1. **改作品名不能用 `PATCH /api/projects/<id>`** —— 那个接口只有 `GET` 和 `DELETE`，`PATCH` 返回 **405**。改名字走 `PATCH /api/projects/<id>/settings`（`api/projects/[id]/settings/route.ts:42`），body 必须带 `title`。
2. **`title` 的 zod 上限 100 是按 UTF-16 长度算的**（`.max(100)`），所以 emoji 作品名最多 50 个。想测 60 码点截断要用「ASCII + emoji 混排」，纯 emoji 会被 400 拦住。
3. **章节标题会重复**：新建章节的默认标题就叫「第2章」，导出时 `chapterHeading` 又加前缀，结果是「**第 2 章 第2章**」。不是崩溃，但难看。要修就在建章时不默认填「第N章」，或者导出时检测标题已含「第 N 章」就跳过前缀。
4. **`/api/projects/<id>` 列表接口不返回 `content` 和 `version`**（实测返回 undefined / 0）。想断言正文或版本号，必须用 `GET /api/chapters/<id>` 单章接口。用列表接口做断言会得到假的"内容为空"。
