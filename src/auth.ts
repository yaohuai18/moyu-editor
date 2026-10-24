import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";

export const { handlers, signIn, signOut, auth } = NextAuth({
  // 本地跑的是 http://localhost:3001，反向代理/端口转发场景下
  // Auth.js 需要一个明确的信任标记，否则会报 UntrustedHost。
  // 部署到正式域名后，把这个换成 AUTH_URL 环境变量更稳妥。
  trustHost: true,

  session: {
    // 会话数据加密后存在 Cookie 里，服务端不落库。
    // 好处：下线/重启不掉登录；代价：改密码后旧 Cookie 不会立刻失效。
    strategy: "jwt",
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
        if (!user?.passwordHash) {
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
