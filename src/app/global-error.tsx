"use client";

import { useEffect } from "react";

/**
 * 最外面一层兜底：连根布局（layout.tsx）都挂了的时候才会走到这里。
 *
 * 因为它替换掉了整个根布局，全局样式这时也拿不到了，
 * 所以这里的样式全部写成 inline style，不依赖 Tailwind 是否加载成功。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f8fafc",
          color: "#0f172a",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif",
          padding: "24px",
        }}
      >
        <div
          style={{
            maxWidth: "420px",
            width: "100%",
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "16px",
            padding: "32px",
            textAlign: "center",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>
            服务暂时打不开
          </h1>

          <p
            style={{
              margin: "12px 0 0",
              fontSize: "14px",
              lineHeight: 1.7,
              color: "#64748b",
            }}
          >
            整个应用在启动时出了问题，你的作品数据仍然保存在服务器上。
            稍等一会儿再刷新；如果一直这样，请联系开发者。
          </p>

          {error.digest ? (
            <p
              style={{
                margin: "16px 0 0",
                fontSize: "12px",
                color: "#94a3b8",
                background: "#f8fafc",
                borderRadius: "8px",
                padding: "8px 12px",
              }}
            >
              错误编号：{error.digest}
            </p>
          ) : null}

          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "24px",
              padding: "10px 18px",
              fontSize: "14px",
              fontWeight: 500,
              color: "#ffffff",
              background: "#2563eb",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            重新加载
          </button>
        </div>
      </body>
    </html>
  );
}
