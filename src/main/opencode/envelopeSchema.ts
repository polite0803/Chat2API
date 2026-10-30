/**
 * 信封的 JSON Schema
 *
 * 客户端给的工具，要在**解码层**就被限定住：`calls[].items` 用 `anyOf` 把每个工具名
 * 写成 `const`、把该工具的参数 schema 直接内联，模型就编不出一个没提供的工具名，
 * 也编不出对不上的参数形状。只靠提示词约束是靠不住的（实测：只 deny 权限时模型
 * 照样会去调原生工具）。
 *
 * `minItems` / `maxItems` 用来表达调用方的语义：
 *  - `tool_choice: "required"` 或指定了某个函数 ⇒ 至少一个调用（minItems: 1）
 *  - `parallel_tool_calls: false` ⇒ 最多一个调用（maxItems: 1）
 *
 * **但"严格"有个上限**：运行时把 `format: json_schema` 的回合硬塞成
 * `toolChoice: "required"`，任何一处 schema 不满足都会被 ai-sdk 报成
 * `InvalidToolInputError`，再被改写成 `invalid` 工具，整回合报废。
 * 所以这里对**模型容易自然写出来的无害偏差**做兼容：
 *  - `arguments` 允许缺省（模型常把无参工具的 arguments 整个省掉）⇒ 补默认 `{}`；
 *  - 顶层与每次调用的 `additionalProperties` 放宽（多带一个 `reasoning`/`thought`
 *    字段不该让整轮失败），但**工具名仍然是 `const`**——那才是真正要守住的约束。
 */

export interface EnvelopeTool {
  name: string
  /** OpenAI 的 function.parameters（JSON Schema） */
  parameters?: unknown
}

export interface EnvelopeSchemaOptions {
  tools: EnvelopeTool[]
  /** 本轮必须至少调用一个工具 */
  requireCall?: boolean
  /** 最多一个调用（parallel_tool_calls: false） */
  singleCall?: boolean
}

function argumentsSchema(parameters: unknown): Record<string, unknown> {
  if (parameters && typeof parameters === 'object' && (parameters as { type?: unknown }).type === 'object') {
    return parameters as Record<string, unknown>
  }
  // 工具没给 parameters（或给了个非 object 的），退回"任意对象"
  return { type: 'object', additionalProperties: true }
}

export function buildEnvelopeSchema(options: EnvelopeSchemaOptions): Record<string, unknown> {
  const { tools, requireCall, singleCall } = options

  const calls: Record<string, unknown> = { type: 'array' }
  if (singleCall) calls.maxItems = 1
  if (requireCall) calls.minItems = 1

  if (tools.length === 0) {
    // 本轮不许调工具：直接封死
    calls.maxItems = 0
    calls.items = { type: 'object' }
  } else {
    calls.items = {
      anyOf: tools.map(tool => ({
        type: 'object',
        properties: {
          name: { type: 'string', const: tool.name },
          arguments: argumentsSchema(tool.parameters),
        },
        // `arguments` **不进 required**：模型给无参工具带省略 arguments 是常态，
        // 缺了它不该触发 InvalidToolInputError（那样整回合会被改写成 invalid）。
        required: ['name'],
        // 多带一个说明性字段（reasoning / thought）不该让整轮失败。
        // 真正守住的约束是 name 的 `const` 与 arguments 的内联 schema。
        additionalProperties: true,
      })),
    }
  }

  return {
    type: 'object',
    properties: {
      content: { type: 'string' },
      calls,
    },
    // `content` 放宽成可选：只关心"调了什么"时，模型省略 content 是合理的。
    required: ['calls'],
    // 顶层同样放宽：模型爱在信封里附加自己的解释字段，为这个判失败不值得。
    additionalProperties: true,
  }
}
