/**
 * 聚合条目的请求体字段剥离。
 *
 * 少数上游（目前是 SenseNova）的请求 schema 比 OpenAI 更严：官方参数表**之外**的字段
 * 一律拒收，返回的 message 还常被网关替换成无信息量的
 * `Errors in message queue response`，客户端只能看到一个 400。
 *
 * 规则由 `AggregateEntry.dropParams` 声明，这里只做机械执行，不内置任何厂商名：
 * - `key`：删除顶层字段；
 * - `key=value`：值相等时才删除（`tool_choice=auto` 是默认值，删掉不改变语义）；
 * - `tools[].function.strict`：删除每个 tool 的 `function.strict`。
 *
 * 纯函数：不修改入参，返回新的 body。规则为空时原样返回（调用方无需判空）。
 */
export function applyAggregateDropParams(
  body: Record<string, unknown>,
  rules: readonly string[] | undefined
): Record<string, unknown> {
  if (!rules || rules.length === 0) return body

  const next: Record<string, unknown> = { ...body }
  for (const rule of rules) {
    if (rule === 'tools[].function.strict') {
      if (!Array.isArray(next.tools)) continue
      next.tools = next.tools.map(tool => {
        if (!tool || typeof tool !== 'object') return tool
        const record = tool as Record<string, unknown>
        const fn = record.function
        if (!fn || typeof fn !== 'object') return tool
        const fnRecord = fn as Record<string, unknown>
        if (!Object.prototype.hasOwnProperty.call(fnRecord, 'strict')) return tool
        const rest = { ...fnRecord }
        delete rest.strict
        return { ...record, function: rest }
      })
      continue
    }

    const separator = rule.indexOf('=')
    if (separator < 0) {
      delete next[rule]
      continue
    }

    const key = rule.slice(0, separator)
    const expected = rule.slice(separator + 1)
    if (String(next[key]) === expected) delete next[key]
  }
  return next
}
