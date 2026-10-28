/**
 * `undici` 垫片。
 *
 * 上游用 `Dispatcher1Wrapper` 桥接 undici 8 与内置 fetch；我们固定在 undici 6
 * （与 Electron 33 / Node 20 内置 fetch 同代 handler 契约），桥接退化为恒等。
 * 代理路径仍走真实的 `ProxyAgent`，因此环境代理与 Windows 系统代理照常生效。
 */
import { Agent, Pool, ProxyAgent } from 'undici'
import type { Dispatcher } from 'undici'

export { Agent, Pool, ProxyAgent }
export type { Dispatcher }

export const Dispatcher1Wrapper = function (this: unknown, dispatcher: unknown): unknown {
  return dispatcher
} as unknown as new (dispatcher: unknown) => Dispatcher
