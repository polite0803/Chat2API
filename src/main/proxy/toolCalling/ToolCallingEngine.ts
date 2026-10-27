import type { ChatCompletionRequest, ChatMessage } from '../types.ts'
import type { Provider } from '../../store/types.ts'
import {
  DEFAULT_TOOL_CALLING_CONFIG,
  normalizeToolCallingConfig,
  type ToolCallingConfig,
} from '../../../shared/toolCalling.ts'
import { getToolProtocol } from './protocols/index.ts'
import { getToolClientAdapter } from './clientAdapters/index.ts'
import { buildToolCallingRuntimePlan } from './runtimePlan.ts'
import type { NormalizedToolDefinition, ToolCallingPlan, ToolCallingTransformResult, ToolProtocolId } from './types.ts'

export class ToolCallingEngine {
  private readonly config: ToolCallingConfig

  constructor(config: Partial<ToolCallingConfig> = {}) {
    this.config = normalizeToolCallingConfig({
      ...DEFAULT_TOOL_CALLING_CONFIG,
      ...config,
      advanced: {
        ...DEFAULT_TOOL_CALLING_CONFIG.advanced,
        ...config.advanced,
      },
    })
  }

  transformRequest(input: {
    request: ChatCompletionRequest
    provider: Provider
    actualModel: string
    requestId?: string
  }): ToolCallingTransformResult {
    const { request, provider, actualModel, requestId } = input
    const adapter = getToolClientAdapter(this.config.clientAdapterId)
    const clientRequest = adapter.normalizeRequest(request)
    const plan = buildToolCallingRuntimePlan({
      requestId,
      providerId: provider.id,
      actualModel,
      model: request.model,
      config: this.config,
      clientRequest,
    })
    const shouldInjectPrompt = plan.shouldInjectPrompt

    if (!shouldInjectPrompt) {
      return {
        messages: request.messages,
        tools: plan.mode === 'disabled' ? request.tools : undefined,
        plan,
      }
    }

    return {
      messages: injectPrompt(request.messages, renderPrompt(plan, this.config)),
      tools: undefined,
      plan,
    }
  }

  applyNonStreamResponse(result: any, plan: ToolCallingPlan): void {
    if (!plan.shouldParseResponse) return

    const message = result?.choices?.[0]?.message
    if (!message || typeof message.content !== 'string') return

    const parseResult = parseSelectedProtocol(message.content, plan)
    plan.diagnostics.parserFormat = parseResult.protocol
    plan.diagnostics.parsedToolCallCount = parseResult.toolCalls.length
    plan.diagnostics.invalidToolNames = parseResult.invalidToolNames
    plan.diagnostics.malformedReason = parseResult.malformedReason

    if (parseResult.toolCalls.length === 0) return

    message.content = parseResult.content || null
    const requestId = plan.diagnostics?.requestId
    const parsedCalls = plan.parallelToolCalls === false
      ? parseResult.toolCalls.slice(0, 1)
      : parseResult.toolCalls
    message.tool_calls = parsedCalls.map((toolCall, index) => ({
      ...toolCall,
      index,
      id: requestId ? `call_${requestId}-${index}` : toolCall.id || `call_${index}`,
    }))

    const choice = result.choices[0]
    choice.finish_reason = 'tool_calls'
  }
}

function renderPrompt(plan: ToolCallingPlan, config: ToolCallingConfig): string {
  const prompt = getToolProtocol(plan.protocol).renderPrompt(plan.tools)
  const directive = buildToolChoiceDirective(plan)
  const withDirective = directive ? `${prompt}\n\n${directive}` : prompt
  const customPromptTemplate = config.advanced.customPromptTemplate
  if (!customPromptTemplate) return withDirective

  return customPromptTemplate
    .replace(/\{\{tools\}\}/g, withDirective)
    .replace(/\{\{tool_names\}\}/g, plan.tools.map((tool) => tool.name).join(', '))
    .replace(/\{\{format\}\}/g, plan.protocol)
}

function buildToolChoiceDirective(plan: ToolCallingPlan): string | undefined {
  const directives: string[] = []
  if (plan.forcedToolName) {
    directives.push(`You must call the tool "${plan.forcedToolName}" in this turn. Do not answer with plain text.`)
  } else if (plan.toolChoiceMode === 'required') {
    directives.push('You must call at least one of the available tools in this turn. Do not answer with plain text.')
  }
  if (plan.parallelToolCalls === false) {
    directives.push('Call at most one tool in this turn.')
  }
  return directives.length > 0 ? directives.join(' ') : undefined
}

function injectPrompt(messages: ChatMessage[], prompt: string): ChatMessage[] {
  const [first, ...rest] = messages
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${first.content}\n\n${prompt}` }, ...rest]
  }

  return [{ role: 'system', content: prompt }, ...messages]
}

function parseSelectedProtocol(content: string, plan: ToolCallingPlan) {
  const selected = getToolProtocol(plan.protocol)
  return selected.parse(content, { tools: plan.tools, protocol: plan.protocol })
}
