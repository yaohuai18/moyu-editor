import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      /** 会话代次，见 schema 里 User.tokenVersion 的说明 */
      tokenVersion?: number;
    };
  }

  interface User {
    /** 登录时从数据库带出来，写进 JWT */
    tokenVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    tokenVersion?: number;
  }
}
