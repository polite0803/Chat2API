/**
 * OpenCode 供应商适配：把"一次 agent 回合"包装成 OpenAI 形状的响应。
 *
 * 三个刻意的取舍，都写在这里免得以后被当成 bug：
 *  1. usage 一律为 null。桥接层确实能拿到 token 数，但那是 agent 自己的回合统计
 *     （实测单回合约 9 万输入 token，绝大部分是 agent 的系统提示），拿它冒充调用方的用量是撒谎。
 *  2. 流式是"一次性"的：agent 回合本来就不吐 token 流，所以整段答复到一个内容分片里发出，
 *     然后 finish_reason=stop 与 [DONE]。客户端拿到的是合法 SSE，只是没有逐字增量。
 *  3. 响应头必须先发出去。一个回合 30–60 秒（首次还要拉起运行时，可能更久），
 *     如果等回合跑完再开流，客户端只要有响应头超时（AxAgent 的 SSE 诊断是 10 秒）
 *     就会先判失败再回退，整条链路永远打不通。所以流一建立就先发一个只带 role 的分片，
 *     真正的正文等回合结束再补上去。
 */
import { PassThrough } from 'node:stream'
import type { Provider, Account } from '../../store/types'
import type { BridgeReply } from '../../opencode/bridge.ts'
import { opencodeService } from '../../opencode/service.ts'
import { renderTranscript, type TranscriptMessage } from '../../opencode/prompt.ts'
import { buildStreamErrorFrame } from '../errorMapping.ts'

export interface OpencodeRequest {
  model: string
  messages: TranscriptMessage[]
  stream?: boolean
  signal?: AbortSignal
  /** 客户端自己的 system 提示，原样交给模型 */
  system?: string
  /** 我们自己的工具：交给模型作为"要调用什么"的清单，执行仍在客户端 */
  tools: Array<{ name: string; description?: string; parameters?: unknown }>
}

export function buildCompletion(id: string, model: string, reply: BridgeReply) {
  const toolCalls = buildToolCalls(id, reply)

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: reply.text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: null,
  }
}

function buildToolCalls(id: string, reply: BridgeReply) {
  return reply.toolCalls.map((call, index) => ({
    id: `call_${id}_${index}`,
    type: 'function' as const,
    function: {
      name: call.name,
      arguments:
        typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
    },
  }))
}

function chunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

/** 只带 role 的分片：流一建立就发，作用是把响应头推出去 */
export function buildStreamPrelude(id: string, model: string): string {
  return chunk(id, model, { role: 'assistant' }, null)
}

/** 回合结束后的正文分片：内容、工具调用、结束原因 */
export function buildStreamBody(id: string, model: string, reply: BridgeReply): string {
  let out = ''
  if (reply.text) out += chunk(id, model, { content: reply.text }, null)

  const toolCalls = buildToolCalls(id, reply)
  for (const [index, call] of toolCalls.entries()) {
    out += chunk(id, model, { tool_calls: [{ index, ...call }] }, null)
  }
  out += chunk(id, model, {}, toolCalls.length > 0 ? 'tool_calls' : 'stop')
  return out
}

export function buildCompletionStream(id: string, model: string, reply: BridgeReply): PassThrough {
  const stream = new PassThrough()
  stream.write(buildStreamPrelude(id, model))
  stream.write(buildStreamBody(id, model, reply))
  stream.write('data: [DONE]\n\n')
  stream.end()
  return stream
}

export interface DeferredCompletionStream {
  /** 已经写了 role 分片，可以立刻交给 HTTP 层推响应头 */
  stream: PassThrough
  /** 回合跑完：补正文并收尾 */
  complete: (reply: BridgeReply) => void
  /** 回合失败：补错误帧并收尾（不是 assistant 正文） */
  fail: (error: unknown) => void
}

/**
 * 先把响应头发出去，回合在后台跑。
 * 客户端只要在等响应头就不会误判超时；正文晚到一点无所谓。
 */
export function createDeferredCompletionStream(
  id: string,
  model: string
): DeferredCompletionStream {
  const stream = new PassThrough()
  stream.write(buildStreamPrelude(id, model))

  let settled = false
  const finish = (payload: string) => {
    if (settled) return
    settled = true
    // 客户端已经断开（路由会销毁这条流）时不能再写，否则写一个已销毁的流会抛错
    if (stream.destroyed) return
    stream.write(payload)
    stream.write('data: [DONE]\n\n')
    stream.end()
  }

  return {
    stream,
    complete: reply => finish(buildStreamBody(id, model, reply)),
    fail: error => {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[OpenCode] agent turn failed:', message)
      finish(buildStreamErrorFrame(message))
    },
  }
}

export class OpencodeAdapter {
  private readonly provider: Provider
  private readonly account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  async chatCompletion(request: OpencodeRequest): Promise<BridgeReply> {
    const prompt = renderTranscript(request.messages)
    const requested = request.tools ?? []
    const tools = await this.resolveTools(request.model, requested)
    const system = tools.length
      ? [
          request.system ?? '',
          'The only native tool you may invoke is StructuredOutput for formatting the response. ' +
          'All other native tools are forbidden; do not perform the external actions yourself.',
          'Ignore all native OpenCode environment details, including its working directory. ' +
          'They belong to the adapter, NOT the external client.',
          'Choose actions ONLY from the external tools supplied in THIS request. Copy tool names and ' +
          'argument field names exactly, including capitalization. Never substitute a native tool ' +
          'for a supplied one, run a local command, or invent a tool.',
          `Available external tools: ${JSON.stringify(
            tools.map(tool => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          )}`,
          'Return exactly one JSON object, no Markdown fences: {"content":"text or empty string","calls":[{"name":"tool name","arguments":{}}]}.',
          'The content field is the answer to the user. calls contains only external tool requests; ' +
          'never pretend they have executed.',
          'A returned call is a proposal, not a completed action. Only a matching external tool result ' +
          'confirms execution.',
          'Never put dependent operations in the same calls array.',
        ]
          .filter(Boolean)
          .join('\n')
      : request.system

    const allowed = new Set(tools.map(tool => tool.name))
    let reply = await opencodeService.chat(
      { modelId: request.model, prompt, system, tools },
      request.signal,
    )

    // 模型偶尔会写一个 OpenCode 原生工具名（例如 bash）：那是它想自己动手，
    // 不能交给客户端执行。先纠正一次让它改口（Ferry 也是这么纠的），
    // 仍然不听话就把这类调用丢掉，只保留正文。
    const stray = reply.toolCalls.filter(call => !allowed.has(call.name))
    if (stray.length > 0 && tools.length > 0) {
      console.warn(
        `[OpenCode] model ${request.model} asked for a native tool (${stray.map(call => call.name).join(', ')}); retrying with the external tool list`,
      )
      const correction =
        'Your previous response asked for a tool that is not available to you. ' +
        'Reply again using only the external tools listed above, describing each call as ' +
        '{"name":"tool name","arguments":{}} inside the calls array. ' +
        'Do not run local commands and do not describe them as tool calls.'
      reply = await opencodeService.chat(
        {
          modelId: request.model,
          prompt,
          system: [system, correction].filter(Boolean).join('\n'),
          tools,
        },
        request.signal,
      )
    }

    reply.toolCalls = reply.toolCalls.filter(call => allowed.has(call.name))
    return reply
  }

  /**
   * 体检过的模型才配带工具：判定是"纯对话"的模型再给工具清单，它会转头去用
   * OpenCode 的原生工具（bash 之类），那一回合既没有客户端要的调用、又白烧额度。
   * 没有判定就现探一次，判定结果带缓存，不会每条请求都探。
   */
  private async resolveTools(
    modelId: string,
    requested: OpencodeRequest['tools'],
  ): Promise<NonNullable<OpencodeRequest['tools']>> {
    if (requested.length === 0) return requested

    let capability = opencodeService.capability(modelId)
    if (!capability) {
      const probed = await opencodeService.probeModels([modelId])
      capability = probed[modelId] ?? null
    }

    if (capability?.status === 'chat-only') {
      console.warn(
        `[OpenCode] model ${modelId} cannot express tool calls as an envelope (${capability.reason}); replying without tools`,
      )
      return []
    }
    return requested
  }

  static isOpencodeProvider(provider: Provider): boolean {
    return provider.id === 'opencode'
  }
}

export const opencodeAdapter = { OpencodeAdapter }
