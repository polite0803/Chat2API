/**
 * 供应商卡片上「已启用 / 全部」那对账号数字。
 *
 * 两个来源必须分开算，因为它们根本不是同一份数据：
 *
 * - 内置 / 聚合 / 自定义供应商：账号就在本地 `accounts` 表里，照表计数即可。
 * - 账号渠道（`type: 'account'`）：真实账号池在渠道 Worker 内（它自己的
 *   `state.json`），本地只有 `accountChannels/manager.ts` 的 `ensureLocalAccount`
 *   建的那**一条**空凭据占位账号 —— 它存在的唯一目的是让负载均衡「有账号可路由」，
 *   真正的选号发生在 Worker 的池里。
 *
 * 所以照本地表给渠道计数，卡片上就永远是 1，而 /channels 页显示的是池里的真实
 * 数量（同一家渠道挂了两个号就是 2）。两页对不上不是缓存问题，是数据源选错了。
 *
 * ⚠️ 池子读不到时**保留**本地计数而不是写 0：Worker 起不来不代表这家渠道没连上
 * 账号，把已连接的渠道显示成「0 个账号」比显示占位账号更误导人。
 */

/** 一家供应商的账号计数：`active` 是「可用」，口径随供应商类型而定。 */
export interface AccountCount {
  total: number
  active: number
}

export type AccountCounts = Record<string, AccountCount>

/**
 * 渠道 Worker 报的池内计数。
 *
 * `enabled` 就是渠道包的判据（`enabled !== false` 即启用，缺字段等同启用），
 * 也正是 /channels 页上 `accounts.enabled/accounts.total` 里那个分子 —— 即
 * 「这个号会不会被池子选中」。
 */
export interface ChannelPoolCount {
  total: number
  enabled: number
}

interface CountingProvider {
  id: string
  type: string
}

interface CountingAccount {
  providerId: string
  status: string
}

/** 本地账号表里的计数；对渠道而言这就是那一条占位账号。 */
export function localAccountCounts(
  providers: readonly CountingProvider[],
  accounts: readonly CountingAccount[],
): AccountCounts {
  const counts: AccountCounts = {}
  for (const provider of providers) {
    const own = accounts.filter(account => account.providerId === provider.id)
    counts[provider.id] = {
      total: own.length,
      active: own.filter(account => account.status === 'active').length,
    }
  }
  return counts
}

/**
 * 用渠道 Worker 的真实账号池覆盖 `type === 'account'` 的供应商。
 *
 * 池里没有这家渠道（Worker 未启动、`provider.status` 失败、或渠道定义已下线）
 * 时保持入参里的计数，不做任何猜测。非渠道供应商一律不受影响 —— 它们的账号
 * 确实在本地表里，照表计数是对的。
 */
export function mergeChannelCounts(
  counts: AccountCounts,
  providers: readonly CountingProvider[],
  pool: Readonly<Record<string, ChannelPoolCount>>,
): AccountCounts {
  const merged: AccountCounts = { ...counts }
  for (const provider of providers) {
    if (provider.type !== 'account') continue
    const poolCount = pool[provider.id]
    if (poolCount === undefined) continue
    merged[provider.id] = { total: poolCount.total, active: poolCount.enabled }
  }
  return merged
}
