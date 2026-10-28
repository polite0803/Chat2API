/**
 * Worker 存活状态的**无依赖**镜像。
 *
 * 存在的理由是导入图：`providers/checker.ts` 也要回答「渠道运行时在跑吗」，
 * 但它被单测直接 import；如果 checker 去 import 管理器（→ bridge → electron），
 * 单测就会因为拉进 electron 与一堆无扩展名导入而失败。
 *
 * 于是把状态放到这个只有常量的模块里：bridge 写，checker 读，双方都不需要
 * 认识对方。
 */
export const channelRuntimeState: {
  running: boolean
  lastError?: string
} = {
  running: false,
}

export function markChannelRuntimeRunning(): void {
  channelRuntimeState.running = true
  delete channelRuntimeState.lastError
}

export function markChannelRuntimeStopped(error?: string): void {
  channelRuntimeState.running = false
  if (error !== undefined) channelRuntimeState.lastError = error
}
