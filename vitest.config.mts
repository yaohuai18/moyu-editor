import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * 测试配置。
 *
 * 两类测试分开跑，因为它们的「前置条件」完全不同：
 *
 * - `tests/unit`  ── 纯函数与纯逻辑，**不需要数据库、不需要启动网站**。
 *                    所以 `npm test` 只跑这一类：任何时候都该是绿的，
 *                    本地改完代码立刻能验证。
 * - `tests/api`   ── 打真实的 HTTP 接口，需要网站跑起来（且连的是测试库）。
 *                    用 `npm run test:api` 跑，那个脚本会自己起服务、跑完自己收摊。
 *
 * 之所以不合成一条命令：如果 `npm test` 依赖「服务得先起着」，
 * 那它在没起服务时会整片报错，久而久之就没人看它了 —— 测试等于没有。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 每个测试文件独立的进程内计数（限流用的是模块级 Map），
    // 串行跑更接近真实，也避免互相踩
    fileParallelism: false,
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
