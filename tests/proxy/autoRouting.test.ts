import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  conversationKey,
  profileRequest,
  rankCandidates,
  resolveCapability,
  type RankCandidate,
} from '../../src/main/proxy/autoRouting.ts'

const NOW = 1_800_000_000_000

function textRequest(text: string, extra: Record<string, unknown> = {}) {
  return {
    model: 'auto',
    messages: [{ role: 'user' as const, content: text }],
    ...extra,
  }
}

function candidate(overrides: Partial<RankCandidate>): RankCandidate {
  return {
    providerId: 'qwen',
    providerName: 'Qwen',
    displayName: 'Qwen3.7-Max',
    actualModelId: 'qwen3.7-max',
    accountId: 'account-a',
    ...overrides,
  }
}

test('profileRequest marks simple short text as simple', () => {
  const profile = profileRequest(textRequest('帮我把这句话翻译成英文'))

  assert.equal(profile.needsVision, false)
  assert.equal(profile.needsTools, false)
  assert.equal(profile.complexity, 'simple')
  assert.ok(profile.estimatedTokens > 0)
})

test('profileRequest detects vision parts and counts image tokens', () => {
  const profile = profileRequest({
    model: 'auto',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这张图里是什么' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  })

  assert.equal(profile.needsVision, true)
  assert.ok(profile.estimatedTokens >= 1024)
})

test('profileRequest treats files as vision input', () => {
  const profile = profileRequest({
    model: 'auto',
    messages: [
      {
        role: 'user',
        content: [{ type: 'file', file: { name: 'a.pdf' } } as never],
      },
    ],
  })

  assert.equal(profile.needsVision, true)
})

test('profileRequest escalates long text with tools and high reasoning effort', () => {
  const profile = profileRequest(textRequest('x'.repeat(1500), {
    tools: [{ type: 'function', function: { name: 'read_file' } }],
    reasoning_effort: 'high',
  }))

  assert.equal(profile.needsTools, true)
  assert.equal(profile.complexity, 'complex')
})

test('resolveCapability knows shipped models and falls back to name heuristics', () => {
  assert.deepEqual(
    { tier: resolveCapability('qwen', 'Qwen3.5-Flash').tier, vision: resolveCapability('qwen', 'Qwen3.5-Flash').vision },
    { tier: 'fast', vision: false }
  )
  assert.equal(resolveCapability('glm', 'GLM-5.3').vision, true)
  assert.equal(resolveCapability('kimi', 'K3').tier, 'strong')
  assert.equal(resolveCapability('kimi', 'K2.8').tier, 'strong')
  assert.equal(resolveCapability('kimi', 'Instant').tier, 'fast')
  assert.equal(resolveCapability('kimi', 'Instant').vision, false)
  // legacy display name still resolves to the same tier
  assert.equal(resolveCapability('kimi', 'Kimi-K2.6').tier, 'strong')
  assert.equal(resolveCapability('kimi', 'some-unlisted-flash').tier, 'fast')
  assert.equal(resolveCapability('kimi', 'some-unlisted-pro').tier, 'strong')
  // 未登记的模型默认不参与多模态路由
  assert.equal(resolveCapability('unknown-provider', 'brand-new-model').vision, false)
})

test('rankCandidates prefers the strong model for complex requests', () => {
  const profile = profileRequest(textRequest('x'.repeat(1500), { reasoning_effort: 'high' }))

  const ranked = rankCandidates(profile, [
    candidate({ displayName: 'Qwen3.5-Flash', actualModelId: 'qwen3.5-flash', accountId: 'fast-account' }),
    candidate({ displayName: 'Qwen3.7-Max', actualModelId: 'qwen3.7-max', accountId: 'strong-account' }),
  ], { now: NOW })

  assert.equal(ranked[0].displayName, 'Qwen3.7-Max')
})

test('rankCandidates never routes images to a text-only model', () => {
  const profile = profileRequest({
    model: 'auto',
    messages: [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
      },
    ],
  })

  const ranked = rankCandidates(profile, [
    candidate({ providerId: 'deepseek', providerName: 'DeepSeek', displayName: 'deepseek-default', actualModelId: 'default', accountId: 'ds' }),
    candidate({ providerId: 'glm', providerName: 'GLM', displayName: 'GLM-5.3', actualModelId: 'glm-5.3', accountId: 'glm' }),
  ], { now: NOW })

  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].providerId, 'glm')
})

test('rankCandidates keeps one candidate per account', () => {
  const profile = profileRequest(textRequest('hi'))

  const ranked = rankCandidates(profile, [
    candidate({ displayName: 'Qwen3.7-Max', actualModelId: 'qwen3.7-max', accountId: 'same-account' }),
    candidate({ displayName: 'Qwen3.5-Flash', actualModelId: 'qwen3.5-flash', accountId: 'same-account' }),
  ], { now: NOW })

  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].accountId, 'same-account')
})

test('rankCandidates drops accounts in cooldown', () => {
  const profile = profileRequest(textRequest('hi'))

  const ranked = rankCandidates(profile, [
    candidate({ accountId: 'cooling', coolingUntil: NOW + 30_000 }),
    candidate({ accountId: 'healthy' }),
  ], { now: NOW })

  assert.deepEqual(ranked.map(item => item.accountId), ['healthy'])
})

test('rankCandidates prefers accounts with remaining quota', () => {
  const profile = profileRequest(textRequest('hi'))

  const ranked = rankCandidates(profile, [
    candidate({ accountId: 'exhausted', dailyLimit: 10, todayUsed: 10, lastUsed: NOW - 60_000 }),
    candidate({ accountId: 'fresh', dailyLimit: 10, todayUsed: 0, lastUsed: NOW - 60_000 }),
  ], { now: NOW })

  assert.equal(ranked[0].accountId, 'fresh')
})

test('rankCandidates relaxes long-context filtering before giving up', () => {
  const profile = profileRequest(textRequest('x'.repeat(5000)))
  assert.ok(profile.estimatedTokens < 64000)

  // 直接构造一个超长上下文画像：上下文过滤先失效，但仍应返回候选
  const longProfile = {
    ...profile,
    estimatedTokens: 200_000,
  }

  const ranked = rankCandidates(longProfile, [
    candidate({ accountId: 'only-one', displayName: 'Kimi-K2.6', actualModelId: 'kimi-k2.6', providerId: 'kimi', providerName: 'Kimi' }),
  ], { now: NOW })

  assert.equal(ranked.length, 1)
})

test('rankCandidates returns nothing when no model can satisfy the request', () => {
  const profile = profileRequest({
    model: 'auto',
    messages: [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: '看图' }],
      },
    ],
  })

  const ranked = rankCandidates(profile, [
    candidate({ providerId: 'qwen', displayName: 'Qwen3.7-Max', accountId: 'text-only' }),
  ], { now: NOW })

  assert.deepEqual(ranked, [])
})

test('rankCandidates steers away from accounts with requests in flight', () => {
  const profile = profileRequest(textRequest('hi'))

  const ranked = rankCandidates(profile, [
    candidate({ accountId: 'busy', inFlight: 6, rpmUsed: 30 }),
    candidate({ accountId: 'idle', inFlight: 0, rpmUsed: 0 }),
  ], { now: NOW, strategy: 'round-robin' })

  assert.equal(ranked[0].accountId, 'idle')
})

test('rankCandidates honors an explicit rpmLimit over relative load', () => {
  const profile = profileRequest(textRequest('hi'))

  const ranked = rankCandidates(profile, [
    candidate({ accountId: 'throttled', rpmLimit: 10, rpmUsed: 10 }),
    candidate({ accountId: 'has-headroom', rpmLimit: 10, rpmUsed: 0 }),
  ], { now: NOW, strategy: 'round-robin' })

  assert.equal(ranked[0].accountId, 'has-headroom')
})

test('fill-first prefers an already used account while round-robin prefers the fresh one', () => {
  const profile = profileRequest(textRequest('hi'))
  const candidates = [
    candidate({ accountId: 'used', dailyLimit: 100, todayUsed: 90 }),
    candidate({ accountId: 'fresh', dailyLimit: 100, todayUsed: 0 }),
  ]

  const fillFirst = rankCandidates(profile, candidates, { now: NOW, strategy: 'fill-first' })
  const roundRobin = rankCandidates(profile, candidates, { now: NOW, strategy: 'round-robin' })

  assert.equal(fillFirst[0].accountId, 'used')
  assert.equal(roundRobin[0].accountId, 'fresh')
})

test('failover ranking is stable and ignores the dispersion seed', () => {
  const profile = profileRequest(textRequest('hi'))
  const candidates = [
    candidate({ accountId: 'a', providerId: 'qwen' }),
    candidate({ accountId: 'b', providerId: 'qwen' }),
  ]

  const first = rankCandidates(profile, candidates, { now: NOW, strategy: 'failover', seed: 1 })
  const second = rankCandidates(profile, candidates, { now: NOW, strategy: 'failover', seed: 7 })

  assert.deepEqual(first.map(item => item.accountId), second.map(item => item.accountId))
})

test('conversationKey is stable across later turns of the same conversation', () => {
  const opening = {
    model: 'auto',
    messages: [
      { role: 'system' as const, content: '你是助手' },
      { role: 'user' as const, content: '介绍一下 Koa' },
    ],
  }
  const laterTurn = {
    model: 'auto',
    messages: [
      { role: 'system' as const, content: '你是助手' },
      { role: 'user' as const, content: '介绍一下 Koa' },
      { role: 'assistant' as const, content: 'Koa 是一个 Node 框架' },
      { role: 'user' as const, content: '它和 Express 有什么区别' },
    ],
  }

  assert.equal(conversationKey(opening), conversationKey(laterTurn))
})

test('conversationKey separates different conversations and different system prompts', () => {
  const base = {
    model: 'auto',
    messages: [{ role: 'user' as const, content: '介绍一下 Koa' }],
  }
  const otherUser = {
    model: 'auto',
    messages: [{ role: 'user' as const, content: '介绍一下 Fastify' }],
  }
  const otherSystem = {
    model: 'auto',
    messages: [
      { role: 'system' as const, content: '你是代码审查员' },
      { role: 'user' as const, content: '介绍一下 Koa' },
    ],
  }

  assert.notEqual(conversationKey(base), conversationKey(otherUser))
  assert.notEqual(conversationKey(base), conversationKey(otherSystem))
})

test('conversationKey returns undefined without a user message', () => {
  assert.equal(conversationKey({ model: 'auto', messages: [] }), undefined)
  assert.equal(
    conversationKey({
      model: 'auto',
      messages: [{ role: 'system' as const, content: '你是助手' }],
    }),
    undefined
  )
})
