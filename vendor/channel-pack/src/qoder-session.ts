/**
 * Qoder **会话身份**的派生与识别（纯函数，无任何 import）。
 *
 * ## 为什么需要它（实测症状）
 *
 * 旧实现每次 `stream()` 都写 `session_id: crypto.randomUUID()`（见
 * `qoder-wasm.ts` 的 `buildQoderInferPayload`）。而这条适配器**每轮都重发
 * 全量历史**（`buildQoderHistory` 不做裁剪），于是每一轮都是一次全新的
 * 服务端会话 + 一次全量 prefill：
 *
 * - 服务端既没有会话记忆（它拿不到"上一轮已经算过这些前缀"的信号）；
 * - 前缀缓存按会话/请求身份分桶时也命中不了（每轮 id 都不同）；
 * - 任务越长，每轮要重新 prefill 的字节越多 —— 这正是"经本应用走 Qoder
 *   明显比 IDE 慢"的主要成因（IDE 在同一会话里发增量）。
 *
 * 故这里改为**按会话身份确定性派生**：同一段对话（同一模型、同一账号、
 * 同一 system、同一首条 user 文本）恒得到同一个 `session_id`。
 *
 * ## 与 Gemini 那份派生的关系
 *
 * 依赖维度照抄 `gemini.ts` 的 `deriveGeminiSessionId`：**吃** model / 账号 /
 * system / 首条 user 文本，**不吃**轮数、后续文本、机器特征。差别只有两点：
 *
 * 1. 输出形态不同 —— Qoder 的 `session_id` 在官方客户端里是 **UUID 字符串**
 *    （旧实现就是 `randomUUID()`），故这里也输出 UUID v4 形态，不输出十进制；
 * 2. **哈希函数与常量都不与官方一致**（我们只知道客户端字段的形状，不知道它
 *    的派生算法）。本函数保证的是"同输入同输出"这一**语义**，不是数值复刻。
 *
 * ## `generation`（会话换代自愈）
 *
 * 服务端可能对**同一** session_id 做累计记账（Gemini 就是按 sessionId 累计
 * 输入、累计过 1M 后该 id 的每个请求都 400）。若 Qoder 也如此，恒定 session
 * 会把一个会话慢慢推到上限。故保留 `generation`：
 *
 * - `0`（或省略）**不参与哈希** —— 必须与引入换代前逐字同值，否则这个功能
 *   一上线就让所有进行中的对话换一次 session，反而把缓存全丢掉；
 * - `> 0` 才拼进哈希输入，得到一个全新会话（对话无感恢复）。
 *
 * 换代由适配器在**拿到阳性证据**时触发（见 `looksLikeSessionConflict`），
 * 不做无条件升代。
 */

/**
 * 派生输入。
 *
 * ⚠️ 缺省字段用 `null` 参与哈希，**不能**与空串混同：`systemText` 未下发与
 * 下发空串是两种语义，混同会让两类请求落到同一个服务端会话。
 */
export interface QoderSessionSeed {
  /** 目录 key（`qfmodel` / `dmodel` / …）。不同模型必须是不同会话。 */
  modelKey: string
  /**
   * 账号标识（优先 `uid`）。
   *
   * ⚠️ **不同账号必须派生不同会话**：额度与计费是「账号 + 模型」维度，
   * 两个账号共用一个服务端会话会把记账与缓存都搅在一起。
   */
  accountSeed?: string
  /** 系统提示（整段对话不变的那段）。 */
  systemText?: string
  /** **首条** user 文本（不是最后一条 —— 那是"本轮提问"，每轮都变）。 */
  firstUserText?: string
  /** 会话代数；`0` / 省略表示不换代。 */
  generation?: number
}

/** 域分隔标记，避免与其它派生函数的输入空间相撞。 */
const SESSION_DOMAIN = 'chat2api-qoder-session-v1'

/** FNV-1a 64 位（BigInt，避免 2^53 精度丢失）。 */
function fnv1a64(input: string, basis: bigint): bigint {
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  let hash = basis & mask
  for (const byte of Buffer.from(input, 'utf8')) {
    hash = (hash ^ BigInt(byte)) & mask
    hash = (hash * prime) & mask
  }
  return hash
}

/** 把一个 BigInt 按 32 位切成 nibble 字符串（定长 16 个十六进制字符）。 */
function hex32(value: bigint): string {
  return (value & 0xffffffffn).toString(16).padStart(8, '0')
}

/**
 * 按会话身份派生 `session_id`（UUID v4 形态）。
 *
 * 四次不同基数的 FNV-1a 拼成 128 位，再按 RFC 4122 打上版本位（`4`）与
 * 变体位（`8`/`9`/`a`/`b`）—— 只是为了让产物在形态上与旧实现一致，不是
 * 声称它与官方的随机 UUID 同分布。
 *
 * @param seed - 见 {@link QoderSessionSeed}。
 * @returns 形如 `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` 的**确定性**字符串。
 */
export function deriveQoderSessionId(seed: QoderSessionSeed): string {
  const generation = seed.generation !== undefined && seed.generation > 0 ? seed.generation : null
  // 用 JSON 元组而不是分隔符拼接：分隔符方案会让 `a|b` 与 `a` + `|b` 相撞，
  // 而这里每个位置都有确定的类型（string | null | number），编码是单射的。
  const input = JSON.stringify([
    SESSION_DOMAIN,
    seed.modelKey,
    seed.accountSeed ?? null,
    seed.systemText ?? null,
    seed.firstUserText ?? null,
    generation,
  ])
  const a = hex32(fnv1a64(input, 0xcbf29ce484222325n))
  const b = hex32(fnv1a64(input, 0x9e3779b97f4a7c15n))
  const c = hex32(fnv1a64(input, 0x6a09e667f3bcc908n))
  const d = hex32(fnv1a64(input, 0xbb67ae8584caa73bn))
  const variant = (Number.parseInt(d.slice(0, 1), 16) & 0x3) | 0x8
  return `${a}-${b.slice(0, 4)}-4${b.slice(4, 7)}-${variant.toString(16)}${c.slice(0, 3)}-${c.slice(3, 8)}${d.slice(1, 8)}`
}

/**
 * 从 wire 消息里取**首条** user 文本（会话身份的主判据）。
 *
 * ⚠️ 必须取首条而不是最后一条：最后一条是"本轮提问"，每轮都不同 ——
 * 用它派生等于每轮换一个新会话，与会话复用的目的正好相反。
 *
 * 取不到时返回 `''`：此时派生仍会进行（会话身份退化为"该模型 + 该账号的
 * 首个会话"），不会因为缺文本而崩溃或退回随机 id。
 */
export function firstUserTextOf(messages: readonly { role?: unknown; content?: unknown }[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    return qoderContentText(message.content)
  }
  return ''
}

/**
 * 把 wire 消息的 content 归一化为字符串（工具调用消息的正文是空串）。
 *
 * ⚠️ 与适配器共用**同一份**实现（适配器从本模块导入）：两处各写一份必然
 * 漂移，而漂移的症状是"会话身份按 A 口径派生、请求体按 B 口径序列化"。
 */
export function qoderContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text: unknown } =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
      .map((block) => String(block.text))
      .join('')
  }
  // `null`（assistant 只带 tool_calls 时的 OpenAI 规范值）与畸形值都退化为空串：
  // 客户端 `t2c()` 的 content 恒为字符串（`udn(r, '')`）。
  return ''
}

/**
 * 上游错误文本是否**像会话冲突**（→ 值得换一个全新 session 重试一次）。
 *
 * ## 为什么判据必须是窄正则，而不是"任何失败都升代"
 *
 * 无条件升代有两个后果，都比症状本身更糟：
 *
 * 1. 每次失败都换会话 → 前缀缓存永远建立不起来，本模块的目的当场消失；
 * 2. 掩盖真实原因 —— 排队（10605）、额度（110）、套餐（112）都已有各自的
 *    **正确**处置路径（见 `model-queue.ts` / `qoder-plan-gate.ts`），把它们
 *    一并当成"会话冲突"会反复重打，反而更慢。
 *
 * 故只认「服务端明确在讲会话/上下文长度」的那几种措辞。命中后适配器仍会
 * 复核三个前提（未发出任何 chunk、未用过兜底额度、复用开关打开）。
 *
 * @param text - 上游错误体原文（可能是 `[FAIL]node:… msg:…` 这类半结构化文本）。
 */
export function looksLikeSessionConflict(text: string): boolean {
  if (text.length === 0) return false
  return /session\s*(id)?\s*(not\s+found|expired|invalid|conflict|closed|mismatch)/i.test(text)
    || /invalid\s+session/i.test(text)
    || /context\s*length/i.test(text)
    || /maximum\s+number\s+of\s+tokens\s+allowed/i.test(text)
    || /input\s+(?:is\s+)?too\s+long/i.test(text)
    || /range\s+of\s+input\s+length/i.test(text)
    || /token\s+count\s+exceeds/i.test(text)
}
