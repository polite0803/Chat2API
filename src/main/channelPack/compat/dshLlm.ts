/**
 * `@deepseek-ai/dsh-llm` 的宿主垫片。
 *
 * 上游 channel-pack 把 LLM 契约作为外部依赖，由宿主注入。这里只实现它实际用到的
 * 面（适配器基类、错误类型、少量标记函数），语义与上游 standalone 的契约一致；
 * 升级 vendor 时若新增导入，会在打包阶段直接报“未导出”，不会静默漂移。
 */
import { randomUUID } from 'node:crypto'

export class LlmAdapter {
  prepareCall(_provider: string, _model: string, _signal?: AbortSignal): Promise<unknown> {
    throw new Error('渠道未实现 prepareCall')
  }

  listModels(_provider: string): Promise<unknown> {
    throw new Error('渠道未实现模型目录')
  }

  resolveModel(_provider: string, _model: string, _signal?: AbortSignal): Promise<unknown> {
    throw new Error('渠道未实现模型解析')
  }

  stream(_options: unknown): AsyncIterable<unknown> {
    throw new Error('渠道未实现流式调用')
  }
}

export class LlmError extends Error {
  code?: string

  /**
   * 上游事实（与真包 `LlmFailure` 同名同形）。
   *
   * ⚠️ **必须真落地，不能当 `ErrorOptions` 丢掉**：`openai-gateway/stream.ts`
   * 的 `failureToOpenAiError()` 明确从 `e.failure.status` 取上游状态码
   * （注释原文：「`LlmError` 的 `status` **不是**顶层属性（实测
   * `'status' in e === false`），它只落在 `e.failure.status`」）。
   *
   * 旧垫片把第三参当普通 `ErrorOptions`，`{ status }` 被静默丢弃 —— 于是
   * 404（模型不存在）/403（套餐档位）/429 一律退化成 502，客户端会把
   * **确定性**失败当成可重试的服务端故障反复重试。`opencode-adapter.ts`
   * 也按同一契约读 `failure.status` / `failure.providerRetryAfterMs`。
   */
  failure?: LlmFailure

  /**
   * 顶层镜像。
   *
   * 少数调用方按 `error.status` 读（如 qoder 的 `isUpstreamTimeoutError()`
   * 判 `status === 504`），真包里两种读法都成立，这里保持一致。
   */
  status?: number

  constructor(message: string, code?: string, options?: ErrorOptions & LlmFailure) {
    super(message, options)
    this.name = 'LlmError'
    this.code = code
    const status = options?.status
    const providerRetryAfterMs = options?.providerRetryAfterMs
    if (typeof status !== 'number' && typeof providerRetryAfterMs !== 'number') return
    this.failure = {
      ...(typeof status === 'number' ? { status } : {}),
      ...(typeof providerRetryAfterMs === 'number' ? { providerRetryAfterMs } : {}),
    }
    if (typeof status === 'number') this.status = status
  }
}

/** `@deepseek-ai/dsh-llm` 的 `LlmFailure`（只声明本仓库实际读取的字段）。 */
export interface LlmFailure {
  status?: number
  providerRetryAfterMs?: number
}

export const credentialRef = <T>(value: T): T => value
export const ReasoningEffortId = <T>(value: T): T => value
export const ToolCallId = <T>(value: T): T => value
export const createUserMessage = (value: Record<string, unknown>) => ({
  id: randomUUID(),
  role: 'user',
  ...value,
})
export const attributionHeaders = (): Record<string, string> => ({
  'user-agent': 'modelport-channel-pack',
})

export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED'
export const isContextWindowExceededError = (error: { code?: string } | undefined): boolean =>
  error?.code === CONTEXT_WINDOW_EXCEEDED_CODE
export const isQuotaExceededError = (error: { code?: string } | undefined): boolean =>
  error?.code === QUOTA_EXCEEDED_CODE
