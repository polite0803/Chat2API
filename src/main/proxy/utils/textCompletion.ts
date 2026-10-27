import { Transform } from 'stream'

export function toTextCompletion(body: any): any {
  if (!body || !Array.isArray(body.choices)) return body
  return {
    id: body.id,
    object: 'text_completion',
    created: body.created,
    model: body.model,
    choices: body.choices.map((choice: any, index: number) => ({
      index: choice.index ?? index,
      text: typeof choice.text === 'string' ? choice.text : choice.message?.content ?? '',
      logprobs: null,
      finish_reason: choice.finish_reason ?? null,
    })),
    usage: body.usage ?? null,
  }
}

export function createTextCompletionChunkTransform(): Transform {
  let buffer = ''

  const convert = (event: string): string => {
    const line = event.split('\n').find((entry) => entry.startsWith('data:'))
    if (!line) return `${event}\n\n`

    const payload = line.slice(5).trim()
    if (payload === '[DONE]') return 'data: [DONE]\n\n'

    let parsed: any
    try {
      parsed = JSON.parse(payload)
    } catch {
      return `${event}\n\n`
    }

    if (parsed?.error) return `data: ${JSON.stringify(parsed)}\n\n`

    const choice = parsed?.choices?.[0]
    if (!choice) {
      return `data: ${JSON.stringify({ ...parsed, object: 'text_completion' })}\n\n`
    }

    const converted = {
      id: parsed.id,
      object: 'text_completion',
      created: parsed.created,
      model: parsed.model,
      choices: [{
        index: choice.index ?? 0,
        text: choice.delta?.content ?? '',
        logprobs: null,
        finish_reason: choice.finish_reason ?? null,
      }],
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    }
    return `data: ${JSON.stringify(converted)}\n\n`
  }

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      buffer += chunk.toString()
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        this.push(convert(event))
        boundary = buffer.indexOf('\n\n')
      }
      callback()
    },
    flush(callback) {
      if (buffer.trim()) {
        this.push(convert(buffer))
      }
      buffer = ''
      callback()
    },
  })
}
