import { Transform } from 'stream'

/**
 * Annotates the final SSE chunk when a `tool_choice:"required"` request finished
 * without any tool call. The field is additive: clients that ignore it see the
 * same stream as before.
 */
export function createToolViolationTap(): Transform {
  let buffer = ''
  let sawToolCalls = false

  const processEvent = (event: string): string => {
    const line = event.split('\n').find((entry) => entry.startsWith('data:'))
    if (!line) return `${event}\n\n`

    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return `${event}\n\n`

    let parsed: any
    try {
      parsed = JSON.parse(payload)
    } catch {
      return `${event}\n\n`
    }

    const choice = parsed?.choices?.[0]
    if (!choice) return `${event}\n\n`

    if (Array.isArray(choice.delta?.tool_calls) && choice.delta.tool_calls.length > 0) {
      sawToolCalls = true
    }

    if (choice.finish_reason && !sawToolCalls) {
      return `data: ${JSON.stringify({ ...parsed, x_modelport_tool_violation: 'required' })}\n\n`
    }

    return `${event}\n\n`
  }

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      buffer += chunk.toString()
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        this.push(processEvent(event))
        boundary = buffer.indexOf('\n\n')
      }
      callback()
    },
    flush(callback) {
      if (buffer.trim()) {
        this.push(processEvent(buffer))
      }
      buffer = ''
      callback()
    },
  })
}
