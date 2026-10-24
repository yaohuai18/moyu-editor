/**
 * 环境变量体检。
 *
 * 只回答三个问题：**配了没、够不够、有没有配错**。
 * 永远不返回值本身 —— 这个模块的输出会进日志、进 /api/health 响应，
 * 任何一处漏出 DATABASE_URL 或 AUTH_SECRET 都是安全事故。
 *
 * 三类结论：
 *   fatal —— 缺了应用根本跑不起来（数据库地址、会话密钥）
 *   warn  —— 缺了某项功能不可用（AI Key），但网站还能开
 *   ok    —— 没问题
 */

export type EnvLevel = "fatal" | "warn";

export type EnvIssue = {
  /** 出问题的变量名（不是值） */
  key: string;
  level: EnvLevel;
  /** 给人看的中文说明，不含任何敏感值 */
  message: string;
};

export type EnvSummary = {
  nodeEnv: string;
  isProduction: boolean;
  database: {
    configured: boolean;
    /** 只区分「本地文件库」和「网络数据库」，不返回连接串 */
    kind: "sqlite" | "server" | "unknown";
  };
  auth: {
    configured: boolean;
    secretLength: number;
  };
  ai: {
    configured: boolean;
    model: string | null;
  };
};

/** AUTH_SECRET 最低长度：官方建议 32 字节随机值，base64 后是 44 个字符 */
const MIN_AUTH_SECRET_LENGTH = 32;

type EnvLike = Record<string, string | undefined>;

function read(env: EnvLike, key: string) {
  const value = env[key];

  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

/** 数据库地址属于哪种：SQLite 文件（本地）还是网络数据库 */
function databaseKind(url: string): EnvSummary["database"]["kind"] {
  if (!url) {
    return "unknown";
  }

  if (url.startsWith("file:")) {
    return "sqlite";
  }

  if (/^(postgres|postgresql|mysql|mongodb|sqlserver):/i.test(url)) {
    return "server";
  }

  return "unknown";
}

/**
 * 检查所有环境变量，返回问题清单（可能是空的）。
 *
 * 传 env 参数是为了让测试能塞一份假环境进来，正常调用不用传。
 */
export function inspectEnv(env: EnvLike = process.env): EnvIssue[] {
  const issues: EnvIssue[] = [];
  const nodeEnv = read(env, "NODE_ENV") || "development";
  const isProduction = nodeEnv === "production";

  // ---------- 一、必须有的：没有就跑不起来 ----------

  const databaseUrl = read(env, "DATABASE_URL");

  if (!databaseUrl) {
    issues.push({
      key: "DATABASE_URL",
      level: "fatal",
      message: "数据库连接地址未配置，应用无法启动",
    });
  } else if (isProduction && databaseKind(databaseUrl) === "sqlite") {
    issues.push({
      key: "DATABASE_URL",
      level: "warn",
      message:
        "生产环境用的是本地 SQLite 文件库，只适合单机单实例；换多实例部署请改成 Postgres 等网络数据库",
    });
  }

  const authSecret = read(env, "AUTH_SECRET");

  if (!authSecret) {
    issues.push({
      key: "AUTH_SECRET",
      level: "fatal",
      message: "登录会话加密密钥未配置，登录功能会直接报错",
    });
  } else if (authSecret.length < MIN_AUTH_SECRET_LENGTH) {
    issues.push({
      key: "AUTH_SECRET",
      level: "fatal",
      message: `登录会话加密密钥太短（当前 ${authSecret.length} 位，至少要 ${MIN_AUTH_SECRET_LENGTH} 位）`,
    });
  }

  // ---------- 二、缺了只是少个功能：AI ----------

  const aiKey = read(env, "AI_API_KEY");
  const aiModel = read(env, "AI_MODEL");

  if (!aiKey) {
    issues.push({
      key: "AI_API_KEY",
      level: "warn",
      message: "AI 服务密钥未配置，诊断 / 润色功能会返回 503，其余功能不受影响",
    });
  }

  if (!aiModel) {
    issues.push({
      key: "AI_MODEL",
      level: "warn",
      message: "AI 模型名未配置，诊断 / 润色功能会返回 503",
    });
  }

  const aiBaseUrl = read(env, "AI_BASE_URL");

  if (aiBaseUrl.startsWith("http://")) {
    issues.push({
      key: "AI_BASE_URL",
      level: "warn",
      message: "AI 服务地址用的是明文 http，正文会以明文上网，建议换成 https",
    });
  }

  // ---------- 三、配错了：最容易出事的两种错法 ----------

  // NEXT_PUBLIC_ 开头的变量会被编译进浏览器里的 JS。
  // 一旦有人把密钥改成这个前缀，等于把钥匙印在网页上。
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("NEXT_PUBLIC_") || !value) {
      continue;
    }

    if (/(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i.test(key)) {
      issues.push({
        key,
        level: "fatal",
        message:
          "这个变量名以 NEXT_PUBLIC_ 开头，会被打包进浏览器代码里公开，必须改名或删除",
      });
    }
  }

  // ---------- 四、生产环境的额外要求 ----------

  if (isProduction) {
    const authUrl = read(env, "AUTH_URL");
    const trustHost = read(env, "AUTH_TRUST_HOST");

    if (!authUrl && trustHost !== "true") {
      issues.push({
        key: "AUTH_URL",
        level: "warn",
        message:
          "生产环境既没设 AUTH_URL 也没设 AUTH_TRUST_HOST=true，部署到反向代理后登录会报 UntrustedHost",
      });
    }

    if (authUrl.startsWith("http://")) {
      issues.push({
        key: "AUTH_URL",
        level: "warn",
        message: "AUTH_URL 是明文 http，正式站点请用 HTTPS，否则会话 Cookie 拿不到 Secure 保护",
      });
    }
  }

  return issues;
}

/** 体检结论摘要：只说配置齐不齐，不暴露值 */
export function getEnvSummary(env: EnvLike = process.env): EnvSummary {
  const databaseUrl = read(env, "DATABASE_URL");
  const authSecret = read(env, "AUTH_SECRET");
  const nodeEnv = read(env, "NODE_ENV") || "development";

  return {
    nodeEnv,
    isProduction: nodeEnv === "production",
    database: {
      configured: Boolean(databaseUrl),
      kind: databaseKind(databaseUrl),
    },
    auth: {
      configured: Boolean(authSecret),
      secretLength: authSecret.length,
    },
    ai: {
      configured: Boolean(read(env, "AI_API_KEY")) && Boolean(read(env, "AI_MODEL")),
      model: read(env, "AI_MODEL") || null,
    },
  };
}

/** 致命问题（应用跑不起来的那些） */
export function getFatalIssues(env: EnvLike = process.env): EnvIssue[] {
  return inspectEnv(env).filter((issue) => issue.level === "fatal");
}

/**
 * 启动自检：把体检结果打成一段人能看懂的日志。
 *
 * 故意用纯 ASCII 的 [ok] / [warn] / [FATAL] 而不是 ✔ ✗ —— 中文 Windows 的
 * 控制台和日志文件常有编码问题，符号比文字更容易变成乱码。
 */
export function reportEnvOnBoot(env: EnvLike = process.env) {
  const summary = getEnvSummary(env);
  const issues = inspectEnv(env);
  const fatals = issues.filter((issue) => issue.level === "fatal");
  const warns = issues.filter((issue) => issue.level === "warn");

  const lines: string[] = [
    "================ 墨语编辑器 · 启动自检 ================",
    `运行环境 : ${summary.nodeEnv}${summary.isProduction ? "（生产）" : ""}`,
    `数据库   : ${summary.database.configured ? `已配置（${summary.database.kind}）` : "未配置"}`,
    `会话密钥 : ${summary.auth.configured ? `已配置（${summary.auth.secretLength} 位）` : "未配置"}`,
    `AI 服务  : ${summary.ai.configured ? `已配置（${summary.ai.model}）` : "未配置（诊断/润色不可用）"}`,
  ];

  for (const issue of warns) {
    lines.push(`[warn]  ${issue.key}：${issue.message}`);
  }

  for (const issue of fatals) {
    lines.push(`[FATAL] ${issue.key}：${issue.message}`);
  }

  if (fatals.length === 0 && warns.length === 0) {
    lines.push("[ok]    环境检查全部通过");
  }

  lines.push("======================================================");

  // 有致命问题用 error 级别，方便部署平台按级别告警
  if (fatals.length > 0) {
    console.error(lines.join("\n"));
  } else {
    console.log(lines.join("\n"));
  }

  return { summary, issues };
}
