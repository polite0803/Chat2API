/**
 * Proxy Service Module - Completions Route (Optional)
 * Implements /v1/completions route (legacy API)
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { streamHandler } from '../stream'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { autoRouter, isAutoModel } from '../autoRouter'
import type { AutoCandidate } from '../autoRouter'
import type { AccountSelection, ForwardResult } from '../types'
import { storeManager } from '../../store/store'
import { createTextCompletionChunkTransform, toTextCompletion } from '../utils/textCompletion'

const router = new Router({ prefix: '/v1' })

interface CompletionRequest {
  model: string
  prompt: string | string[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  n?: number
  stream?: boolean
  stop?: string | string[]
  echo?: boolean
}

/**
 * Generate request ID
 */
function generateRequestId(): string {
  return `cmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Convert prompt to messages format
 */
function promptToMessages(prompt: string | string[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (Array.isArray(prompt)) {
    return prompt.map((p, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: p,
    }))
  }

  return [{ role: 'user', content: prompt }]
}

/**
 * Handle Completions request
 */
router.post('/completions', async (ctx: Context) => {
  const startTime = Date.now()
  const requestId = generateRequestId()
  ctx.set('X-Request-Id', requestId)

  let request: CompletionRequest
  try {
    request = ctx.request.body as CompletionRequest
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
      },
    }
    return
  }

  if (!request.model) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: model',
        type: 'invalid_request_error',
        param: 'model',
      },
    }
    return
  }

  if (request.prompt === undefined) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: prompt',
        type: 'invalid_request_error',
        param: 'prompt',
      },
    }
    return
  }

  const config = storeManager.getConfig()
  const promptMessages = promptToMessages(request.prompt)
  const autoDecision = isAutoModel(request.model) && config.autoRouting?.enabled !== false
    ? autoRouter.select(
        {
          model: request.model,
          messages: promptMessages,
          stream: request.stream,
        },
        config.loadBalanceStrategy
      )
    : null

  let selection: AccountSelection | null = null
  if (!autoDecision) {
    const preferredProviderId = modelMapper.getPreferredProvider(request.model)
    const preferredAccountId = modelMapper.getPreferredAccount(request.model)

    selection = loadBalancer.selectAccount(
      request.model,
      config.loadBalanceStrategy,
      preferredProviderId,
      preferredAccountId
    )

    if (!selection) {
      ctx.status = 503
      ctx.body = {
        error: {
          message: `No available account for model: ${request.model}`,
          type: 'service_unavailable_error',
          code: 'no_available_account',
        },
      }
      return
    }
  }

  const firstCandidate = autoDecision?.candidates[0]

  if (autoDecision && !firstCandidate) {
    ctx.status = 503
    ctx.body = {
      error: {
        message: 'No available model for auto routing',
        type: 'service_unavailable_error',
        code: 'no_available_model',
      },
    }
    return
  }

  let account = selection ? selection.account : firstCandidate!.account
  let provider = selection ? selection.provider : firstCandidate!.provider
  let actualModel = selection ? selection.actualModel : firstCandidate!.actualModel
  let chosenCandidate: AutoCandidate | null = null

  const chatRequest = {
    // auto 路由时 chatRequest.model 由 forwardAutoCompletion 按候选替换
    model: autoDecision ? request.model : actualModel,
    messages: promptMessages,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    n: request.n,
    stream: request.stream,
    stop: request.stop,
  }

  proxyStatusManager.recordRequestStart(request.model, provider.id, account.id)

  try {
    let result: ForwardResult

    if (autoDecision) {
      const outcome = await requestForwarder.forwardAutoCompletion(
        chatRequest,
        autoDecision.candidates,
        {
          requestId,
          providerId: provider.id,
          accountId: account.id,
          model: request.model,
          actualModel,
          startTime,
          isStream: request.stream || false,
        }
      )

      if (!outcome) {
        ctx.status = 503
        ctx.body = {
          error: {
            message: 'Auto routing produced no forward result',
            type: 'service_unavailable_error',
            code: 'no_available_model',
          },
        }
        return
      }

      result = outcome.result
      chosenCandidate = outcome.candidate
      account = outcome.candidate.account
      provider = outcome.candidate.provider
      actualModel = outcome.candidate.actualModel
      ctx.set('X-Chat2API-Route', `${actualModel} (${provider.name})`)
    } else {
      result = await requestForwarder.forwardChatCompletion(
        chatRequest,
        account,
        provider,
        actualModel,
        {
          requestId,
          providerId: provider.id,
          accountId: account.id,
          model: request.model,
          actualModel,
          startTime,
          isStream: request.stream || false,
        }
      )
    }

    const latency = Date.now() - startTime

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)

      ctx.status = result.status || 500
      ctx.body = {
        error: {
          message: result.error || 'Request failed',
          type: 'api_error',
        },
      }
      return
    }

    proxyStatusManager.recordRequestSuccess(latency)

    if (autoDecision) {
      autoRouter.clearAccountCooldown(account.id)
      if (chosenCandidate) {
        autoRouter.rememberRoute(autoDecision.conversationKey, chosenCandidate)
      }
    }

    storeManager.updateAccount(account.id, {
      lastUsed: Date.now(),
      requestCount: (account.requestCount || 0) + 1,
      todayUsed: (account.todayUsed || 0) + 1,
    })

    storeManager.addLog('debug', `Request succeeded`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      actualModel,
      latency,
      isStream: request.stream,
    })

    if (request.stream && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      const textTransform = createTextCompletionChunkTransform()
      if (result.skipTransform) {
        result.stream.pipe(textTransform)
      } else {
        const chatTransform = streamHandler.createTransformStream(actualModel, requestId)
        result.stream.pipe(chatTransform).pipe(textTransform)
      }
      ctx.body = textTransform
    } else {
      ctx.set('Content-Type', 'application/json')
      ctx.body = toTextCompletion(result.body)
    }
  } catch (error) {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    ctx.status = 500
    ctx.body = {
      error: {
        message: error instanceof Error ? error.message : 'Unknown error',
        type: 'internal_error',
      },
    }
  }
})

export default router
