/**
 * Next.js 启动钩子。
 *
 * 服务进程一起来就跑一次环境变量体检，把结果打到启动日志里。
 * 目的很单纯：**让配错环境这件事在启动那一刻就暴露**，
 * 而不是等第一个用户点开页面才发现「登录 500」。
 *
 * 这里不抛异常、不强杀进程 —— 缺 AI Key 只是少个功能，
 * 缺数据库/会话密钥也让它照常起来、日志里喊清楚，
 * 免得部署平台陷入「起了就崩、崩了重启」的循环。
 */
export async function register() {
  // instrumentation 在 edge 和 nodejs 两个运行时都会加载，
  // 只有 nodejs 侧才看得到完整的环境变量
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // 跑自动化测试时会起好几个实例，每个都打一遍自检太吵，
  // 而且测试实例本来就故意用假 Key。需要看日志时去掉这个变量即可。
  if (process.env.MOYU_QUIET_BOOT === "1") {
    return;
  }

  const { reportEnvOnBoot } = await import("./lib/env");

  reportEnvOnBoot();
}
