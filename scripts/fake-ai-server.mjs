// 假的「OpenAI 兼容」服务，只给接口测试用。
//
// 为什么需要它：接口测试要覆盖「AI 成功」「上游 500」「返回空」「返回的不是 JSON」
// 这几条路径，用真 Key 打真服务等于把测试做成随机数 —— 费钱、慢、还不确定。
// 这个假服务在本机 127.0.0.1 上按 OpenAI 的格式回话，行为完全可控。
//
// 控制方式：正文里出现下面这些「魔术词」就触发对应行为
//   [[UPSTREAM_500]]  上游 500（测「AI 服务异常」）
//   [[UPSTREAM_401]]  上游 401（测 Key 失效）
//   [[EMPTY]]         返回空内容
//   [[NOT_JSON]]      返回一段不是 JSON 的文本
//   [[DELAY_MS=1200]] 先等这么久再回话
//                     （「AI 处理中」这个状态一闪而过，验收时观察不到 ——
//                      在正文里塞这个魔术词就能把它稳定地拉长）
// 否则：诊断请求返回一份固定形状的问题清单，润色请求返回「原文 + 已润色标记」。
//
// 另附 GET /stats：告诉测试「一共被调了几次」，用来验证限流是不是真的生效。
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_AI_PORT || 11499);

let callCount = 0;

function reply(res, status, payload) {
  const body = JSON.stringify(payload);

  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** 把用户提示词里的正文抠出来（夹在 --- 之间的那一段） */
function extractContent(prompt) {
  const match = prompt.match(/---\n([\s\S]*?)\n---/);

  return match ? match[1] : prompt;
}

const server = createServer((req, res) => {
  // 统计接口
  if (req.method === "GET" && req.url === "/stats") {
    return reply(res, 200, { calls: callCount });
  }

  if (req.method === "GET" && req.url === "/reset") {
    callCount = 0;

    return reply(res, 200, { calls: 0 });
  }

  let raw = "";

  req.on("data", (chunk) => {
    raw += chunk;
  });

  req.on("end", () => {
    callCount += 1;

    let body = {};

    try {
      body = JSON.parse(raw);
    } catch {
      return reply(res, 400, { error: { message: "invalid json" } });
    }

    const prompt = JSON.stringify(body.messages ?? []);

    // 延迟回话：验收脚本靠它把「AI 处理中」这个中间态从一闪而过变成看得清
    const delayMatch = prompt.match(/\[\[DELAY_MS=(\d+)\]\]/);
    const delay = delayMatch ? Math.min(Number(delayMatch[1]), 20000) : 0;

    const handle = () => {
      if (prompt.includes("[[UPSTREAM_500]]")) {
        return reply(res, 500, { error: { message: "fake upstream exploded" } });
      }

      if (prompt.includes("[[UPSTREAM_401]]")) {
        return reply(res, 401, { error: { message: "fake invalid api key" } });
      }

      if (prompt.includes("[[EMPTY]]")) {
        return reply(res, 200, { choices: [{ message: { content: "" } }] });
      }

      if (prompt.includes("[[NOT_JSON]]")) {
        return reply(res, 200, {
          choices: [{ message: { content: "抱歉，我这次没有按 JSON 输出。" } }],
        });
      }

      // 诊断：固定形状（把 severity 三种都覆盖到）
      if (prompt.includes("诊断小说文本")) {
        return reply(res, 200, {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  issues: [
                    {
                      type: "空泛表达",
                      quote: "心中一震",
                      explanation: "情绪直接说出来，读者感受不到",
                      suggestion: "换成具体动作或身体反应",
                      severity: "high",
                    },
                    {
                      type: "重复",
                      quote: "很难过，非常难过",
                      explanation: "同一个意思说了两遍",
                      suggestion: "删掉一次，或换一个角度写",
                      severity: "medium",
                    },
                    {
                      type: "节奏",
                      quote: "他站着没动",
                      explanation: "与上一句衔接略生硬",
                      suggestion: "补一个短句过渡",
                      severity: "low",
                    },
                  ],
                }),
              },
            },
          ],
        });
      }

      // 润色：把原文原样带回来并加标记，测试就能断言「改的是这一章的内容」
      const content = extractContent(
        JSON.parse(raw).messages?.find?.((m) => m.role === "user")?.content ?? ""
      );

      return reply(res, 200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                revisedText: `${content}\n（已润色标记）`,
                changes: ["把书面表达换成更口语的说法", "缩短了一个长句"],
              }),
            },
          },
        ],
      });
    };

    if (delay > 0) {
      setTimeout(handle, delay);
    } else {
      handle();
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fake-ai] listening on http://127.0.0.1:${PORT}`);
});
