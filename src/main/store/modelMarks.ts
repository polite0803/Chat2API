/**
 * 手工能力标注的归一与合并。
 *
 * 手工标注是 `userModelMarks` 里的一层，路由解析时**叠加在**自动标注之上。
 * 两条规则决定了本文件的所有实现：
 *
 * - **只覆盖写了的字段。** 用户只把 `vision` 改成 `no`，`tools` / `contextTokens`
 *   仍然走自动标注；把整条记录当成完整快照会把没写的字段一起清成未知。
 * - **`unknown` 不是可标注的值。** 三态里的 `unknown` 表示「没有证据」，用户想
 *   表达它只能删掉这条标注（清空后回到自动结果），所以写入时把 `unknown` 当作
 *   未写，而不是存一个 `unknown` 进去再遮住自动证据。
 */
import type { InputModality, ModelCapabilityHint } from '../../shared/types.ts'

const TIERS = new Set(['fast', 'balanced', 'strong'])
const STATES = new Set(['yes', 'no'])
const MODALITIES = new Set<InputModality>(['text', 'image', 'audio', 'video', 'pdf'])

/** 上下文窗口的合理上界：防止手滑输入 1e12 让「长上下文」策略永远命中 */
const MAX_CONTEXT_TOKENS = 100_000_000

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined
}

/**
 * 把来自 IPC 的未知输入收敛成一条可存储的标注；没有有效字段时返回 `undefined`
 * （调用方据此删除该条，而不是存一个空对象遮住自动标注）。
 */
export function normalizeModelMark(input: unknown): ModelCapabilityHint | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const raw = input as Record<string, unknown>

  const mark: ModelCapabilityHint = {}

  if (typeof raw.tier === 'string' && TIERS.has(raw.tier)) {
    mark.tier = raw.tier as ModelCapabilityHint['tier']
  }
  for (const field of ['vision', 'tools', 'reasoning'] as const) {
    const value = raw[field]
    if (typeof value === 'string' && STATES.has(value)) {
      mark[field] = value as 'yes' | 'no'
    }
  }
  if (Array.isArray(raw.modalities)) {
    const modalities: InputModality[] = []
    for (const entry of raw.modalities as unknown[]) {
      if (typeof entry !== 'string' || !MODALITIES.has(entry as InputModality)) continue
      if (!modalities.includes(entry as InputModality)) modalities.push(entry as InputModality)
    }
    if (modalities.length > 0) mark.modalities = modalities
  }
  const contextTokens = positiveInt(raw.contextTokens)
  if (contextTokens !== undefined && contextTokens <= MAX_CONTEXT_TOKENS) {
    mark.contextTokens = contextTokens
  }
  if (typeof raw.weight === 'number' && Number.isFinite(raw.weight) && raw.weight >= 0) {
    mark.weight = raw.weight
  }
  if (typeof raw.free === 'boolean') {
    mark.free = raw.free
  }

  return Object.keys(mark).length === 0 ? undefined : mark
}
