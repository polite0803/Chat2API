import type { ToolProtocolAdapter } from './base.ts'
import type { ToolParseContext } from '../types.ts'
import {
  addParameter,
  buildToolCall,
  createParseResult,
  detectMarkers,
  escapeXmlAttribute,
  parseJsonValue,
  renderToolList,
  stripFencedCodeBlocks,
  toolNames,
} from './shared.ts'

const MODELPORT_START = '<|MODELPORT|tool_calls>'
const MODELPORT_END = '</|MODELPORT|tool_calls>'
const XML_START = '<tool_calls>'

export const managedXmlProtocol: ToolProtocolAdapter = {
  id: 'managed_xml',

  renderPrompt(tools) {
    return `## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.
Use only the exact tool names listed below. Do not rename, camelCase, translate, shorten, or invent tool names.

${renderToolList(tools)}

When calling tools, respond with only this ModelPort XML block:

<|MODELPORT|tool_calls><|MODELPORT|invoke name="exact_tool_name" tool_call_id="call_id"><|MODELPORT|parameter name="argument"><![CDATA[value]]></|MODELPORT|parameter></|MODELPORT|invoke></|MODELPORT|tool_calls>

Tool results will be provided as ModelPort XML result blocks:

<|MODELPORT|tool_result tool_call_id="call_id"><![CDATA[result]]></|MODELPORT|tool_result>`
  },

  detectStart(buffer) {
    return detectMarkers(buffer, [MODELPORT_START, XML_START])
  },

  parse(content: string, context: ToolParseContext) {
    const parseable = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls: ReturnType<typeof buildToolCall>[] = []

    parseBlocks(parseable, {
      blockPattern: /<\|MODELPORT\|tool_calls>([\s\S]*?)<\/\|MODELPORT\|tool_calls>/g,
      invokePattern: /<\|MODELPORT\|invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/\|MODELPORT\|invoke>/g,
      parameterPattern: /<\|MODELPORT\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|MODELPORT\|parameter>/g,
      rawMatches,
      invalidToolNames,
      allowedNames,
      toolCalls,
    })

    parseBlocks(parseable, {
      blockPattern: /<tool_calls>([\s\S]*?)<\/tool_calls>/g,
      invokePattern: /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/g,
      parameterPattern: /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g,
      rawMatches,
      invalidToolNames,
      allowedNames,
      toolCalls,
    })

    if (toolCalls.length === 0) {
      return createParseResult({
        content,
        toolCalls,
        protocol: rawMatches.length > 0 ? 'managed_xml' : 'unknown',
        rawMatches,
        invalidToolNames,
      })
    }

    const cleanContent = rawMatches.reduce((acc, raw) => acc.replace(raw, ''), parseable).trim()
    return createParseResult({
      content: cleanContent,
      toolCalls,
      protocol: 'managed_xml',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    const invokes = calls.map((call) => {
      const args = safeParseObject(call.arguments)
      const entries = Object.entries(args)
      const params = entries.length > 0
        ? entries
            .map(([name, value]) => {
              const text = typeof value === 'string' ? value : JSON.stringify(value)
              return `<|MODELPORT|parameter name="${escapeXmlAttribute(name)}"><![CDATA[${text}]]></|MODELPORT|parameter>`
            })
            .join('')
        : call.arguments && call.arguments.trim() && call.arguments.trim() !== '{}'
          ? `<|MODELPORT|parameter name="arguments"><![CDATA[${call.arguments}]]></|MODELPORT|parameter>`
          : ''
      return `<|MODELPORT|invoke name="${escapeXmlAttribute(call.name)}" tool_call_id="${escapeXmlAttribute(call.id)}">${params}</|MODELPORT|invoke>`
    })
    return `${MODELPORT_START}${invokes.join('')}${MODELPORT_END}`
  },

  formatToolResult(result) {
    return `<|MODELPORT|tool_result tool_call_id="${escapeXmlAttribute(result.toolCallId)}"><![CDATA[${result.content}]]></|MODELPORT|tool_result>`
  },
}

interface ParseBlockOptions {
  blockPattern: RegExp
  invokePattern: RegExp
  parameterPattern: RegExp
  rawMatches: string[]
  invalidToolNames: string[]
  allowedNames: Set<string>
  toolCalls: ReturnType<typeof buildToolCall>[]
}

function parseBlocks(content: string, options: ParseBlockOptions): void {
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = options.blockPattern.exec(content)) !== null) {
    options.rawMatches.push(blockMatch[0])
    let invokeMatch: RegExpExecArray | null

    while ((invokeMatch = options.invokePattern.exec(blockMatch[1])) !== null) {
      const name = invokeMatch[1].trim()
      if (!options.allowedNames.has(name)) {
        options.invalidToolNames.push(name)
        continue
      }

      const args: Record<string, unknown> = {}
      let parameterMatch: RegExpExecArray | null
      options.parameterPattern.lastIndex = 0
      while ((parameterMatch = options.parameterPattern.exec(invokeMatch[2])) !== null) {
        addParameter(args, parameterMatch[1].trim(), parseJsonValue(parameterMatch[2]))
      }

      options.toolCalls.push(
        buildToolCall(`call_${options.toolCalls.length}`, options.toolCalls.length, name, JSON.stringify(args), invokeMatch[0]),
      )
    }
  }
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
