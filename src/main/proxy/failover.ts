/**
 * 换家（failover）的共享纯函数：工具数超限识别 + 流首事件等待。
 *
 * 单独成模块的原因与 `retryPolicy.ts` 同：forwarder.ts 背着 electron 侧的
 * store / 渠道管理器，node --test 拉不动；这两个判据是 auto 换家语义的核心，
 * 必须能被真实单测钉住，不能只靠源码文本断言。
 */
import type { PassThrough } from 'stream'

/**
 * 工具数量超限类 400 的识别。
 *
 * ## 为什么这类 400 要允许「换下一家」（用户报障 2026-10-30）
 *
 * harness（内置工具 + MCP）一发就是上百个工具，部分上游网关（cline 背后的
 * Vercel AI Gateway）硬性限制 `tools ≤ 128`，直接 400：
 * `Invalid value for 'tools': maximum number of items is 128.`
 *
 * 这是**渠道能力不匹配**，不是客户端请求写错：同样的请求换一家没有该限制的
 * 渠道就能成。auto 候选逐个尝试本来就该跳过装不下的渠道，否则整个 auto
 * 会话被钉死在第一个撞上限的渠道上。
 *
 * ⚠️ 识别口径必须**窄**：要求文案同时出现 tools 语境与数量超限短语，避免把
 * 无关 400 误判成可换家。
 */
export function isToolOverflowError(message: string | undefined): boolean {
  if (!message) return false
  return /tools/i.test(message)
    && (/maximum number of items/i.test(message) || /too many (tools|items)/i.test(message))
}

/**
 * 429 / 5xx / 无状态码（网络错误、超时）才值得换目标；4xx 换目标没有意义。
 *
 * 唯一例外是工具数超限（见上）：那类 400 由调用方在状态码判定**之前**单独
 * 放行（forwarder.ts 的 `forwardFirstReachable`），本函数保持纯状态码语义。
 */
export function isFailoverEligibleStatus(status?: number): boolean {
  if (status === undefined) return true
  return status === 429 || status >= 500
}

/** 一条流的首个事件：首块 / 首错 / 未产出任何数据就关闭。 */
export type FirstStreamEvent =
  | { kind: 'data'; chunk: Buffer | string }
  | { kind: 'error'; error: Error }
  | { kind: 'closed' }

/**
 * 等一条流的第一个事件（首块、首错或提前关闭）。
 *
 * 渠道包的完成流是**延迟流**——`openStream()` 立刻可用，上游真正的成败只能
 * 等首个事件才知道。用 `readable` + `read()`（而不是 `data` 事件）保持暂停态，
 * 读到首块后原样交还，调用方再 `pipe` 接管，中间不会丢块。
 */
export function firstStreamEvent(stream: PassThrough): Promise<FirstStreamEvent> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: FirstStreamEvent): void => {
      if (settled) return
      settled = true
      stream.removeListener('readable', onData)
      stream.removeListener('error', onError)
      stream.removeListener('end', onClosed)
      stream.removeListener('close', onClosed)
      resolve(value)
    }
    const onData = (): void => {
      const chunk = stream.read() as Buffer | string | null
      if (chunk === null) return
      finish({ kind: 'data', chunk })
    }
    const onError = (error: Error): void => finish({ kind: 'error', error })
    const onClosed = (): void => finish({ kind: 'closed' })
    stream.once('readable', onData)
    stream.once('error', onError)
    stream.once('end', onClosed)
    stream.once('close', onClosed)
  })
}
