/**
 * OpenCode 免费池取证脚本（纯外部探测，不写盘、不含任何凭据）。
 *
 * 用法：node scripts/probe-opencode-free.mjs
 * 退出码：0 = 至少拿到一次 200（可以读响应契约）；1 = 全部被 429/4xx 挡住。
 *
 * 存在的理由：
 *  - 免费额度按调用方来源、每日 UTC 零点重置（429 的 retry-after 每次都精确指向次日 00:00Z）；
 *  - "目录里有"不等于"能调用"：410 ModelDeprecated、400 Model is unavailable 都真实出现过；
 *  - 免费模型分属两个协议（openai 组 /chat/completions，anthropic 组 /messages），打错门只会 404。
 * 这三件事只能靠真实请求分辨，所以把探测固定下来，避免每次重新手写一遍。
 */

const CATALOG = 'https://models.dev/api.json'
const HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' }
const isZero = value => value === 0 || value === undefined

/** 免费 = 四个价格字段全 0，且目录未标 deprecated（实测仍可能被上游 410）。 */
export async function freeModelsByBaseUrl() {
  const response = await fetch(CATALOG, { headers: HEADERS })
  if (!response.ok) throw new Error(`catalog http ${response.status}`)
  const catalog = await response.json()
  const models = Object.entries(catalog?.opencode?.models ?? {})
  const free = models.filter(([, model]) => {
    const cost = model.cost ?? {}
    return (
      isZero(cost.input) &&
      isZero(cost.output) &&
      isZero(cost.cache_read) &&
      isZero(cost.cache_write) &&
      model.deprecated !== true
    )
  })

  const groups = new Map()
  for (const [id, model] of free) {
    const base = model.provider?.api
    if (!base) continue
    if (!groups.has(base)) groups.set(base, [])
    groups.get(base).push({
      id,
      name: model.name,
      toolCall: model.tool_call === true,
      reasoning: model.reasoning === true,
      context: model.limit?.context,
    })
  }
  return groups
}

/** 两组协议各走各的门：anthropic 组是 /messages，其余是 /chat/completions。 */
export function chatPathFor(base) {
  return base.includes('/inference/anthropic/') ? '/messages' : '/chat/completions'
}

function requestBody(base, model, stream) {
  const messages = [{ role: 'user', content: 'Reply with exactly: PONG' }]
  if (chatPathFor(base) === '/messages') {
    return { model, max_tokens: 16, stream, messages }
  }
  return { model, messages, stream, ...(stream ? {} : { max_tokens: 16 }) }
}

async function post(url, body) {
  const started = Date.now()
  try {
    const response = await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {}
    return {
      url,
      status: response.status,
      retryAfter: Number(response.headers.get('retry-after') ?? -1),
      json,
      text,
      ms: Date.now() - started,
    }
  } catch (error) {
    return { url, status: 0, error: String(error?.message ?? error), ms: Date.now() - started }
  }
}

function describe(result, model) {
  const stamp =
    result.retryAfter > 0 ? new Date(Date.now() + result.retryAfter * 1000).toISOString() : '-'
  if (result.status === 200) {
    const choice = result.json?.choices?.[0]
    const anthropicText = Array.isArray(result.json?.content)
      ? result.json.content.find(block => block?.type === 'text')?.text
      : undefined
    const text = String(choice?.message?.content ?? anthropicText ?? '').slice(0, 40)
    console.log(
      `  200  ${model.padEnd(26)} ${String(result.ms).padStart(5)}ms | usage=${JSON.stringify(result.json?.usage ?? null)} | finish=${choice?.finish_reason ?? result.json?.stop_reason ?? '-'} | tool_calls=${choice?.message?.tool_calls?.length ?? 0} | text=${JSON.stringify(text)}`,
    )
    return true
  }
  const reason = result.json?.error?.type ?? result.error ?? result.text?.slice(0, 60)
  console.log(
    `  ${result.status || 'ERR'}  ${model.padEnd(26)} ${String(result.ms).padStart(5)}ms | retry-after=${result.retryAfter}s (UTC ${stamp}) | ${reason}`,
  )
  return false
}

async function main() {
  const groups = await freeModelsByBaseUrl()
  if (!groups.size) {
    console.error('目录里没读到任何免费模型分组')
    process.exitCode = 1
    return
  }
  console.log(`UTC now: ${new Date().toISOString()}`)

  let anySuccess = false
  for (const [base, models] of groups) {
    const path = chatPathFor(base)
    console.log(`\n${base}${path}  (${models.length} 个免费模型)`)
    for (const model of models.slice(0, 4)) {
      const first = await post(`${base}${path}`, requestBody(base, model.id, false))
      if (!describe(first, model.id)) continue

      anySuccess = true
      const streamed = await post(`${base}${path}`, requestBody(base, model.id, true))
      const dataLines = (streamed.text.match(/^data: /gm) ?? []).length
      console.log(
        `  stream probe: http=${streamed.status} bytes=${streamed.text.length} data-lines=${dataLines} has-[DONE]=${streamed.text.includes('[DONE]')}`,
      )
      break
    }
  }

  if (!anySuccess) {
    console.log('\n没有一次 200：额度窗口未恢复或模型不可用。retry-after 指向的重置点即每日 UTC 零点。')
  }
  process.exitCode = anySuccess ? 0 : 1
}

if (process.argv[1] && process.argv[1].endsWith('probe-opencode-free.mjs')) {
  main().catch(error => {
    console.error('probe failed:', error?.message ?? error)
    process.exitCode = 1
  })
}
