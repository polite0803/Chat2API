/**
 * 从上游 usage 对象里读"缓存命中"，并判定它与 `prompt_tokens` 的**关系**。
 *
 * ## 为什么必须判关系，而不是读到就往上填
 *
 * DSH 内部的 `TokenUsage.inputTokens` 约定是**不含缓存**的（网关
 * `openai-gateway/usage.ts::toOpenAiUsage` 会把 `cacheReadTokens` 与
 * `cacheWriteTokens` 再加回总输入）。而上游的缓存字段有两 families，语义**相反**：
 *
 * | 上游写法 | 与 `prompt_tokens` 的关系 | 正确做法 |
 *|---|---|---|
 * | `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`（OpenAI 系） | **子集**：已含在 prompt 里 | `inputTokens = prompt - cached` |
 * | `cache_read_input_tokens`（Anthropic 系） | **并列**：prompt 不含它 | `inputTokens = prompt`，不减 |
 *
 * 把子集当成并列填 → 网关加回去 → **缓存双计**，上下文虚高、客户端提前压缩；
 * 把并列当成子集填 → 双扣，上下文恒定偏小、自动压缩永不触发。两个方向都是
 * `openai-gateway/usage.ts` 文件头那份 2026-10-04 用户报障的原样重现，所以这里
 * 一次判错就等于把那个缺陷再种进一个 provider。
 *
 * 判据取**字段名**而不是猜 provider：字段名就是上游自己声明的口径，且比"哪个
 * 适配器"更稳 —— 同一个 provider 换网关、或把 Anthropic 端点接成 OpenAI 形状时，
 * provider 名不变而口径会变。
 *
 * ⚠️ 读不到就是 `cachedTokens: undefined`，**不是 0**。`0` 是一个断言（"这轮没命中"），
 * 缺省才是事实（"上游没告诉我们"）。绝大多数渠道不报 usage，也就都不报命中；把它们
 * 记成 0 会让仪表盘宣称"缓存没用上"，而我们并没有这个测量。
 *
 * 本模块**零依赖**，因此可以被 `node --test` 直接 import（vendor 里带 TS 参数属性
 * 的文件做不到这点，必须走 esbuild）。
 */

/** 一次缓存读取的结果。 */
export interface CachedInputReading {
  /** 命中的 token 数；上游没报时 `undefined`。 */
  cachedTokens: number | undefined
  /** 该字段是否已被 `prompt_tokens` 包含（OpenAI 系为 true，Anthropic 系为 false）。 */
  subsetOfPrompt: boolean
  /** 命中的 token 数（Anthropic 系另有写入侧；这里只读命中）。 */
  cacheWriteTokens?: number
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/**
 * @param usage 上游 usage 对象（未知形状，绝不抛错）。
 */
export function readCachedInput(usage: Record<string, unknown> | undefined | null): CachedInputReading {
  if (!usage || typeof usage !== 'object') return { cachedTokens: undefined, subsetOfPrompt: false }

  // OpenAI 系：`prompt_tokens_details.cached_tokens` 是 `prompt_tokens` 的子集。
  const details = usage.prompt_tokens_details
  const inDetails = details && typeof details === 'object'
    ? positive((details as Record<string, unknown>).cached_tokens)
    : undefined
  // 部分平铺网关（vLLM / DashScope 风格）用 `prompt_cache_hit_tokens`，同样是子集。
  const flat = positive(usage.prompt_cache_hit_tokens)
  const subset = inDetails ?? flat
  if (subset !== undefined) return { cachedTokens: subset, subsetOfPrompt: true }

  // Anthropic 系：`cache_read_input_tokens` 与 `input_tokens` 并列，另算。
  const read = positive(usage.cache_read_input_tokens)
  if (read !== undefined) {
    const write = positive(usage.cache_creation_input_tokens)
    return {
      cachedTokens: read,
      subsetOfPrompt: false,
      ...(write !== undefined ? { cacheWriteTokens: write } : {}),
    }
  }

  return { cachedTokens: undefined, subsetOfPrompt: false }
}

/**
 * 按读到的口径算出 DSH 内部该填的未命中输入。
 *
 * 下限夹 0：万一上游报出 `cached > prompt`（各家实现里都见过，通常是它把写入
 * 也算进了 cached），宁可得 0 也不返回负数 —— 负输入会一路污染账本求和。
 */
export function uncachedInput(promptTokens: number, reading: CachedInputReading): number {
  const prompt = Number.isFinite(promptTokens) && promptTokens > 0 ? Math.trunc(promptTokens) : 0
  if (!reading.subsetOfPrompt || reading.cachedTokens === undefined) return prompt
  return Math.max(0, prompt - reading.cachedTokens)
}
