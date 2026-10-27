/**
 * Auto 模型路由 - 纯决策逻辑
 *
 * 本文件不依赖 electron / electron-store，以便在 node:test 中直接验证；
 * 供应商、账号、模型的数据采集与冷却状态见 autoRouter.ts。
 */

import type { ChatCompletionRequest, ChatMessage } from './types'

export type AutoModelTier = 'fast' | 'balanced' | 'strong'
export type AutoComplexity = 'simple' | 'standard' | 'complex'
/** 与 loadBalanceStrategy 保持一致，用于选择打分口径 */
export type AutoRoutingStrategy = 'round-robin' | 'fill-first' | 'failover'

/** 单个模型的能力描述，用于硬过滤与档位打分 */
export interface ModelCapability {
  tier: AutoModelTier
  vision: boolean
  tools: boolean
  contextTokens: number
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
}

export interface RankOptions {
  now?: number
  /** 最多返回多少个候选（失败切换次数上限），默认 3 */
  limit?: number
  /** 分散度种子，每次请求递增以打散同分候选 */
  seed?: number
  /** 打分口径，默认与服务端的 loadBalanceStrategy 一致 */
  strategy?: AutoRoutingStrategy
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

/** 未登记模型的保守默认：可做纯文本 + 工具调用，不参与多模态路由 */
const DEFAULT_CAPABILITY: ModelCapability = {
  tier: 'balanced',
  vision: false,
  tools: true,
  contextTokens: 64000,
}

/**
 * 供应商级默认能力。vision 只在 adapter 真的能上传图片时才为 true：
 * 目前 glm / kimi / minimax 的 adapter 会转换 image_url / file 内容。
 */
const PROVIDER_DEFAULT_CAPABILITY: Record<string, Partial<ModelCapability>> = {
  deepseek: { vision: false },
  glm: { vision: true },
  kimi: { vision: true },
  minimax: { vision: true },
  qwen: { vision: false },
  'qwen-ai': { vision: false },
  zai: { vision: false },
  mimo: { vision: false },
}

/** 已登记模型的能力表，键为小写显示名 */
const MODEL_CAPABILITIES: Record<string, Record<string, Partial<ModelCapability>>> = {
  deepseek: {
    'deepseek-default': { tier: 'balanced' },
    'deepseek-expert': { tier: 'strong' },
    // 识图模式虽有独立入口，但 adapter 目前不上传图片，因此不参与多模态路由
    'deepseek-vision': { tier: 'balanced', vision: false },
  },
  glm: {
    'glm-5.3': { tier: 'strong', vision: true, contextTokens: 128000 },
    'glm-5.3-flash': { tier: 'fast', vision: true },
  },
  kimi: {
    k3: { tier: 'strong', vision: true, contextTokens: 128000 },
    'k2.8': { tier: 'strong', vision: true, contextTokens: 128000 },
    // chat-only model: the site exposes no file handling for it
    instant: { tier: 'fast', vision: false },
    // legacy display name, same capability the old entry described
    'kimi-k2.6': { tier: 'strong', vision: true, contextTokens: 128000 },
  },
  minimax: {
    'minimax-m2.7': { tier: 'balanced', vision: true, contextTokens: 128000 },
  },
  qwen: {
    'qwen3.7-max': { tier: 'strong' },
    'qwen3-max': { tier: 'strong' },
    'qwen3-max-thinking-preview': { tier: 'strong' },
    'qwen3.6': { tier: 'balanced' },
    'qwen3.5-flash': { tier: 'fast' },
    'qwen3-coder': { tier: 'balanced' },
  },
  'qwen-ai': {
    'qwen3.7-max': { tier: 'strong' },
    'qwen3.6-plus': { tier: 'balanced' },
    'qwen3.6-35b-a3b': { tier: 'fast' },
    'qwen3.6-27b': { tier: 'fast' },
    'qwen3-coder': { tier: 'balanced' },
  },
  zai: {
    'glm-5.1': { tier: 'strong' },
    'glm-5': { tier: 'strong' },
    'glm-5-turbo': { tier: 'fast' },
    'glm-5v-turbo': { tier: 'balanced' },
    'glm-4.7': { tier: 'balanced' },
  },
  mimo: {
    'mimo-v2.5-pro': { tier: 'strong' },
    'mimo-v2.5': { tier: 'balanced' },
    'mimo-v2-flash': { tier: 'fast' },
  },
}

/** 在线同步来的未知模型按名字猜档位，猜错只影响档位匹配，不影响可用性 */
const FAST_NAME_PATTERN = /(flash|turbo|mini|lite|fast|air|small|\d+b|a\d+b)/
const STRONG_NAME_PATTERN = /(max|pro|expert|ultra|opus|thinking|reason)/

const VISION_PART_TYPES = new Set(['image_url', 'input_image', 'image', 'file'])
const IMAGE_TOKEN_ESTIMATE = 1024
const LONG_CONTEXT_TOKEN_THRESHOLD = 24000
const IDLE_WINDOW_MS = 5 * 60 * 1000

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
 * 查询模型能力：已登记的表 > 供应商默认 > 名字启发式 > 保守默认
 */
export function resolveCapability(providerId: string, displayName: string): ModelCapability {
  const key = displayName.trim().toLowerCase()
  const exact = MODEL_CAPABILITIES[providerId]?.[key] || {}
  const providerDefaults = PROVIDER_DEFAULT_CAPABILITY[providerId] || {}

  const inferred: Partial<ModelCapability> = {}
  if (!exact.tier) {
    if (FAST_NAME_PATTERN.test(key)) {
      inferred.tier = 'fast'
    } else if (STRONG_NAME_PATTERN.test(key)) {
      inferred.tier = 'strong'
    }
  }

  return {
    ...DEFAULT_CAPABILITY,
    ...providerDefaults,
    ...inferred,
    ...exact,
  }
}

function satisfiesCapability(
  profile: RequestProfile,
  capability: ModelCapability,
  enforceContext: boolean
): boolean {
  if (profile.needsVision && !capability.vision) return false
  if (profile.needsTools && !capability.tools) return false
  if (enforceContext && profile.estimatedTokens > capability.contextTokens) return false
  return true
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
  maxRpmInPool: number
): number {
  const targetRank = TIER_TARGET[profile.complexity]
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

  if (strategy === 'fill-first') {
    return 0.35 * usageRatio + 0.4 * tierFit + 0.15 * headroom + 0.1 * concurrency
  }

  if (strategy === 'failover') {
    return 0.45 * quota + 0.35 * tierFit + 0.1 * headroom + 0.1 * concurrency
  }

  return 0.3 * quota + 0.3 * tierFit + 0.15 * headroom + 0.15 * concurrency + 0.1 * idleness + dispersion
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

  const usable = candidates.filter(candidate =>
    candidate.coolingUntil === undefined || candidate.coolingUntil <= now
  )

  let pool = usable.filter(candidate =>
    satisfiesCapability(profile, resolveCapability(candidate.providerId, candidate.displayName), true)
  )

  if (pool.length === 0) {
    pool = usable.filter(candidate =>
      satisfiesCapability(profile, resolveCapability(candidate.providerId, candidate.displayName), false)
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
      resolveCapability(candidate.providerId, candidate.displayName),
      now,
      seed,
      strategy,
      maxRpmInPool
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
