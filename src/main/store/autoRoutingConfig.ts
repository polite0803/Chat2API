/**
 * Normalisation for the virtual `auto` model's routing configuration.
 *
 * Kept apart from `store.ts` so it can be tested without electron: a
 * hand-edited `data.json` must never push the router into absurd values.
 */
import type { AutoRoutingConfig } from '../../shared/types.ts'
import {
  AUTO_PREFERENCES,
  DEFAULT_AUTO_ROUTING_CONFIG,
} from '../../shared/types.ts'

export function normalizeAutoRoutingConfig(input?: Partial<AutoRoutingConfig>): AutoRoutingConfig {
  const merged = { ...DEFAULT_AUTO_ROUTING_CONFIG, ...(input || {}) }
  const attempts = Number(merged.maxAttempts)
  const sticky = Number(merged.stickyMinutes)
  return {
    enabled: merged.enabled !== false,
    maxAttempts: Number.isFinite(attempts)
      ? Math.min(5, Math.max(1, Math.round(attempts)))
      : DEFAULT_AUTO_ROUTING_CONFIG.maxAttempts,
    stickyMinutes: Number.isFinite(sticky)
      ? Math.min(1440, Math.max(0, Math.round(sticky)))
      : DEFAULT_AUTO_ROUTING_CONFIG.stickyMinutes,
    // 非法偏好回落默认值，而不是让一次手写配置把路由打回未知分支
    prefer: AUTO_PREFERENCES.includes(merged.prefer)
      ? merged.prefer
      : DEFAULT_AUTO_ROUTING_CONFIG.prefer,
  }
}
