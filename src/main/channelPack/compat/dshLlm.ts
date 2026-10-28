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

  constructor(message: string, code?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LlmError'
    this.code = code
  }
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
  'user-agent': 'chat2api-channel-pack',
})

export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED'
export const isContextWindowExceededError = (error: { code?: string } | undefined): boolean =>
  error?.code === CONTEXT_WINDOW_EXCEEDED_CODE
export const isQuotaExceededError = (error: { code?: string } | undefined): boolean =>
  error?.code === QUOTA_EXCEEDED_CODE
