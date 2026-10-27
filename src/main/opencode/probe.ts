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
  | 'rate_limited'
  | 'model_unavailable'
  | 'timeout'
  | 'failed'

export interface ProbeResult {
  status: ProbeStatus
  reason: ProbeReason
  checkedAt: number
}

/** 判定缓存的存活时间（毫秒），与 RuiC-oc-ferry 同口径 */
export const PROBE_TTL: Record<ProbeReason, number> = {
  envelope_with_tool_call: 6 * 60 * 60 * 1000,
  envelope_without_tool_call: 6 * 60 * 60 * 1000,
  native_tool_activity: 6 * 60 * 60 * 1000,
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
 * 提示刻意做成"必须调用那个工具"，这样"只会聊天"的模型会返回没有调用的信封（= 纯对话可用）。
 */
export async function probeModel(
  bridge: OpencodeBridge,
  modelId: string,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  try {
    const reply = await bridge.chat(
      {
        modelId,
        prompt: `[user]\nCall the tool \`${PROBE_TOOL_NAME}\` with {"value":"probe"}. Do not answer with text.`,
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
