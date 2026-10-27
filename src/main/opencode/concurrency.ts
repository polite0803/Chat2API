/**
 * 回合并发闸门
 *
 * 一次请求就是一个 agent 回合（30–60 秒），客户端并发一高，如果只放行一个，
 * 等待时间就会乘上并发数。实测真运行时：串行 3 回合 10.3s，并行 3 回合 2.6s、
 * 并行 4 回合 3.6s，全部成功 —— 运行时本身支持并发会话，串行是我们自己加的限制。
 *
 * 但闸门要有上限：免费池本身有配额，并发再高也换不来更多吞吐，
 * 只会更快把配额打满（实测连续二三十个回合就 "Free usage limit reached"）。
 */
export class TurnLimiter {
  private readonly limit: number
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(limit: number) {
    this.limit = limit
  }

  get activeCount(): number {
    return this.active
  }

  get queuedCount(): number {
    return this.waiters.length
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return
    }
    await new Promise<void>(resolve => this.waiters.push(resolve))
    // 释放方把名额直接交给等待者，所以 active 不变
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active--
  }
}
