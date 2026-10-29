/**
 * Auto 模型路由 - 纯决策逻辑
 *
 * 本文件不依赖 electron / electron-store，以便在 node:test 中直接验证；
 * 供应商、账号、模型的数据采集与冷却状态见 autoRouter.ts。
 */

import type { ChatCompletionRequest, ChatMessage } from './types'
import type { AutoModelTier, AutoPreference, CapabilityState, ModelCapabilityHint } from '../../shared/types'
import type { CostBucket } from '../../shared/channels.ts'
import { providerDefaultCapability, staticCapabilityHint } from './modelCapabilities.ts'

export type AutoComplexity = 'simple' | 'standard' | 'complex'
/** 与 loadBalanceStrategy 保持一致，用于选择打分口径 */
export type AutoRoutingStrategy = 'round-robin' | 'fill-first' | 'failover' | 'smart' | 'pace'

/**
 * 请求里会改变响应形状、不能靠提示词补上的要求。
 * 与 `parameterPolicy` 同一口径：内置供应商丢弃 `response_format`、
 * 对 `n > 1` 直接 400，所以这两项要按供应商类型筛选目标。
 */
export interface ContractNeeds {
  multiChoice: boolean
  structuredOutput: boolean
}

export function contractNeeds(request: ChatCompletionRequest): ContractNeeds {
  const raw = request as unknown as Record<string, unknown>
  const format = raw.response_format as { type?: unknown } | undefined
  const type = typeof format?.type === 'string' ? format.type : ''
  return {
    multiChoice: typeof request.n === 'number' && request.n > 1,
    structuredOutput: type === 'json_object' || type === 'json_schema',
  }
}

export function needsContractFilter(needs: ContractNeeds): boolean {
  return needs.multiChoice || needs.structuredOutput
}

/**
 * 该供应商能否完整满足这些契约。只有内置供应商被确认做不到；
 * 聚合与自定义原样透传（`parameterPolicy.findUnsupportedParameter` 只拦内置）。
 */
export function providerMeetsContract(providerType: string | undefined, needs: ContractNeeds): boolean {
  if (providerType !== 'builtin') return true
  return !needs.multiChoice && !needs.structuredOutput
}

export interface ContractOutcome {
  /** 实际参与排序的候选 */
  pool: RankCandidate[]
  /** 为路由成功而放宽的契约，调用方必须写进响应头 */
  degraded: string[]
  /** 没有候选能满足、必须拒绝的契约 */
  missing: string[]
}

/**
 * 契约过滤：
 * - 有候选能完整满足 → 只在它们里面挑；
 * - 一个都没有 → `n > 1` 记为 missing（交给调用方按既有 400 拒绝），
 *   `response_format` 记为 degraded 并照常路由（自由文本比不可用更接近用户想要）。
 */
export function applyContractFilter(candidates: RankCandidate[], needs: ContractNeeds): ContractOutcome {
  if (!needsContractFilter(needs)) {
    return { pool: candidates, degraded: [], missing: [] }
  }

  const capable = candidates.filter(candidate => candidate.contractCapable === true)
  if (capable.length > 0) {
    return { pool: capable, degraded: [], missing: [] }
  }

  if (needs.multiChoice) {
    return { pool: [], degraded: [], missing: ['n'] }
  }

  return { pool: candidates, degraded: ['response_format'], missing: [] }
}

/** 单个模型的能力描述，用于硬过滤与档位打分 */
export interface ModelCapability {
  tier: AutoModelTier
  vision: CapabilityState
  tools: CapabilityState
  /** 上下文窗口；`undefined` 表示未知（不是 0） */
  contextTokens?: number
}

/** 由请求体推导出的路由画像 */
export interface RequestProfile {
  needsVision: boolean
  needsTools: boolean
  estimatedTokens: number
  complexity: AutoComplexity
  stream: boolean
}

/** 排名的输入：一个 (账号, 模型) 组合 */
export interface RankCandidate {
  providerId: string
  providerName: string
  displayName: string
  actualModelId: string
  accountId: string
  todayUsed?: number
  dailyLimit?: number
  lastUsed?: number
  /** 当前在途请求数 */
  inFlight?: number
  /** 最近 60 秒内的尝试次数 */
  rpmUsed?: number
  /** 账号自身声明的每分钟请求上限，未声明则按候选集合内的相对负载计算 */
  rpmLimit?: number
  /** 冷却截止时间戳，<= now 表示可用 */
  coolingUntil?: number
  /**
   * 供应商记录里这个模型自己的标注（账号渠道写入，或聚合目录推导）。
   * 优先级高于静态表；缺省即未知。
   */
  capabilityHint?: ModelCapabilityHint
  /** 该供应商能否满足本次请求的契约（`n > 1` / `response_format`），由采集层填入 */
  contractCapable?: boolean
  /** 成本档；缺省按 unknown 参与打分（中性） */
  costBucket?: CostBucket
}

export interface RankOptions {
  now?: number
  /** 最多返回多少个候选（失败切换次数上限），默认 3 */
  limit?: number
  /** 分散度种子，每次请求递增以打散同分候选 */
  seed?: number
  /** 打分口径，默认与服务端的 loadBalanceStrategy 一致 */
  strategy?: AutoRoutingStrategy
  /** 优化目标，默认 balanced */
  prefer?: AutoPreference
  /** 同一会话上次成功的候选，作为加分项而不是硬钉 */
  sticky?: StickyHint
}

export interface StickyHint {
  providerId: string
  displayName: string
  accountId: string
}

const TIER_RANK: Record<AutoModelTier, number> = {
  fast: 0,
  balanced: 1,
  strong: 2,
}

const TIER_TARGET: Record<AutoComplexity, number> = {
  simple: 0,
  standard: 1,
  complex: 2,
}

export type { AutoModelTier, CapabilityState, ModelCapabilityHint } from '../../shared/types'

/**
 * 上下文窗口未知的模型按这个值做硬过滤（D2：维持既有 64000）。
 * 它只是一个保守上界，不是对真实窗口的声明，也不写进任何响应。
 */
export const UNANNOTATED_CONTEXT_FLOOR = 64000

/** 在线同步来的未知模型按名字猜档位，猜错只影响档位匹配，不影响可用性 */
const FAST_NAME_PATTERN = /(flash|turbo|mini|lite|fast|air|small|\d+b|a\d+b)/
const STRONG_NAME_PATTERN = /(max|pro|expert|ultra|opus|thinking|reason)/

const VISION_PART_TYPES = new Set(['image_url', 'input_image', 'image', 'file'])
const IMAGE_TOKEN_ESTIMATE = 1024
const LONG_CONTEXT_TOKEN_THRESHOLD = 24000
const IDLE_WINDOW_MS = 5 * 60 * 1000

/**
 * 成本档 → 打分因子。口径同 `costBucketOf`：未知单独成档，取中性 0.5，
 * 既不奖励也不惩罚（没有倍率不等于免费）。
 */
const COST_SCORE: Record<CostBucket, number> = {
  free: 1,
  'below-base': 0.75,
  base: 0.5,
  unknown: 0.5,
  'above-base': 0.25,
}

function isVisionPart(part: unknown): boolean {
  if (!part || typeof part !== 'object') return false
  const type = (part as { type?: string }).type
  return typeof type === 'string' && VISION_PART_TYPES.has(type)
}

function messageText(message: ChatMessage): string {
  const content = message.content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter(part => (part as { type?: string }).type === 'text')
      .map(part => (part as { text?: string }).text || '')
      .join(' ')
  }
  return ''
}

function estimateTokens(text: string): number {
  if (!text) return 0
  const cjkMatches = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g)
  const cjkCount = cjkMatches ? cjkMatches.length : 0
  const otherCount = text.length - cjkCount
  return Math.ceil(cjkCount + otherCount / 4)
}

/**
 * 从请求推导路由画像。全部是本地规则：不额外发起模型调用，也不会递归回落到 auto。
 */
export function profileRequest(request: ChatCompletionRequest): RequestProfile {
  const messages = Array.isArray(request.messages) ? request.messages : []

  let needsVision = false
  let imageCount = 0
  let textTokens = 0

  for (const message of messages) {
    textTokens += estimateTokens(messageText(message))
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isVisionPart(part)) {
          needsVision = true
          imageCount += 1
        }
      }
    }
  }

  const estimatedTokens = textTokens + imageCount * IMAGE_TOKEN_ESTIMATE
  const needsTools = Boolean(request.tools && request.tools.length > 0)

  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user')
  const lastUserText = lastUserMessage ? messageText(lastUserMessage) : ''
  const lastUserLength = lastUserText.length

  let score = 0
  if (lastUserLength > 1200) {
    score += 2
  } else if (lastUserLength > 300) {
    score += 1
  }
  if (messages.length > 8) {
    score += 1
  }
  if (needsTools) {
    score += 1
  }
  if (request.reasoning_effort === 'high') {
    score += 2
  } else if (request.reasoning_effort) {
    score += 1
  }
  if (request.web_search) {
    score += 1
  }
  if (request.deep_research) {
    score += 2
  }
  if (/```|\$\$|\\\(|\\\[/.test(lastUserText)) {
    score += 1
  }
  if (estimatedTokens > LONG_CONTEXT_TOKEN_THRESHOLD) {
    score += 1
  }

  const complexity: AutoComplexity = score >= 5 ? 'complex' : score >= 2 ? 'standard' : 'simple'

  return {
    needsVision,
    needsTools,
    estimatedTokens,
    complexity,
    stream: Boolean(request.stream),
  }
}

/**
 * 会话指纹：system 提示 + 首条 user 消息的哈希。
 *
 * 用途是让同一段对话在多轮里命中同一个模型（会话粘性），所以键必须
 * 在多轮之间保持稳定，又不能把不同对话混在一起。没有 user 消息
 * （或首条 user 为空）时返回 undefined，调用方据此跳过粘性。
 */
export function conversationKey(request: ChatCompletionRequest): string | undefined {
  const messages = Array.isArray(request.messages) ? request.messages : []

  const systemText = messages
    .filter(message => message.role === 'system')
    .map(messageText)
    .join('\n')
    .trim()

  const firstUser = messages.find(message => message.role === 'user')
  if (!firstUser) return undefined

  const userText = messageText(firstUser).trim()
  if (!userText) return undefined

  return `${hashString(systemText)}-${hashString(userText)}`
}

/**
 * 查询模型能力，优先级：
 * 供应商记录标注（`hint`）> 静态表 > 供应商级兜底 > 名字启发式 > 未知。
 *
 * 未知是一等状态：vision 未知就不能接图片，tools 未知可以接但要扣分，
 * 上下文未知按 `UNANNOTATED_CONTEXT_FLOOR` 过滤。任何一层都不写默认值。
 */
export function resolveCapability(
  providerId: string,
  displayName: string,
  hint?: ModelCapabilityHint
): ModelCapability {
  const key = displayName.trim().toLowerCase()
  const staticHint = staticCapabilityHint(providerId, displayName) ?? {}
  const providerDefaults = providerDefaultCapability(providerId) ?? {}

  const tier = hint?.tier ?? staticHint.tier ?? providerDefaults.tier
    ?? (FAST_NAME_PATTERN.test(key) ? 'fast'
      : STRONG_NAME_PATTERN.test(key) ? 'strong'
        : 'balanced')

  return {
    tier,
    vision: hint?.vision ?? staticHint.vision ?? providerDefaults.vision ?? 'unknown',
    tools: hint?.tools ?? staticHint.tools ?? providerDefaults.tools ?? 'unknown',
    contextTokens: hint?.contextTokens ?? staticHint.contextTokens ?? providerDefaults.contextTokens,
  }
}

function effectiveContextLimit(capability: ModelCapability): number {
  return capability.contextTokens ?? UNANNOTATED_CONTEXT_FLOOR
}

function satisfiesCapability(
  profile: RequestProfile,
  capability: ModelCapability,
  enforceContext: boolean
): boolean {
  // 图片被静默丢掉就是错答案，所以只有确认能收图片的模型才参与
  if (profile.needsVision && capability.vision !== 'yes') return false
  if (profile.needsTools && capability.tools === 'no') return false
  if (enforceContext && profile.estimatedTokens > effectiveContextLimit(capability)) return false
  return true
}

export type MissingRequirement = 'vision' | 'tools' | 'context'

/**
 * 排序结果为空时，说明到底缺哪种能力——直接说"没有可用模型"对排障没有帮助。
 * 只报描述性原因，不改变判定。
 */
export function explainMissing(
  profile: RequestProfile,
  candidates: RankCandidate[]
): MissingRequirement[] {
  const capabilityOf = (candidate: RankCandidate): ModelCapability =>
    resolveCapability(candidate.providerId, candidate.displayName, candidate.capabilityHint)

  const missing: MissingRequirement[] = []
  if (profile.needsVision && !candidates.some(c => capabilityOf(c).vision === 'yes')) {
    missing.push('vision')
  }
  if (profile.needsTools && candidates.length > 0 && candidates.every(c => capabilityOf(c).tools === 'no')) {
    missing.push('tools')
  }
  if (candidates.length > 0
    && candidates.every(c => profile.estimatedTokens > effectiveContextLimit(capabilityOf(c)))) {
    missing.push('context')
  }
  return missing
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function scoreCandidate(
  profile: RequestProfile,
  candidate: RankCandidate,
  capability: ModelCapability,
  now: number,
  seed: number,
  strategy: AutoRoutingStrategy,
  maxRpmInPool: number,
  prefer: AutoPreference,
  sticky?: StickyHint
): number {
  // 优化目标改的是"想要多强的模型"，以及成本在打分里占多大份量
  const targetRank = prefer === 'fast'
    ? TIER_RANK.fast
    : prefer === 'strong'
      ? TIER_RANK.strong
      : TIER_TARGET[profile.complexity]
  const tierFit = 1 - Math.abs(TIER_RANK[capability.tier] - targetRank) / 2

  const quota = candidate.dailyLimit && candidate.dailyLimit > 0
    ? clamp01((candidate.dailyLimit - (candidate.todayUsed ?? 0)) / candidate.dailyLimit)
    : 0.6

  // fill-first 追求“先把已用账号填满”，因此看使用率而不是剩余量
  const usageRatio = candidate.dailyLimit && candidate.dailyLimit > 0
    ? clamp01((candidate.todayUsed ?? 0) / candidate.dailyLimit)
    : 0

  const rpmUsed = candidate.rpmUsed ?? 0
  const rpmLoad = candidate.rpmLimit && candidate.rpmLimit > 0
    ? clamp01(rpmUsed / candidate.rpmLimit)
    : maxRpmInPool > 0
      ? clamp01(rpmUsed / maxRpmInPool)
      : 0
  const headroom = 1 - rpmLoad

  // 在途越多越不优先；0 在途得满分
  const concurrency = 1 / (1 + (candidate.inFlight ?? 0))

  const idleness = candidate.lastUsed ? clamp01((now - candidate.lastUsed) / IDLE_WINDOW_MS) : 1

  // 同分时轮转，避免所有请求都压在同一个账号上；其余策略保持稳定排序
  const dispersion = strategy === 'round-robin'
    ? ((hashString(candidate.accountId) + seed) % 7) / 7000
    : 0

  // 未知能力不是错误，但需要让位于已确认能用的候选：tools 未知扣 0.05，
  // 上下文未知且请求已接近上界的再扣 0.05。
  const uncertainTools = profile.needsTools && capability.tools === 'unknown' ? 0.05 : 0
  const uncertainContext = capability.contextTokens === undefined
    && profile.estimatedTokens > UNANNOTATED_CONTEXT_FLOOR / 2
    ? 0.05
    : 0
  const penalty = uncertainTools + uncertainContext

  // 成本以"相对中性 0.5"的加减分进入总分：未知成本正好为 0，
  // 免费模型在 balanced 下得到 +0.1，在 cheap 下得到 +0.3。
  const costWeight = prefer === 'cheap' ? 0.6 : prefer === 'strong' ? 0.1 : 0.2
  const costBonus = costWeight * (COST_SCORE[candidate.costBucket ?? 'unknown'] - 0.5)

  // 会话粘性是加分而非硬钉：首选不可用时它会自然让位给其它候选
  const stickyBonus = sticky === undefined
    ? 0
    : sticky.providerId !== candidate.providerId || sticky.displayName !== candidate.displayName
      ? 0
      : sticky.accountId === candidate.accountId ? 0.12 : 0.06

  if (strategy === 'fill-first') {
    return 0.35 * usageRatio + 0.4 * tierFit + 0.15 * headroom + 0.1 * concurrency
      - penalty + costBonus + stickyBonus
  }

  if (strategy === 'failover') {
    return 0.45 * quota + 0.35 * tierFit + 0.1 * headroom + 0.1 * concurrency
      - penalty + costBonus + stickyBonus
  }

  // smart / pace 在这个分数里表达的是同一件事：**余量比已经用掉的重要**。
  // 两者真正的差别（谁先重置、每小时还剩多少）需要重置时刻，而打分函数拿不到它，
  // 所以这里不假装区分：选号阶段由 loadbalancer 的重置推算做最后一步，
  // auto 只负责把"余量多、配额健康"的候选排到前面。
  if (strategy === 'smart' || strategy === 'pace') {
    return 0.4 * headroom + 0.3 * quota + 0.2 * tierFit + 0.1 * concurrency
      - penalty + costBonus + stickyBonus
  }

  return 0.3 * quota + 0.3 * tierFit + 0.15 * headroom + 0.15 * concurrency + 0.1 * idleness
    + dispersion - penalty + costBonus + stickyBonus
}

/**
 * 排序候选项，返回最多 `limit` 个、按分数从高到低的候选。
 *
 * 规则：
 * 1. 冷却中的账号直接排除；
 * 2. 先按视觉/工具/上下文做硬过滤；
 * 3. 硬过滤后为空时只放宽上下文长度（最容易被估算误差误伤）；
 * 4. 视觉/工具仍然不满足则返回空数组，由调用方报 503，绝不把图片发给不支持的模型；
 * 5. 每个账号只保留一个候选，避免 429 后在同一账号上换模型重试。
 *
 * 打分（Phase 2）：
 * - 配额、RPM 余量、在途并发共同构成“限流健康度”；
 * - 档位匹配决定能力取向；
 * - `round-robin` 打散、`fill-first` 优先填满已用账号、`failover` 只看配额与健康度。
 */
export function rankCandidates(
  profile: RequestProfile,
  candidates: RankCandidate[],
  options: RankOptions = {}
): RankCandidate[] {
  const now = options.now ?? Date.now()
  const limit = options.limit ?? 3
  const seed = options.seed ?? 0
  const strategy = options.strategy ?? 'round-robin'
  const prefer = options.prefer ?? 'balanced'
  const sticky = options.sticky

  const usable = candidates.filter(candidate =>
    candidate.coolingUntil === undefined || candidate.coolingUntil <= now
  )

  const capabilityOf = (candidate: RankCandidate): ModelCapability =>
    resolveCapability(candidate.providerId, candidate.displayName, candidate.capabilityHint)

  let pool = usable.filter(candidate =>
    satisfiesCapability(profile, capabilityOf(candidate), true)
  )

  if (pool.length === 0) {
    pool = usable.filter(candidate =>
      satisfiesCapability(profile, capabilityOf(candidate), false)
    )
  }

  if (pool.length === 0) {
    return []
  }

  const maxRpmInPool = pool.reduce((max, candidate) => Math.max(max, candidate.rpmUsed ?? 0), 0)

  const scored = pool.map(candidate => ({
    candidate,
    score: scoreCandidate(
      profile,
      candidate,
      capabilityOf(candidate),
      now,
      seed,
      strategy,
      maxRpmInPool,
      prefer,
      sticky
    ),
  }))

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const keyA = `${a.candidate.providerId}:${a.candidate.displayName}:${a.candidate.accountId}`
    const keyB = `${b.candidate.providerId}:${b.candidate.displayName}:${b.candidate.accountId}`
    return keyA.localeCompare(keyB)
  })

  const ranked: RankCandidate[] = []
  const usedAccounts = new Set<string>()
  for (const item of scored) {
    if (usedAccounts.has(item.candidate.accountId)) continue
    usedAccounts.add(item.candidate.accountId)
    ranked.push(item.candidate)
    if (ranked.length >= limit) break
  }

  return ranked
}
