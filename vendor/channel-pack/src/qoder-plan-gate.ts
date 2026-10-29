/**
 * Qoder「套餐档位」闸门（业务码 `112`）的识别与可读文案。
 *
 * ## 实测形态（用户报障 2026-10-29，CN 渠道）
 *
 * 请求 `qodercn/dfmodel`（DeepSeek-Flash）时，上游在 **HTTP 200 的 SSE 流里**
 * 回了这样一帧（`qoder-envelope.ts` 把信封剥掉后原样转发）：
 *
 * ```json
 * { "code": 112,
 *   "message": "{\"isHighestTier\":false,\"pricingUrl\":\"https://qoder.com.cn/pricing?client=qoder\"}" }
 * ```
 *
 * 同一账号的 `qodercn/qfmodel`（Qwen3.8-Flash，免费档）**同时可用** ——
 * 故 `112` 是「这个模型要求更高套餐档位」的**权限闸门**，不是账号失效
 * （`105` / 401），也不是当日额度用尽（`110`）。
 *
 * ## 为什么必须单独识别
 *
 * 旧实现没有这个码，`consumeOpenAiSse` 把它归到 `SERVER`，于是：
 *
 * - 客户端看到的是**一坨裸 JSON** + `(112/model_error)`（真实症状：
 *   `qoder: {"isHighestTier":false,…} (112/model_error)`），完全读不出
 *   「要升级套餐」，更不知道去哪升级；
 * - `SERVER` **在** harness 的 `DEFAULT_RETRYABLE_CODES` 里 → 白退避重试
 *   5 次（500/1000/2000/4000/8000 ≈ 15.5 秒）。而套餐档位是**确定性**状态：
 *   重试一万次仍是同一份 `isHighestTier:false`，与 `110`（额度）同型但更绝对
 *   —— 额度至少会按自然日重置。
 *
 * ## 判据口径（与 `looksLikeBillingError` 同源）
 *
 * **码值 + 载荷字段名**两条并列，任一命中即认定：
 *
 * - 码值 `112`：上游明说的业务码（字符串/数字两种编码都见过）；
 * - 载荷字段 `isHighestTier` / `pricingUrl`：这两个键只在套餐闸门载荷里出现，
 *   不会出现在模型正文或别的错误里（`/api/v2/user/plan` 与
 *   `/sash/api/v2/me/usage` 的响应也带 `isHighestTier`，但那是**正常**响应，
 *   不会被错误通道看到）。
 *
 * ⚠️ **不要**用 `highest` / `upgrade` 之类泛词做判据：模型正文讨论
 * 「升级套餐」是完全可能的，把正常回答判成错误比漏判更糟。
 */

/** 套餐档位闸门的业务码（上游实测下发）。 */
export const PLAN_GATE_BUSINESS_CODE = '112'

/** 业务码是否命中**套餐档位闸门**（兼容字符串与数字两种编码）。 */
export function isPlanGateBusinessCode(code: unknown): boolean {
  return code === PLAN_GATE_BUSINESS_CODE || code === Number(PLAN_GATE_BUSINESS_CODE)
}

/**
 * 文案里是否带**套餐闸门载荷**。
 *
 * 只认两个专属字段名，见文件头「判据口径」。
 */
export function looksLikePlanGate(text: string): boolean {
  return /isHighestTier|pricingUrl/i.test(text)
}

/**
 * 从载荷里取升级/价格链接。
 *
 * 两种来源都要认：
 * - **单层对象**：`{"isHighestTier":false,"pricingUrl":"https://…"}`（HTTP body 形态）；
 * - **嵌套字符串**：`message` 本身是上面那段 JSON 的字符串（SSE 帧形态）。
 *   此时 `JSON.parse` 拿到的对象没有 `pricingUrl`，靠正则兜底。
 *
 * @returns 绝对 http(s) 链接；没有时 `undefined`（**绝不编造**）。
 */
export function planGatePricingUrl(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { pricingUrl?: unknown }
    if (typeof parsed.pricingUrl === 'string' && parsed.pricingUrl.length > 0) {
      return parsed.pricingUrl
    }
  } catch {
    // 不是 JSON：退回正则（也覆盖「JSON 字符串里再嵌一层」的形态）。
  }
  const match = /https?:\/\/[^\s"'\\]+/i.exec(text)
  return match?.[0]
}

/**
 * 给用户看的**可读**错误文案（替代上游那坨裸 JSON）。
 *
 * 形如：
 * `当前账号不是最高档订阅，该模型需要升级 Qoder 套餐后才能使用（112）：https://…`
 *
 * @param text - 上游原始错误体（JSON 或 JSON 字符串）。
 */
export function planGateMessage(text: string): string {
  // 措辞跟载荷走：带 `isHighestTier` 时才断言「不是最高档订阅」，
  // 否则只说「套餐不支持」——不把推测写进用户可见文案。
  const reason = /isHighestTier/i.test(text)
    ? '当前账号不是最高档订阅'
    : '当前套餐档位不支持该模型'
  const url = planGatePricingUrl(text)
  const base = `${reason}，该模型需要升级 Qoder 套餐后才能使用（${PLAN_GATE_BUSINESS_CODE}）`
  return url === undefined ? base : `${base}：${url}`
}
