import bcrypt from "bcryptjs";

/**
 * 密码加密与校验。
 *
 * 数据库里从不存明文密码，只存 bcrypt 哈希。
 * 12 轮是折中值：够慢（暴力破解成本高），又不至于让登录明显卡顿。
 */
export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  passwordHash: string
) {
  return bcrypt.compare(password, passwordHash);
}
