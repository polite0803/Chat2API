import { PassThrough } from 'stream'
import { ToolStreamParser } from './ToolStreamParser.ts'
import type { ToolCallingPlan } from './types.ts'

/**
 * Rewrites an OpenAI-shaped SSE stream so that managed tool-call markup produced by
 * providers whose stream handlers were never given a plan still reaches the client
 * as tool_calls instead of assistant text.
 */
export function wrapStreamWithPlan(stream: NodeJS.ReadableStream, plan: ToolCallingPlan): NodeJS.ReadableStream {
  if (!plan.shouldParseResponse) return stream

  const parser = new ToolStreamParser(plan)
  const out = new PassThrough()
  let buffer = ''
  let doneSent = false
  let pendingFinish: any = null
  let baseChunk: any = null
  let sawToolCalls = false

  const emittedToolCalls = () => parser.hasEmittedToolCall() || sawToolCalls

  const writeChunks = (chunks: any[]) => {
    for (const chunk of chunks) {
      out.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
  }

  const flushParser = () => {
    if (!baseChunk) return
    writeChunks(parser.flush(baseChunk))
  }

  const writeFinishAndDone = () => {
    if (pendingFinish) {
      const finishReason = emittedToolCalls() ? 'tool_calls' : pendingFinish.choices?.[0]?.finish_reason || 'stop'
      out.write(
        `data: ${JSON.stringify({
          ...pendingFinish,
          choices: [{ ...(pendingFinish.choices?.[0] || { index: 0 }), delta: {}, finish_reason: finishReason }],
        })}\n\n`
      )
      pendingFinish = null
    }
    if (!doneSent) {
      doneSent = true
      out.write('data: [DONE]\n\n')
    }
  }

  const handleEvent = (event: string) => {
    const line = event.split('\n').find((entry) => entry.startsWith('data:'))
    if (!line) {
      out.write(`${event}\n\n`)
      return
    }

    const payload = line.slice(5).trim()
    if (payload === '[DONE]') {
      flushParser()
      writeFinishAndDone()
      return
    }

    let parsed: any
    try {
      parsed = JSON.parse(payload)
    } catch {
      out.write(`${event}\n\n`)
      return
    }

    const choice = parsed?.choices?.[0]
    if (!choice) {
      out.write(`${event}\n\n`)
      return
    }

    if (choice.finish_reason) {
      pendingFinish = parsed
      baseChunk = baseChunk || { id: parsed.id, model: parsed.model, object: parsed.object, created: parsed.created }
      return
    }

    const deltaContent = choice.delta?.content
    if (typeof deltaContent === 'string' && deltaContent.length > 0) {
      baseChunk = {
        id: parsed.id,
        model: parsed.model,
        object: parsed.object || 'chat.completion.chunk',
        created: parsed.created,
      }
      writeChunks(parser.push(deltaContent, baseChunk))
      return
    }

    if (Array.isArray(choice.delta?.tool_calls) && choice.delta.tool_calls.length > 0) {
      sawToolCalls = true
    }

    out.write(`${event}\n\n`)
  }

  stream.on('data', (raw: Buffer) => {
    buffer += raw.toString()
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const event = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      handleEvent(event)
      boundary = buffer.indexOf('\n\n')
    }
  })

  stream.on('end', () => {
    if (buffer.trim()) handleEvent(buffer)
    buffer = ''
    flushParser()
    writeFinishAndDone()
    out.end()
  })

  stream.on('error', (error: Error) => {
    out.write(`data: ${JSON.stringify({ error: { message: error.message, type: 'api_error', code: null } })}\n\n`)
    writeFinishAndDone()
    out.end()
  })

  return out
}
