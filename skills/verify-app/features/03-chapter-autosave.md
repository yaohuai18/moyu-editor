# 功能 03：正文编辑 → 自动保存 → 落库

> **这是全项目最值得验的一条路径。**
> 理由：`verify.cmd` 的 87 个接口用例已经证明了 PATCH `/api/chapters/[id]` 是好的，
> 但它证明不了「用户在 textarea 里打的字，真的走到那条 PATCH、并且没被前端吞掉」。
> 中间的自动保存防抖、乐观锁版本号、切章保护、错误提示，全都在这段前端代码里
> （`editor-client.tsx` 2000+ 行），一条测试都没覆盖。

---

## 前置

- 服务已在 3003 跑起来，`/api/health` 返回 200（见 SKILL.md 第三节）
- `.next` 是新的（铁律二）
- 已用临时账号登录，已建好一部作品，已进入 `/projects/<id>`

---

## 完整步骤（照抄）

### 1. 确认在编辑页、正文框是空的

```js
({
  url: location.href,
  hasTextarea: !!document.querySelector('textarea[placeholder^="在这里写正文"]'),
  text: document.body.innerText.slice(0, 120)
})()
```

期望：`url` 匹配 `/projects/<id>`，`hasTextarea: true`。

### 2. 输入一段**长度已知**的文本

长度必须是你能心算的（比如 35 个字），后面断字数要用。

```js
// 用工具输入，不要用 eval 直接改 textarea.value ——
// 那样不触发 React 的 onChange，自动保存永远不会启动，
// 你会得到「等了半天还是未修改」的假故障。
```

用 DSH 的 `browser_type`：

- 选择器 `textarea[placeholder^="在这里写正文"]`
- 文本：`验证脚本写入的测试正文：窗外下着雨，周砚把旧铜锁搁在柜台上，没有说话。`（35 字）

### 3. 不要点保存，等防抖

自动保存防抖是 **1.2 秒**（`editor-client.tsx:697`）。轮询抓状态：

```js
(async () => {
  const t0 = Date.now();
  const states = [];
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 500));
    const m = document.body.innerText.match(/(未修改|保存中…|已保存[^\n]*|保存失败[^\n]*)/);
    states.push({ ms: Date.now() - t0, s: m ? m[1] : null });
    if (m && m[1].startsWith('已保存')) break;
  }
  const ta = document.querySelector('textarea[placeholder^="在这里写正文"]');
  return {
    states,
    taLen: ta ? ta.value.length : null,
    headerWord: (document.body.innerText.match(/全书 \d+ 字/) || [null])[0],
    chapterWord: (document.body.innerText.match(/本章 \d+ 字/) || [null])[0],
    versionHist: (document.body.innerText.match(/版本历史\n[\s\S]{0,40}/) || [null])[0]
  };
})()
```

### 4. 断言四条

| # | 断言 | 期望 |
|---|---|---|
| 1 | 状态序列 | 最后一个状态以 `已保存` 开头，且 `ms` 在 1.2-4 秒之间 |
| 2 | `taLen` | 等于输入字符数（35） |
| 3 | `headerWord` / `chapterWord` | 都是 `全书 35 字` / `本章 35 字` |
| 4 | `versionHist` | 从 `0 / 0 条` 变成 `1 / 1 条`，含 `编辑器保存 · 35 字` |

### 5. 查库（铁律一，**不能省**）

```powershell
$env:DATABASE_URL = "file:" + ((Get-Location).Path -replace '\\','/') + "/prisma/dev.db"
& 'C:\Program Files\nodejs\node.exe' `
  '.\skills\verify-app\scripts\probe-db.cjs' `
  "$env:TEMP\dbcheck.json" --email-prefix 'verify+'
Get-Content "$env:TEMP\dbcheck.json" -Raw -Encoding UTF8
```

（参数顺序：输出路径在前，`--email-prefix` 在后。写反了脚本会建一个名叫 `--email-prefix` 的文件。）

断言：`chapter.content` 与输入**逐字一致**；`contentLen` = `wordCount` = 35；`version` = 1；`revisions` = 1；`latestRevision.changeReason` = `编辑器保存`。

---

## 失败怎么读

| 现象 | 含义 | 下一步 |
|---|---|---|
| 停在 `未修改` | textarea 的输入没触发 React onChange（多半是用 eval 直接改了 value） | 改用 `browser_type` 重来 |
| 停在 `保存中…` 超过 10 秒 | PATCH 挂起或后端卡住 | 看服务端 job 输出，查是不是数据库锁 |
| 出现 `保存失败，请检查网络` | PATCH 非 2xx 且不是 409 | 抓 `/api/chapters/<id>` 的响应体 |
| 出现 `自动保存已暂停，你打的字还在编辑区里没丢` | 409 版本冲突（正常保护机制被触发） | 说明有第二个写入者；查是不是自己开了两个标签页 |
| UI 显示已保存，但库里 `content` 是旧的 | **真 bug**：前端乐观更新，PATCH 被丢弃 | 立即报告，附 UI 状态 + 库输出两份证据 |
| 字数对不上（`全书 0 字`） | `wordCount` 计算或回填链路坏了 | 查 `src/lib/wordCount.ts` 与章节接口 |

---

## 实测记录（2026-11-21 12:01:18，用于校准）

```
输入 35 字
→ 状态 503ms 后变为「已保存 12:01:18」
→ taLen=35，全书 35 字，本章 35 字
→ 版本历史 1 / 1 条「编辑器保存 · 35 字」
→ 库：contentLen=35 wordCount=35 version=1 revisions=1
      content="验证脚本写入的测试正文：窗外下着雨，周砚把旧铜锁搁在柜台上，没有说话。"
```

这条链是通的。以后验出不一样的结果，就是回归。

---

## 追加验法：409 乐观锁（改过章节接口时必验）

1. 标签页 A 打开某章，输入 A 内容，等它保存完（`已保存`）；
2. 标签页 B 打开**同一章**（另开一个 browser 上下文，或先 A 保存后 B 再进）；
3. B 输入 B 内容并保存（成功，`version` +1）；
4. 回到 A，继续打字。

期望：A 出现 `自动保存已暂停，你打的字还在编辑区里没丢。请选择：`，且 A 的内容**没有被静默覆盖**。

库侧断言：`version` 只增加了 1（不是 2），且 `content` 等于 B 的内容。

这条验的是「两个标签页互相覆盖」这个真实事故场景。`editor-client.tsx:1374-1383` 是它的实现位置。
