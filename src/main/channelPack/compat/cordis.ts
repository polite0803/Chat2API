/**
 * `@deepseek-ai/cordis` 的宿主垫片。
 *
 * 上游只用到 `Context` 类型与 `Service` 基类：服务把自己注册进宿主仓，
 * 之后其它模块通过 `ctx.get(name)` 取回。这里与 standalone 契约保持一致。
 */
export class Context {
  [key: string]: unknown
}

export class Service {
  ctx: Context

  constructor(platform: Context, name?: string) {
    this.ctx = platform
    if (name !== undefined) {
      const provide = (platform as { provide?: (name: string, value: unknown) => void }).provide
      provide?.(name, this)
    }
  }
}
