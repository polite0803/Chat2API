/**
 * 聚合目录里少数端点的服务条款冲突提示。
 *
 * 这三条都是**逐字复核过原文**的（复核日期见 `asOf`，出处见 `docUrl`）。判定标准只有一条：
 * 我没能从官方页面读到那句话，就不写进这里——宁可少标一家，也不替厂商编一条限制。
 * 因此 `zai`（`api.z.ai/api/coding/paas/v4`，端点形状与智谱套餐同源）暂未列入：
 * 它的 devpack 页面没有对偶条款，需要另找条款页后补。
 *
 * 用户裁定（2026-10-29）：**条目保留 + 显式条款警告**，不停服务、不撤目录。
 * 本仓不做任何客户端指纹伪装来绕过这些限制。
 */

export type TermsScope = 'all-requests' | 'free-tier-models'

export interface AggregateTermsWarning {
  entryId: string
  /** 这条限制在什么情况下咬人 */
  scope: TermsScope
  /** 厂商原文，逐字引用 */
  quote: string
  /** 我实际读到那句话的页面 */
  docUrl: string
  /** 复核日期 */
  asOf: string
}

export const AGGREGATE_TERMS_WARNINGS: AggregateTermsWarning[] = [
  {
    entryId: 'opencode_zen',
    scope: 'free-tier-models',
    quote: 'Free-tier chat models require OpenCode; use paid models or Go from other clients.',
    docUrl: 'https://opencode.ai/docs/zen',
    asOf: '2026-10-29',
  },
  {
    entryId: 'qwencloud_coding',
    scope: 'all-requests',
    quote:
      "This plan is for interactive use in programming tools such as Claude Code, Qoder, Qoder CN, and OpenClaw. Do not use the plan's API key for automated scripts, application backends, or other non-interactive scenarios. Using the API key outside the permitted scope is a violation that may result in subscription suspension or API key revocation.",
    docUrl: 'https://www.alibabacloud.com/help/en/model-studio/coding-plan',
    asOf: '2026-10-29',
  },
  {
    entryId: 'glm-cn',
    scope: 'all-requests',
    quote: '套餐仅限在官方支持的指定工具与产品环境中使用。在除规定工具外调用 API，不可享用 Coding 套餐的额度。',
    docUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
    asOf: '2026-10-29',
  },
]

const WARNINGS_BY_ENTRY = new Map(AGGREGATE_TERMS_WARNINGS.map(w => [w.entryId, w]))

export function getTermsWarning(entryId: string): AggregateTermsWarning | undefined {
  return WARNINGS_BY_ENTRY.get(entryId)
}

/** 只受免费档约束的条目，配上具体免费模型数才能说清"哪几个模型不能这样用"。 */
export function termsWarningModelIds(
  warning: AggregateTermsWarning,
  freeModelIds: string[]
): string[] {
  return warning.scope === 'free-tier-models' ? freeModelIds : []
}
