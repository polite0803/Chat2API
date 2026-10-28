/**
 * `@deepseek-ai/schemastery` 的宿主垫片。
 *
 * 上游只把 schema 用来声明配置 namespace（`Schema.object({...})` + `.default()` /
 * `.volatile()`），而我们的宿主没有 settings 服务，`describe()` / `toJSON()` 不会
 * 被调用。所以这里只提供“能链式构造、能导出 JSON”的最小实现。
 */
type Shape = Record<string, unknown>

class SchemaNode {
  constructor(
    private readonly type: string,
    private readonly meta: Shape = {},
  ) {}

  private clone(extra: Shape): SchemaNode {
    return new SchemaNode(this.type, { ...this.meta, ...extra })
  }

  default(value: unknown): SchemaNode {
    return this.clone({ default: value })
  }

  description(text: string): SchemaNode {
    return this.clone({ description: text })
  }

  required(value = true): SchemaNode {
    return this.clone({ required: value })
  }

  volatile(value = true): SchemaNode {
    return this.clone({ volatile: value })
  }

  hidden(value = true): SchemaNode {
    return this.clone({ hidden: value })
  }

  getPath(): undefined {
    return undefined
  }

  toJSON(): Shape {
    return { type: this.type, ...this.meta }
  }
}

const factory = (type: string) => (inner?: unknown): SchemaNode => {
  const node = inner as SchemaNode | undefined
  const meta = typeof node?.toJSON === 'function' ? { inner: node.toJSON() } : {}
  return new SchemaNode(type, meta)
}

const Schema = {
  any: factory('any'),
  string: factory('string'),
  number: factory('number'),
  boolean: factory('boolean'),
  array: factory('array'),
  dict: factory('dict'),
  object: (shape: Record<string, SchemaNode>): SchemaNode =>
    new SchemaNode('object', {
      dict: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, value.toJSON()])),
    }),
}

export default Schema
