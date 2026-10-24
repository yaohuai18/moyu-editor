import type { NextConfig } from "next";

/**
 * 安全响应头。
 *
 * 这一组头的作用是「让浏览器替我们做几件防呆的事」，都不影响正常功能：
 *
 * - X-Content-Type-Options: nosniff
 *   浏览器不许猜类型。否则有人上传一个内容是 HTML 的 .txt，
 *   浏览器可能当网页执行（MIME 混淆攻击）。
 * - X-Frame-Options: DENY
 *   不许别人用 <iframe> 把本站嵌进他的页面。编辑器里全是用户正文，
 *   被嵌套 + 透明覆盖就成了「点击劫持」的素材。
 * - Referrer-Policy: strict-origin-when-cross-origin
 *   跳到外部网站时只带域名，不带具体路径 —— 作品的 URL 里带 id，
 *   不该白送给第三方。
 * - Permissions-Policy
 *   明确关掉摄像头 / 麦克风 / 定位。本站一个都不用，关了省得将来某个
 *   依赖悄悄申请权限时，用户看到「是否允许使用摄像头」的弹窗。
 * - X-DNS-Prefetch-Control: off
 *   关掉 DNS 预取。正文里出现的域名不该在用户还没点之前就被解析。
 *
 * ⚠️ 关于 Content-Security-Policy 的核查结论（第九阶段）：
 * **暂不启用严格 CSP**，因为它会同时踩到三处：
 *   1. Auth.js 登录流程要读写 Cookie、POST 到 /api/auth/*，Next.js 还会
 *      注入内联 hydration 脚本。严格 CSP 必须给脚本发 nonce，而 nonce
 *      要求全页面动态渲染 —— 首页的静态化就白做了。
 *   2. 编辑器自动保存是 fetch 打自己的接口，CSP 的 connect-src 必须正确
 *      列出站点自身；部署在反向代理子路径下时容易写错，症状是
 *      「保存一直失败但控制台没有明显报错」，排查成本很高。
 *   3. AI 请求走服务端转发（浏览器从不直连模型服务商），CSP 对保护
 *      AI Key 起不到额外作用 —— 那个 Key 根本没进浏览器。
 * 真要上 CSP，第一步应该是 `Content-Security-Policy-Report-Only`，
 * 用报告模式收集一周真实拦截情况再逐个放开，而不是直接上强制版。
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // 覆盖所有路径，包括接口和静态资源（静态资源加了也无害）
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
