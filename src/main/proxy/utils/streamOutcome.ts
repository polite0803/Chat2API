/**
 * 流式响应「有没有正常收尾」的判据，只读 SSE 文本。
 *
 * 渠道包会把多类「本轮不完整」折成 `finish_reason:"length"`，上游若连结束帧都没发
 * 则什么都不会有 —— 两者在客户端都只表现为一句固定文案。记录时同时存下结束原因
 * 与「上游是否给出过结束原因」，事后才能分清是上限截断还是断流。
 */
export interface StreamOutcome {
  /** 最后一个非空 finish_reason；一次都没有则为 undefined */
  finishReason?: string
  /** 是否出现过结束原因（不看 [DONE]：补发 [DONE] 不代表上游宣布过结束） */
  sawFinish: boolean
}

export function readStreamOutcome(sseText: string): StreamOutcome {
  let finishReason: string | undefined

  for (const rawLine of sseText.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue

    const payload = line.slice('data:'.length).trim()
    if (payload.length === 0 || payload === '[DONE]') continue

    let frame: unknown
    try {
      frame = JSON.parse(payload)
    } catch {
      // 收尾处被截断的半帧 JSON 本身也是断流的证据，但它只看「有没有结束原因」，
      // 解析不了就等于没有，无需另行记录。
      continue
    }

    const reason = (frame as { choices?: Array<{ finish_reason?: unknown }> })?.choices?.[0]?.finish_reason
    if (typeof reason === 'string' && reason.length > 0) finishReason = reason
  }

  return { finishReason, sawFinish: finishReason !== undefined }
}
