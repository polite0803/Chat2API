/**
 * OpenCode 模型体检：判断某个模型能不能按「信封」产出工具调用。
 *
 * 为什么要体检：同一个模型，有的会老实按信封把"要调什么"写进 JSON，有的会转头去用
 * OpenCode 的原生工具（bash 之类）。后者对客户端毫无意义——客户端要的是"调用我的工具"，
 * 而不是让模型在自己那边动手。Ferry 用 `oc-ferry-finder` 做同一件事，并把判定缓存起来
 * （成功 6 小时、限流 10 分钟、下线 1 小时分别重试）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OpencodeBridge, BridgeReply } from './bridge.ts'

export type ProbeStatus = 'tool-capable' | 'chat-only'

export type ProbeReason =
  | 'envelope_with_tool_call'
  | 'envelope_without_tool_call'
  | 'native_tool_activity'
  /** 模型点了工具表里没有的名字（通常是把外部工具名当成原生工具发了） */
  | 'unknown_tool_call'
  /** 模型选对了信封工具，但参数过不了 schema */
  | 'envelope_schema_mismatch'
  | 'rate_limited'
  | 'model_unavailable'
  | 'timeout'
  | 'failed'

export interface ProbeResult {
  status: ProbeStatus
  reason: ProbeReason
  checkedAt: number
}

/**
 * 判定缓存的存活时间（毫秒），与 RuiC-oc-ferry 同口径。
 *
 * `unknown_tool_call` / `envelope_schema_mismatch` 这两条**故意只缓 10 分钟**：
 * 它们反映的是我们自己的提示词与 schema，不是模型能力。缓 6 小时等于让一次
 * 我们自己写坏的提示把模型锁进"纯对话"半天（原来的 `native_tool_activity`
 * 就踩了这个坑）。
 */
export const PROBE_TTL: Record<ProbeReason, number> = {
  envelope_with_tool_call: 6 * 60 * 60 * 1000,
  envelope_without_tool_call: 6 * 60 * 60 * 1000,
  native_tool_activity: 6 * 60 * 60 * 1000,
  unknown_tool_call: 10 * 60 * 1000,
  envelope_schema_mismatch: 10 * 60 * 1000,
  rate_limited: 10 * 60 * 1000,
  model_unavailable: 60 * 60 * 1000,
  timeout: 10 * 60 * 1000,
  failed: 10 * 60 * 1000,
}

export const PROBE_TOOL_NAME = 'probe_tool'

export function isFresh(result: ProbeResult, now = Date.now()): boolean {
  return now - result.checkedAt < (PROBE_TTL[result.reason] ?? 0)
}

/** 判定缓存：跨重启复用，按结果给不同 TTL */
export class ProbeCache {
  private entries = new Map<string, ProbeResult>()
  private readonly file: string

  constructor(file: string) {
    this.file = file
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, ProbeResult>
      for (const [modelId, result] of Object.entries(raw)) {
        if (result && typeof result.checkedAt === 'number') this.entries.set(modelId, result)
      }
    } catch {
      // 缓存坏了就当没有，重新体检
    }
  }

  get(modelId: string, now = Date.now()): ProbeResult | null {
    const result = this.entries.get(modelId)
    if (!result) return null
    if (!isFresh(result, now)) {
      this.entries.delete(modelId)
      return null
    }
    return result
  }

  set(modelId: string, result: ProbeResult): void {
    this.entries.set(modelId, result)
    this.save()
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.entries), null, 2), 'utf8')
    } catch {
      // 缓存写不进去不影响主流程
    }
  }
}

export function probeCachePath(root: string): string {
  return join(root, 'probe-cache.json')
}

/** 分类一次探测的结果（纯函数，便于测试） */
export function classifyProbe(reply: BridgeReply): ProbeResult {
  const called = reply.toolCalls.some(call => call.name === PROBE_TOOL_NAME)
  if (called) {
    return { status: 'tool-capable', reason: 'envelope_with_tool_call', checkedAt: Date.now() }
  }
  return { status: 'chat-only', reason: 'envelope_without_tool_call', checkedAt: Date.now() }
}

/** 把一次探测失败（抛错）分类成具体原因 */
export function classifyProbeFailure(error: unknown): ProbeResult {
  const message = error instanceof Error ? error.message : String(error)
  const checkedAt = Date.now()
  // 顺序有讲究：`envelope_violation` 是**我们**这边的问题（提示词 / schema），
  // 必须先于 `native_tool_activity` 判，否则又会被当成"模型想动手"缓存 6 小时。
  if (message.includes('envelope_violation')) {
    if (/did not satisfy the schema/i.test(message)) {
      return { status: 'chat-only', reason: 'envelope_schema_mismatch', checkedAt }
    }
    if (/as a native tool instead of writing it into the envelope/i.test(message)) {
      return { status: 'chat-only', reason: 'unknown_tool_call', checkedAt }
    }
    return { status: 'chat-only', reason: 'unknown_tool_call', checkedAt }
  }
  if (message.includes('native_tool_activity')) {
    return { status: 'chat-only', reason: 'native_tool_activity', checkedAt }
  }
  if (/HTTP 429|rate.?limit/i.test(message)) {
    return { status: 'chat-only', reason: 'rate_limited', checkedAt }
  }
  if (/HTTP 40[04]|model_not_found|unavailable/i.test(message)) {
    return { status: 'chat-only', reason: 'model_unavailable', checkedAt }
  }
  if (/abort|timeout/i.test(message)) {
    return { status: 'chat-only', reason: 'timeout', checkedAt }
  }
  return { status: 'chat-only', reason: 'failed', checkedAt }
}

/**
 * 探一个模型能不能按信封产出动作。
 *
 * 提示刻意做成"必须调用那个工具"，这样"只会聊天"的模型会返回没有调用的信封（= 纯对话可用）。
 *
 * **提示里必须写清信封形状**。运行时给 `format: json_schema` 的回合硬塞
 * `toolChoice: "required"`，若只写"调用 `probe_tool`"，模型很容易直接发一个
 * 名为 `probe_tool` 的原生 function call —— 那个名字不在运行时的工具表里，
 * 于是被改写成 `invalid`，探针就把一个本来能用的模型判成"纯对话"。
 * 这里明确要求它把调用写进 `calls` 数组，外部工具名才不会变成原生调用。
 */
const PROBE_PROMPT =
  `[user]\nCall the tool \`${PROBE_TOOL_NAME}\` with {"value":"probe"} by returning the JSON envelope. ` +
  `Reply with exactly one JSON object and no Markdown fences: ` +
  `{"content":"","calls":[{"name":"${PROBE_TOOL_NAME}","arguments":{"value":"probe"}}]}. ` +
  `Do not invoke any native tool; \`${PROBE_TOOL_NAME}\` is an external tool name that only goes inside the calls array.`

export async function probeModel(
  bridge: OpencodeBridge,
  modelId: string,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  try {
    const reply = await bridge.chat(
      {
        modelId,
        prompt: PROBE_PROMPT,
        system:
          'The only native tool you may invoke is StructuredOutput for formatting the response. ' +
          'Describe external tool calls only inside the calls array of that JSON object.',
        tools: [
          {
            name: PROBE_TOOL_NAME,
            description: 'A probe tool. Call it with the value "probe".',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
          },
        ],
      },
      signal,
    )
    return classifyProbe(reply)
  } catch (error) {
    return classifyProbeFailure(error)
  }
}
