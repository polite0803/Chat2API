export interface DeepSeekChatOptionInput {
  model: string
  web_search?: boolean
  reasoning_effort?: string
}

export interface DeepSeekChatOptions {
  modelType: 'default' | 'expert' | 'vision'
  searchEnabled: boolean
  thinkingEnabled: boolean
}

export function resolveDeepSeekChatOptions(
  request: DeepSeekChatOptionInput,
  _prompt: string = ''
): DeepSeekChatOptions {
  const modelLower = request.model.toLowerCase()
  const isExpertModel = modelLower.includes('expert')
  const isVisionModel = !isExpertModel && modelLower.includes('vision')
  const isSearchAlias = modelLower.includes('search')
  const isThinkingAlias = modelLower.includes('think')
    || modelLower.includes('r1')
    || modelLower.includes('reasoner')

  return {
    modelType: isExpertModel ? 'expert' : isVisionModel ? 'vision' : 'default',
    searchEnabled: Boolean(request.web_search) || isSearchAlias,
    thinkingEnabled: Boolean(request.reasoning_effort)
      || isThinkingAlias,
  }
}

export type KimiScenario = 'SCENARIO_K2D5' | 'SCENARIO_K2D6' | 'SCENARIO_OK_COMPUTER' | 'SCENARIO_CHAT'

/** Scenario each model id is served under, read from the site's own model list. */
const KIMI_SCENARIOS: Record<string, KimiScenario> = {
  'k3-agent': 'SCENARIO_OK_COMPUTER',
  'k28-agent-preview': 'SCENARIO_OK_COMPUTER',
  'k2d6-chat': 'SCENARIO_CHAT',
}

export function resolveKimiScenario(model: string): KimiScenario {
  const key = model.trim().toLowerCase()
  const known = KIMI_SCENARIOS[key]
  if (known) return known
  // pre-K3 ids keep their historical scenario until those ids disappear upstream
  return key.includes('k2.6') ? 'SCENARIO_K2D6' : 'SCENARIO_K2D5'
}

export function createKimiChatPayload(options: {
  model: string
  content: string
  enableWebSearch: boolean
  enableThinking: boolean
}) {
  const scenario = resolveKimiScenario(options.model)

  return {
    scenario,
    chat_id: '',
    tools: options.enableWebSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
    message: {
      parent_id: '',
      role: 'user',
      blocks: [{
        message_id: '',
        text: { content: options.content }
      }],
      scenario,
    },
    options: {
      thinking: options.enableThinking
    }
  }
}

export function encodeKimiGrpcFrame(payload: unknown): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const frameBuffer = Buffer.alloc(5 + jsonBuffer.length)
  frameBuffer.writeUInt8(0, 0)
  frameBuffer.writeUInt32BE(jsonBuffer.length, 1)
  jsonBuffer.copy(frameBuffer, 5)
  return frameBuffer
}
