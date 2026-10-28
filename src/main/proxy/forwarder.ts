/**
 * Proxy Service Module - Request Forwarder
 * Forwards requests to corresponding API based on provider configuration
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'
import http2 from 'http2'
import { PassThrough } from 'stream'
import { Account, Provider } from '../store/types'
import {
  ForwardResult,
  ChatCompletionRequest,
  ProxyContext,
  type ChatMessage as ContextChatMessage,
} from './types'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { wrapStreamWithPlan } from './toolCalling/streamPlanWrapper'
import { OpencodeAdapter, buildCompletion, createDeferredCompletionStream } from './adapters/opencode'
import { AnthropicAdapter } from './adapters/anthropic'
import { renderTranscript } from '../opencode/prompt.ts'
import { ToolCallingEngine } from './toolCalling/ToolCallingEngine'
import type { ToolCallingTransformResult } from './toolCalling/types'
import { sessionManager } from './sessionManager'
import { loadBalancer } from './loadbalancer'
import { autoRouter, type AutoCandidate } from './autoRouter'
import { accountRuntime } from './accountRuntime'
import { stripUnsupportedForBuiltin } from './parameterPolicy'
import { createContextManagementService, SummaryGenerator } from './services/contextManagementService'
import { accountChannelManager } from '../providers/accountChannels/manager'

function shouldDeleteSession(): boolean {
  return sessionManager.shouldDeleteAfterChat()
}

type ProviderForwarder = {
  name: string
  matches: (provider: Provider) => boolean
  forward: (
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ) => Promise<ForwardResult>
}

/**
 * Request Forwarder
 */
export class RequestForwarder {
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  private readonly providerForwarders: ProviderForwarder[] = [
    {
      name: 'opencode',
      matches: OpencodeAdapter.isOpencodeProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardOpencode(request, account, provider, actualModel, startTime),
    },
    {
      name: 'anthropic-messages',
      matches: AnthropicAdapter.isAnthropicProvider,
      forward: (request, account, provider, actualModel) =>
        new AnthropicAdapter(provider, account).chatCompletion(request, actualModel),
    },
    {
      name: 'account-channel',
      matches: (provider: Provider) => provider.type === 'account',
      forward: (request, _account, _provider, actualModel) =>
        this.forwardAccountChannel(request, actualModel),
    },
  ]

  /**
   * Transform request for prompt-based tool calling
   * For models that don't support native function calling
   * Delegates tool normalization, prompt injection, and parser planning to ToolCallingEngine.
   */
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider
  ): ToolCallingTransformResult {
    const config = storeManager.getConfig().toolCallingConfig
    const engine = new ToolCallingEngine(config)

    return engine.transformRequest({
      request,
      provider: provider ?? {
        id: 'custom',
        name: 'Custom',
        type: 'custom',
        authType: 'token',
        apiEndpoint: '',
        headers: {},
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
      actualModel: request.model,
      requestId: request.requestId,
    })
  }

  private applyToolCallsToResponse(result: any, transformed: ToolCallingTransformResult): void {
    const engine = new ToolCallingEngine(storeManager.getConfig().toolCallingConfig)
    engine.applyNonStreamResponse(result, transformed.plan)
  }

  /**
   * Create summary generator function for context management
   * Uses the current provider and account to generate summaries
   */
  private createSummaryGenerator(
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): SummaryGenerator {
    return async (messages: ContextChatMessage[], prompt?: string): Promise<string> => {
      try {
        console.log('[SummaryGenerator] Generating summary for', messages.length, 'messages')

        const summaryPrompt = prompt || 'Please summarize the following conversation concisely, keeping key information and context:'

        const conversationText = messages
          .map(msg => {
            const role = msg.role.toUpperCase()
            const content = typeof msg.content === 'string'
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content
                    .filter(part => part.type === 'text' && part.text)
                    .map(part => part.text)
                    .join('\n')
                : ''
            return `${role}: ${content}`
          })
          .join('\n\n')

        const summaryRequest: ChatCompletionRequest = {
          model: actualModel,
          messages: [
            {
              role: 'system',
              content: summaryPrompt,
            },
            {
              role: 'user',
              content: conversationText,
            },
          ],
          stream: false,
          temperature: 0.3,
        }

        const result = await this.doForward(
          summaryRequest,
          account,
          provider,
          actualModel,
          context
        )

        if (result.success && result.body) {
          const summaryContent = result.body.choices?.[0]?.message?.content || ''
          console.log('[SummaryGenerator] Summary generated successfully, length:', summaryContent.length)
          return summaryContent
        }

        console.warn('[SummaryGenerator] Failed to generate summary:', result.error)
        return 'Failed to generate conversation summary.'
      } catch (error) {
        console.error('[SummaryGenerator] Error generating summary:', error)
        return 'Failed to generate conversation summary due to an error.'
      }
    }
  }

  /**
   * Forward Chat Completions Request
   */
  async forwardChatCompletion(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext,
    options: { maxRetries?: number } = {}
  ): Promise<ForwardResult> {
    const startTime = Date.now()
    const config = storeManager.getConfig()
    const maxRetries = options.maxRetries ?? config.retryCount

    // stream_options 等客户端默认参数对内建供应商无效，发送前丢弃而不是报 400
    request = stripUnsupportedForBuiltin(request, provider)

    // 记录在途与 RPM：仅用于路由打分，下一次请求即可读到
    accountRuntime.beginAttempt(account.id)

    let lastError: string | undefined
    let lastStatus: number | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await this.delay(5000)
      }

      let modifiedRequest = request

      if (config.contextManagement?.enabled && modifiedRequest.messages && modifiedRequest.messages.length > 0) {
        try {
          const summaryGenerator = this.createSummaryGenerator(
            account,
            provider,
            actualModel,
            context
          )

          const contextService = createContextManagementService(
            config.contextManagement || {},
            summaryGenerator
          )

          const originalCount = modifiedRequest.messages.length
          const contextMessages: ContextChatMessage[] = modifiedRequest.messages.map(msg => ({
            ...msg,
            role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
            content: msg.content,
            timestamp: Date.now(),
          }))

          const processResult = await contextService.process(contextMessages)

          if (processResult.finalCount !== originalCount) {
            console.log(
              `[Forwarder] Context management applied: ${originalCount} -> ${processResult.finalCount} messages`
            )

            processResult.strategyResults.forEach(result => {
              if (result.trimmed) {
                console.log(
                  `[Forwarder] Strategy ${result.strategyName}: ${result.originalCount} -> ${result.processedCount} messages`
                )
              }
            })

            modifiedRequest = {
              ...modifiedRequest,
              messages: processResult.messages.map(msg => ({ ...msg })),
            }
          }
        } catch (error) {
          console.error('[Forwarder] Context management failed:', error)
        }
      }

      try {
        const result = await this.doForward(modifiedRequest, account, provider, actualModel, context)

        if (result.success) {
          accountRuntime.recordSuccess(account.id)
          accountRuntime.endAttempt(account.id)
          return result
        }

        lastError = result.error
        lastStatus = result.status

        // 429 是上游限流：同一个账号隔 5 秒再打一次基本没用，只会把配额和等待
        // 一起赔进去（OpenCode 配额耗尽时一次失败就要 20 多秒，重试 3 次就是两分钟）。
        // 冷却记录照旧，循环到此为止。
        if (result.status && result.status < 500) {
          break
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error'
      }
    }

    accountRuntime.endAttempt(account.id)

    // 429 说明账号已被上游限流，记录指数退避冷却，供后续 auto 路由避开
    if (lastStatus === 429) {
      accountRuntime.recordFailure(account.id, 429)
    }

    return {
      success: false,
      // 丢掉状态码的话，路由层会把它映射成 500，客户端就看不到"被限流/请求有问题"
      status: lastStatus,
      error: lastError || 'Request failed after retries',
      latency: Date.now() - startTime,
    }
  }

  /**
   * Auto 路由执行：按候选顺序尝试，在流式首包之前失败时切换到下一个账号/供应商。
   *
   * 每次尝试把 request.model 替换为候选的显示名，与普通映射请求的上下文一致：
   * forwarder 之后会以 actualModel 作为上游模型、显示名作为 originalModel 传给 adapter。
   */
  async forwardAutoCompletion(
    request: ChatCompletionRequest,
    candidates: AutoCandidate[],
    context: ProxyContext
  ): Promise<{ result: ForwardResult; candidate: AutoCandidate } | null> {
    let last: { result: ForwardResult; candidate: AutoCandidate } | null = null

    for (const candidate of candidates) {
      const attemptRequest: ChatCompletionRequest = {
        ...request,
        model: candidate.displayName,
      }
      const attemptContext: ProxyContext = {
        ...context,
        providerId: candidate.provider.id,
        accountId: candidate.account.id,
        actualModel: candidate.actualModel,
      }

      const result = await this.forwardChatCompletion(
        attemptRequest,
        candidate.account,
        candidate.provider,
        candidate.actualModel,
        attemptContext,
        { maxRetries: 0 }
      )

      last = { result, candidate }

      if (result.success) {
        return last
      }

      if (!this.isFailoverEligible(result.status)) {
        return last
      }

      // 429 的冷却已由 forwardChatCompletion 记录，这里只补记 5xx / 网络错误
      if (result.status !== 429) {
        autoRouter.markAccountCooldown(candidate.account.id, result.status)
      }
      loadBalancer.markAccountFailed(candidate.account.id)
    }

    return last
  }

  /** 429 / 5xx / 无状态码（网络错误、超时）才值得换目标；4xx 换目标没有意义 */
  private isFailoverEligible(status?: number): boolean {
    if (status === undefined) return true
    return status === 429 || status >= 500
  }

  /**
   * 账号渠道（account channel）转发。
   *
   * 上游协议、账号池、积分与重试全部在渠道 Worker 里；这里只做两件事：
   * 把内部字段（`requestId` / `signal` / `originalModel`）摘掉后交出 OpenAI 形状的
   * 请求体，以及把 Worker 的 SSE 文本原样接到响应流上（`skipTransform`）。
   * 不做工具提示注入：渠道适配器都支持原生工具调用。
   */
  private async forwardAccountChannel(
    request: ChatCompletionRequest,
    actualModel: string
  ): Promise<ForwardResult> {
    const startTime = Date.now()
    const requestId = request.requestId ?? `channel-${startTime}`
    const {
      requestId: _internalRequestId,
      signal: _signal,
      originalModel: _originalModel,
      ...rest
    } = request
    const openAi = { ...rest, model: actualModel } as Record<string, unknown>

    try {
      if (request.stream !== true) {
        const body = await accountChannelManager.complete({ requestId, model: actualModel, openAi })
        return {
          success: true,
          status: 200,
          body,
          latency: Date.now() - startTime,
          providerSessionId: requestId,
        }
      }
      const stream = await accountChannelManager.openStream({ requestId, model: actualModel, openAi })
      return {
        success: true,
        status: 200,
        stream,
        // SSE 已由渠道包按 OpenAI 规范投影，这里再转一次只会让流形状漂移。
        skipTransform: true,
        // 响应头先回、正文随后（首字要等上游），耗时口径按整笔计。
        deferred: true,
        latency: Date.now() - startTime,
        providerSessionId: requestId,
      }
    } catch (error) {
      const failure = error as { message?: string; status?: number }
      return {
        success: false,
        status: failure.status ?? 502,
        error: failure.message ?? '渠道请求失败',
        latency: Date.now() - startTime,
      }
    }
  }

  /**
   * Execute Forward
   */
  private async doForward(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    const dedicatedForwarder = this.providerForwarders.find(forwarder => forwarder.matches(provider))
    if (dedicatedForwarder) {
      return dedicatedForwarder.forward(request, account, provider, actualModel, startTime)
    }

    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const chatPath = provider.chatPath || '/chat/completions'
      const url = this.buildUrl(provider, chatPath)
      const headers = this.buildHeaders(provider, account)
      const body = this.buildRequestBody({ ...request, messages: transformed.messages }, actualModel, account)

      const axiosConfig: AxiosRequestConfig = {
        method: 'POST',
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: request.stream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(axiosConfig)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (request.stream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: wrapStreamWithPlan(response.data, transformed.plan) as any,
          skipTransform: transformed.plan.shouldParseResponse,
          latency,
        }
      }

      this.applyToolCallsToResponse(response.data, transformed)

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      if (error instanceof AxiosError) {
        return {
          success: false,
          status: error.response?.status,
          error: error.message,
          latency,
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * OpenCode：驱动本机运行时完成一次 agent 回合。
   * 免费模型单轮 30–60 秒，且它不是 token 流，所以流式响应是一次性分片（见 adapters/opencode.ts）。
   */
  private async forwardOpencode(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    const id = `chatcmpl-${Date.now().toString(36)}`
    try {
      // 工具清单仍走托管层的判定（tool_choice / 强制工具），
      // 但 opencode 的档案让托管层既不注入提示也不解析响应 —— 工具由 OpenCode 的信封翻译。
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const tools = transformed.plan.toolChoiceMode === 'none' ? [] : (transformed.tools ?? [])
      // 先把转录渲染出来：图片这类不支持的内容要在**开流之前**就报 400，
      // 否则流已经发出去了，只能以一个错误帧收场。
      const prompt = renderTranscript(transformed.messages as never)
      const adapter = new OpencodeAdapter(provider, account)
      const runTurn = () =>
        adapter.chatCompletion({
          model: actualModel,
          messages: transformed.messages as never,
          prompt,
          stream: request.stream,
          tools: tools as never,
          toolChoice: transformed.plan.toolChoiceMode,
          forcedToolName: transformed.plan.forcedToolName ?? null,
          parallelToolCalls: transformed.plan.parallelToolCalls,
          signal: request.signal,
        })

      if (request.stream) {
        // 响应头先走：一个回合 30–60 秒（首次还要拉起运行时），
        // 等回合跑完再开流的话，客户端的响应头超时（AxAgent 是 10 秒）
        // 会先判失败再回退，这条链路永远打不通。
        const deferred = createDeferredCompletionStream(id, actualModel)
        void runTurn().then(
          reply => deferred.complete(reply),
          error => deferred.fail(error),
        )
        return {
          success: true,
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          stream: deferred.stream,
          skipTransform: true,
          latency: Date.now() - startTime,
          deferred: true,
        }
      }

      const reply = await runTurn()
      const latency = Date.now() - startTime

      return {
        success: true,
        status: 200,
        body: buildCompletion(id, actualModel, reply),
        latency,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 免费池配额用完是限流，不是我们这边的故障：报 429，客户端才知道该退避
      const quotaExhausted = /free usage limit/i.test(message)
      // 图片这类我们吃不下的内容属于请求问题，不是网关故障
      const unsupported = error instanceof Error && error.name === 'UnsupportedContentError'
      return {
        success: false,
        status: unsupported ? 400 : quotaExhausted ? 429 : 502,
        error: message,
        latency: Date.now() - startTime,
      }
    }
  }

  /**
   * Build URL
   */
  private buildUrl(provider: Provider, path: string): string {
    let baseUrl = provider.apiEndpoint

    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1)
    }

    if (!path.startsWith('/')) {
      path = '/' + path
    }

    if (baseUrl.includes('/v1') && path.startsWith('/v1')) {
      path = path.slice(3)
    }

    return `${baseUrl}${path}`
  }

  /**
   * Build Request Headers
   */
  private buildHeaders(provider: Provider, account: Account): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...provider.headers,
    }

    const credentials = account.credentials
    const apiKey = credentials.token || credentials.apiKey || credentials.accessToken || credentials.refreshToken

    // Aggregate endpoints declare where their key goes (anthropic: x-api-key,
    // azure: api-key); everything else keeps the OpenAI Authorization header.
    if (apiKey) {
      const headerName = provider.authHeader || 'Authorization'
      const prefix = provider.authPrefix ?? 'Bearer '
      headers[headerName] = `${prefix}${apiKey}`
    }

    if (credentials.cookie) {
      headers['Cookie'] = credentials.cookie
    }

    if (credentials.sessionKey) {
      headers['X-Session-Key'] = credentials.sessionKey
    }

    return headers
  }

  /**
   * Build Request Body
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    actualModel: string,
    account: Account
  ): any {
    const body: any = {
      model: actualModel,
      messages: request.messages,
      stream: request.stream || false,
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p
    }

    if (request.n !== undefined) {
      body.n = request.n
    }

    if (request.stop !== undefined) {
      body.stop = request.stop
    }

    if (request.max_tokens !== undefined) {
      body.max_tokens = request.max_tokens
    }

    if (request.presence_penalty !== undefined) {
      body.presence_penalty = request.presence_penalty
    }

    if (request.frequency_penalty !== undefined) {
      body.frequency_penalty = request.frequency_penalty
    }

    if (request.logit_bias !== undefined) {
      body.logit_bias = request.logit_bias
    }

    if (request.user !== undefined) {
      body.user = request.user
    }

    return body
  }

  /**
   * Extract Response Headers
   */
  private extractHeaders(headers: any): Record<string, string> {
    const result: Record<string, string> = {}

    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result[key] = value
      } else if (Array.isArray(value)) {
        result[key] = value.join(', ')
      }
    }

    return result
  }

  /**
   * Extract Error Message
   */
  private extractErrorMessage(response: AxiosResponse): string {
    if (response.data) {
      if (typeof response.data === 'string') {
        return response.data
      }

      if (response.data.error?.message) {
        return response.data.error.message
      }

      if (response.data.message) {
        return response.data.message
      }

      if (response.data.msg) {
        return response.data.msg
      }

      try {
        return JSON.stringify(response.data)
      } catch {
        return 'Unknown error'
      }
    }

    return `HTTP ${response.status}`
  }

  /**
   * Delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Forward Request to Specified URL
   */
  async forwardToUrl(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: any,
    isStream: boolean = false
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    try {
      const config: AxiosRequestConfig = {
        method,
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: isStream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(config)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (isStream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }
}

export const requestForwarder = new RequestForwarder()
export default requestForwarder
