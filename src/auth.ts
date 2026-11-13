import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";

/**
 * 时序均衡用的假哈希：登录时如果邮箱不存在，也要真跑一次 bcrypt 比对，
 * 让「账号不存在」和「密码错误」两条路径耗时一致 —— 否则用响应时间
 * 就能批量试出哪些邮箱注册过（侧信道枚举）。这个值没有任何账号在用。
 */
const DUMMY_PASSWORD_HASH =
  "$2b$12$4K7oizBal4D6ybW.DKRhvOQX9cIS7g4ATECVA5KjPFpammeBEVFuq";

export const { handlers, signIn, signOut, auth } = NextAuth({
  // 信任标记从环境变量来，不再硬编码 true：
  // - 本地开发：.env 里 AUTH_TRUST_HOST=true（.env.example 的默认值）；
  // - 正式域名：配 AUTH_URL，Auth.js 会自动信任它。
  trustHost: process.env.AUTH_TRUST_HOST === "true",

  session: {
    // 会话数据加密后存在 Cookie 里，服务端不落库。
    // 好处：下线/重启不掉登录；代价：改密码后旧 Cookie 不会立刻失效。
    strategy: "jwt",
  },

  // 把会话 Cookie 的行为显式写死在代码里（Auth.js 的默认值会随版本变）：
  // HttpOnly 防止 JS 读取、SameSite=Lax 挡跨站携带、https 部署时自动 Secure。
  cookies: {
    sessionToken: {
      name: process.env.AUTH_URL?.startsWith("https://")
        ? "__Secure-authjs.session-token"
        : "authjs.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.AUTH_URL?.startsWith("https://") ?? false,
      },
    },
  },

  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
      },

      async authorize(credentials) {
        const email = String(credentials?.email || "")
          .toLowerCase()
          .trim();

        const password = String(credentials?.password || "");

        if (!email || !password) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email },
        });

        // 没这个用户、或者是从没设过密码的账号，一律当登录失败，
        // 不告诉外面「是邮箱错还是密码错」。
        // 但两条失败路径的耗时必须一样：不存在账号时也真跑一次 bcrypt，
        // 堵住「响应快 = 邮箱没注册」的枚举侧信道。
        if (!user?.passwordHash) {
          await verifyPassword(password, DUMMY_PASSWORD_HASH);
          return null;
        }

        const valid = await verifyPassword(password, user.passwordHash);

        if (!valid) {
          return null;
        }

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          // 会话代次：改密码时 +1，旧 Cookie 会在 requireUser() 里被判定为失效
          tokenVersion: user.tokenVersion,
        };
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user }) {
      // 只在真正登录那一次会带 user，之后每次请求都是拿旧 token 续期，
      // 所以这几项只在有 user 时写一次即可。
      if (user) {
        token.userId = user.id;
        token.tokenVersion = user.tokenVersion ?? 0;
      }

      return token;
    },

    async session({ session, token }) {
      if (session.user) {
        if (token.userId) {
          session.user.id = String(token.userId);
        }

        session.user.tokenVersion =
          typeof token.tokenVersion === "number" ? token.tokenVersion : 0;
      }

      return session;
    },
  },

  pages: {
    signIn: "/login",
  },
});
