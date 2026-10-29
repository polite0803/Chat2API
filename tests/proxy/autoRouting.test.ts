import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyContractFilter,
  contractNeeds,
  conversationKey,
  explainMissing,
  profileRequest,
  providerMeetsContract,
  rankCandidates,
  resolveCapability,
  UNANNOTATED_CONTEXT_FLOOR,
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
    { tier: 'fast', vision: 'unknown' }
  )
  assert.equal(resolveCapability('glm', 'GLM-5.3').vision, 'yes')
  assert.equal(resolveCapability('kimi', 'K3').tier, 'strong')
  assert.equal(resolveCapability('kimi', 'K2.8').tier, 'strong')
  assert.equal(resolveCapability('kimi', 'Instant').tier, 'fast')
  assert.equal(resolveCapability('kimi', 'Instant').vision, 'no')
  // legacy display name still resolves to the same tier
  assert.equal(resolveCapability('kimi', 'Kimi-K2.6').tier, 'strong')
  assert.equal(resolveCapability('kimi', 'some-unlisted-flash').tier, 'fast')
  assert.equal(resolveCapability('kimi', 'some-unlisted-pro').tier, 'strong')
  // 未登记的模型保持未知，既不当作支持也不当作不支持
  assert.equal(resolveCapability('unknown-provider', 'brand-new-model').vision, 'unknown')
})

test('resolveCapability reads aggregate display names past the entry prefix', () => {
  // 聚合供应商的展示名是 `<entryId>/<modelId>`，静态表按模型名登记
  assert.equal(resolveCapability('glm', 'glm/glm-5.3').tier, 'strong')
  assert.equal(resolveCapability('glm', 'glm/glm-5.3').contextTokens, 128000)
  // 账号渠道的展示名是 `<渠道名> / <模型名>`，同样要能命中
  assert.equal(resolveCapability('kimi', 'Kimi / Instant').tier, 'fast')
})

test('a provider-record hint wins over the static table', () => {
  const hinted = resolveCapability('glm', 'glm/glm-5.3', { vision: 'no', contextTokens: 32000 })
  assert.equal(hinted.vision, 'no')
  assert.equal(hinted.contextTokens, 32000)
  // tier 没被覆盖时仍取静态表
  assert.equal(hinted.tier, 'strong')
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

test('rankCandidates never routes images to a model whose vision support is unknown', () => {
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
    // 未标注且无从推断：不知道能不能收图片，就不能拿它当答案
    candidate({ providerId: 'custom-x', providerName: 'Custom', displayName: 'mystery-model', accountId: 'unknown' }),
    candidate({ providerId: 'glm', providerName: 'GLM', displayName: 'GLM-5.3', actualModelId: 'glm-5.3', accountId: 'glm' }),
  ], { now: NOW })

  assert.deepEqual(ranked.map(item => item.accountId), ['glm'])
})

test('a capability hint can veto a statically supported model', () => {
  const profile = profileRequest({
    model: 'auto',
    messages: [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ],
  })

  const ranked = rankCandidates(profile, [
    candidate({
      providerId: 'glm',
      displayName: 'glm/glm-5.3',
      actualModelId: 'glm-5.3',
      accountId: 'vetoed',
      capabilityHint: { vision: 'no' },
    }),
  ], { now: NOW })

  assert.deepEqual(ranked, [])
})

test('a known context window filters long requests before the fallback floor', () => {
  const profile = {
    ...profileRequest(textRequest('short')),
    estimatedTokens: 40_000,
  }
  assert.ok(profile.estimatedTokens < UNANNOTATED_CONTEXT_FLOOR)

  const ranked = rankCandidates(profile, [
    candidate({ accountId: 'small', capabilityHint: { contextTokens: 32000 } }),
    candidate({ accountId: 'big', capabilityHint: { contextTokens: 128000 } }),
  ], { now: NOW })

  assert.deepEqual(ranked.map(item => item.accountId), ['big'])
})

test('the unannotated context floor keeps the historical 64000 limit', () => {
  const profile = { ...profileRequest(textRequest('short')), estimatedTokens: 70_000 }

  const ranked = rankCandidates(profile, [
    candidate({ accountId: 'unannotated' }),
  ], { now: NOW })

  // 64000 硬过滤挡下，随后只放宽一次上下文，所以仍会返回该候选
  assert.equal(ranked.length, 1)
})

test('contractNeeds only flags requirements that change the response shape', () => {
  assert.deepEqual(contractNeeds(textRequest('hi')), { multiChoice: false, structuredOutput: false })
  assert.equal(contractNeeds(textRequest('hi', { n: 2 })).multiChoice, true)
  assert.equal(
    contractNeeds(textRequest('hi', { response_format: { type: 'json_schema' } })).structuredOutput,
    true,
  )
  assert.equal(
    contractNeeds(textRequest('hi', { response_format: { type: 'text' } })).structuredOutput,
    false,
  )
})

test('only builtin providers fail a structured-output or multi-choice contract', () => {
  const structured = { multiChoice: false, structuredOutput: true }
  assert.equal(providerMeetsContract('builtin', structured), false)
  assert.equal(providerMeetsContract('aggregate', structured), true)
  assert.equal(providerMeetsContract('custom', structured), true)
  assert.equal(providerMeetsContract('account', structured), true)
  assert.equal(providerMeetsContract('builtin', { multiChoice: false, structuredOutput: false }), true)
})

test('applyContractFilter prefers capable candidates and reports what it gave up', () => {
  const builtinOnly = [candidate({ accountId: 'builtin', contractCapable: false })]
  const mixed = [
    candidate({ accountId: 'builtin', contractCapable: false }),
    candidate({ accountId: 'aggregate', contractCapable: true }),
  ]

  // 有能满足的候选：只在它们里面挑，不降级
  assert.deepEqual(
    applyContractFilter(mixed, { multiChoice: true, structuredOutput: false }),
    { pool: [mixed[1]], degraded: [], missing: [] },
  )

  // n > 1 且只有内置：必须拒绝，不能悄悄返回一个 choice
  assert.deepEqual(
    applyContractFilter(builtinOnly, { multiChoice: true, structuredOutput: false }),
    { pool: [], degraded: [], missing: ['n'] },
  )

  // 结构化输出且只有内置：照常路由，但必须报告降级
  assert.deepEqual(
    applyContractFilter(builtinOnly, { multiChoice: false, structuredOutput: true }),
    { pool: builtinOnly, degraded: ['response_format'], missing: [] },
  )

  // 没有契约要求时原样返回
  assert.deepEqual(
    applyContractFilter(builtinOnly, { multiChoice: false, structuredOutput: false }),
    { pool: builtinOnly, degraded: [], missing: [] },
  )
})

test('balanced lets a free model break a near tie, cheap makes it win outright', () => {
  const profile = profileRequest(textRequest('hi'))
  const pool = [
    // 免费的均衡档 vs 付费的快档：balanced 还要速度为先，cheap 才愿意为免费让步
    candidate({ accountId: 'free', displayName: 'Qwen3.6', costBucket: 'free' }),
    candidate({ accountId: 'paid', displayName: 'Qwen3.5-Flash', costBucket: 'above-base' }),
  ]

  const balanced = rankCandidates(profile, pool, { now: NOW, prefer: 'balanced' })
  const cheap = rankCandidates(profile, pool, { now: NOW, prefer: 'cheap' })

  assert.equal(balanced[0].accountId, 'paid')
  assert.equal(cheap[0].accountId, 'free')
})

test('an unreported cost is neutral, so it neither wins nor loses on price', () => {
  const profile = profileRequest(textRequest('hi'))
  const ranked = rankCandidates(profile, [
    candidate({ accountId: 'unknown-cost', costBucket: 'unknown' }),
    candidate({ accountId: 'free-cost', costBucket: 'free' }),
  ], { now: NOW, prefer: 'cheap' })

  // 未知成本不是免费：cheap 下免费模型仍然排在它前面
  assert.equal(ranked[0].accountId, 'free-cost')
})

test('the preference overrides the target tier for every complexity', () => {
  const profile = { ...profileRequest(textRequest('hi')), complexity: 'complex' as const }
  const pool = [
    candidate({ accountId: 'fast', displayName: 'Qwen3.5-Flash' }),
    candidate({ accountId: 'strong', displayName: 'Qwen3.7-Max' }),
  ]

  assert.equal(rankCandidates(profile, pool, { now: NOW })[0].accountId, 'strong')
  assert.equal(rankCandidates(profile, pool, { now: NOW, prefer: 'fast' })[0].accountId, 'fast')
  assert.equal(rankCandidates(profile, pool, { now: NOW, prefer: 'strong' })[0].accountId, 'strong')
})

test('a sticky hint promotes the previous candidate but never hard-pins it', () => {
  const profile = profileRequest(textRequest('hi'))
  const pool = [
    candidate({ accountId: 'a', displayName: 'Qwen3.6' }),
    candidate({ accountId: 'b', displayName: 'Qwen3.6' }),
  ]

  const sticky = { providerId: 'qwen', displayName: 'Qwen3.6', accountId: 'b' }
  assert.equal(rankCandidates(profile, pool, { now: NOW, sticky })[0].accountId, 'b')

  // 首选不可用（冷却）时它连候选都不是，路由自然让位，不需要额外清理
  const cooling = [
    candidate({ accountId: 'sticky-cooling', displayName: 'Qwen3.6', coolingUntil: NOW + 30_000 }),
    candidate({ accountId: 'healthy', displayName: 'Qwen3.6' }),
  ]
  const ranked = rankCandidates(profile, cooling, {
    now: NOW,
    sticky: { providerId: 'qwen', displayName: 'Qwen3.6', accountId: 'sticky-cooling' },
  })
  assert.deepEqual(ranked.map(item => item.accountId), ['healthy'])
})

test('explainMissing names the capability that emptied the pool', () => {
  const visionProfile = profileRequest({
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
  })
  const textOnly = [candidate({ providerId: 'custom-x', displayName: 'mystery-model' })]
  assert.deepEqual(explainMissing(visionProfile, textOnly), ['vision'])

  const longProfile = { ...profileRequest(textRequest('hi')), estimatedTokens: 90_000 }
  assert.deepEqual(
    explainMissing(longProfile, [candidate({ capabilityHint: { contextTokens: 32000 } })]),
    ['context'],
  )

  const toolsProfile = { ...profileRequest(textRequest('hi')), needsTools: true }
  assert.deepEqual(
    explainMissing(toolsProfile, [candidate({ capabilityHint: { tools: 'no' } })]),
    ['tools'],
  )
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
