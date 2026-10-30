/**
 * OpenCode 桥：把「本机 OpenCode 运行时」变成可被本应用调用的推理后端。
 *
 * 为什么要这一层（实测结论，2026-10-27）：
 *  - 免费池不对任意 HTTP 客户端开放：不带凭据、带 API key、带 Console OAuth token，
 *    打 https://opencode.ai/inference/v1/chat/completions 都是 429 FreeUsageLimitError；
 *  - 但「隔离数据目录 + 零凭据」的 OpenCode 客户端自身可以正常用免费模型（实测回 PONG），
 *    也就是说能力绑在客户端上，与账号额度无关；
 *  - 因此唯一可行路径就是 RuiC-oc-ferry 那套：由我们起一个本机 OpenCode 运行时，
 *    通过它的本机 HTTP/SSE 接口发消息。
 *
 * agent 这一层按 Ferry 的形状裁剪：OpenCode 只负责「跑一次模型 + 把输出当数据交回来」，
 * 原生工具被 permission 表封死，工具语义与执行权都在我们这边（见 chat() 里的信封约定）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildEnvelopeSchema } from './envelopeSchema.ts'

export interface BridgePaths {
  /** 隔离的 XDG 根目录（下面分 config/data/cache/state 四个子目录） */
  root: string
  /** 运行时的工作目录：必须是空目录，agent 的工具调用不能落到真实项目里 */
  workDir: string
}

export interface BridgeModel {
  id: string
  name: string
  zeroCost: boolean
  context?: number
  /** 该模型实际由哪个协议的服务端提供（OpenAI 形状 / Anthropic 形状） */
  protocol: 'openai' | 'anthropic'
}

/** 模型把「要调用哪些工具」写进这个信封，我们再翻译成 OpenAI 的 tool_calls */
export interface BridgeToolCall {
  name: string
  arguments: unknown
}

export interface BridgeTokens {
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}

export interface BridgeReply {
  text: string
  toolCalls: BridgeToolCall[]
  /** 上游报告的 token 统计（拿不到就是 null，绝不编造） */
  tokens: BridgeTokens | null
  /** 首字节耗时与总耗时（毫秒） */
  firstByteMs: number
  totalMs: number
}

/** 运行时回给我们的 part（只声明用得到的字段）。 */
export interface BridgePart {
  type?: string
  text?: string
  tool?: string
  state?: {
    input?: unknown
    status?: string
    output?: string
    error?: string
  }
}

/** 承载信封的工具名：运行时为 `format: json_schema` 注入的那个结构化输出工具。 */
export const ENVELOPE_TOOL = 'StructuredOutput'

/**
 * 运行时合成的「垃圾桶工具」名。
 *
 * 它**不是**模型点出来的工具：模型的 `experimental_repairToolCall` 一旦发现
 * 模型点了工具表里没有的名字（`NoSuchToolError`）或参数过不了 schema
 * （`InvalidToolInputError`），就会把这次调用改写成 `tool: "invalid"`，
 * 并把原工具名与错误原因塞进 `state.input = {tool, error}`。
 *
 * 因此 `part.tool === 'invalid'` 只说明"模型这一次没按信封说话"，
 * **不说明它动了原生工具**。之前的围栏把两者混为一谈，才会报出
 * `native_tool_activity ... OpenCode tool "invalid"` 这种自相矛盾的错误。
 */
export const INVALID_TOOL = 'invalid'

export interface BridgeChatRequest {
  modelId: string
  prompt: string
  /** 客户端自己的 system 提示 */
  system?: string
  /** 要传给模型的工具（我们自己的，不是 OpenCode 的原生工具） */
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>
  /** 本轮必须至少调用一个工具（tool_choice: required / 指定函数） */
  requireCall?: boolean
  /** 最多一次调用（parallel_tool_calls: false） */
  singleCall?: boolean
}

const HEALTH_TIMEOUT_MS = 90_000
const MESSAGE_TIMEOUT_MS = 300_000

/**
 * OpenCode 的原生工具一律不许真执行。
 *
 * 键名取自运行时的 `PermissionConfig`（`opencode-ai@1.19.4`）：
 * `read / edit / glob / grep / list / bash / task / external_directory /
 *  todowrite / question / webfetch / websearch / lsp / doom_loop / skill`。
 * 之前的 `codesearch` / `plan_enter` / `plan_exit` 在这版里**根本不存在**，
 * 只是被 `'*'` 兜住才没出事；工具 id 也不是旧名字（`shell` 才是 bash、
 * `fetch` 才是 webfetch、`search` 才是 websearch/codesearch 的合体）。
 *
 * 注意 `StructuredOutput`（承载信封的那个工具）不走权限，实测它的 part 直接是
 * `status: completed`，所以这里把各项都 deny 掉不会挡住信封。
 */
const NATIVE_PERMISSIONS: Record<string, string> = {
  // 没点名的权限一律要审批，由下面 /permission 轮询一律 reject 兜住
  '*': 'ask',
  // 点名的一律直接拒：不执行、不进审批队列，模型立刻拿到错误
  bash: 'deny',
  edit: 'deny',
  read: 'deny',
  glob: 'deny',
  grep: 'deny',
  list: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  task: 'deny',
  todowrite: 'deny',
  question: 'deny',
  lsp: 'deny',
  doom_loop: 'deny',
  skill: 'deny',
  external_directory: 'deny',
}

/**
 * 一次回合最多走几个 step（`agent.steps`，运行时侧默认无限）。
 *
 * 这里**不能**设成 1：运行时把「模型点错工具」修好后会把错误喂回去重试，
 * 那个自纠发生在第二个 step（见 chat() 里对 `invalid` 的处理）。设成 1
 * 等于关掉自纠，反而让本来能成功的回合失败。
 * 设成 3 是「留一次自纠、又不让原生工具无限空转烧免费额度」。
 */
const MAX_AGENT_STEPS = 3

const CHAT_AGENT_PROMPT =
  'Reply in plain text to the external conversation. No tool use or local actions. Never claim to have executed an action.'

const TOOL_AGENT_PROMPT =
  'You are the reasoning component of an external assistant. Never invoke native OpenCode tools. ' +
  'Describe external tool calls only in the requested JSON response. The external client owns execution ' +
  'and supplies tool results on the next request.'

export function ensureBridgePaths(root: string): BridgePaths {
  const workDir = join(root, 'project')
  for (const name of ['config', 'data', 'cache', 'state']) {
    mkdirSync(join(root, name), { recursive: true })
  }
  mkdirSync(workDir, { recursive: true })
  return { root, workDir }
}

/**
 * agent 级 `tools` 字段**不要用**，它在当前运行时里是空操作。
 *
 * 曾经的写法是给两个 agent 各挂一份 `tools: {bash:false, …}`，指望"从工具清单里摘掉"。
 * 实测（反查 `opencode-ai@1.19.4`）这个假设不成立：
 *  - schema 里 `agent.tools` 标着 `@deprecated Use 'permission' field instead`；
 *  - 合并 agent 配置的循环只拷 `model/variant/prompt/description/temperature/
 *    top_p/mode/color/hidden/name/steps/options/permission`，**唯独不拷 `tools`**；
 *  - `ToolRegistry.tools()` 也完全不按权限过滤。
 *
 * 只有**顶层** `config.tools` 会被翻译成权限（`allow`/`deny`），而且那也只是
 * "拦执行"而不是"藏起来"。所以"让模型看不见原生工具"在这版运行时做不到，
 * 只能靠 `permission` 全 deny + 围栏兜底，并接受模型仍会尝试这一点。
 */
export function isolatedConfig(): Record<string, unknown> {
  return {
    permission: NATIVE_PERMISSIONS,
    autoupdate: false,
    share: 'disabled',
    agent: {
      'chat2api-chat': {
        mode: 'primary',
        description: 'Text-only external conversation',
        prompt: CHAT_AGENT_PROMPT,
        permission: NATIVE_PERMISSIONS,
        steps: 1,
      },
      'chat2api': {
        mode: 'primary',
        description: 'External client inference only',
        prompt: TOOL_AGENT_PROMPT,
        permission: NATIVE_PERMISSIONS,
        steps: MAX_AGENT_STEPS,
      },
    },
  }
}

/**
 * 运行时只继承这些环境变量：别的 provider 的 key 与 OpenCode 自己的授权都不带进去，
 * 所以这条通路天然是"零凭据"的。
 */
export function runtimeEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
    'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC',
  ]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return { ...env, ...extra }
}

/** 零计费判定：四个价格字段全为 0（与 RuiC-oc-ferry 同口径，不看模型名字）。 */
function isZeroCost(cost: unknown): boolean {
  const value = (cost ?? {}) as Record<string, unknown>
  const cache = (value.cache ?? {}) as Record<string, unknown>
  const zero = (v: unknown): boolean => v === 0 || v === undefined || v === null
  return zero(value.input) && zero(value.output) && zero(cache.read) && zero(cache.write)
}

/**
 * 从运行时的日志行里认出「这个会话的回合失败了」，并带出失败原因。
 *
 * 实测的失败行长这样：
 * `timestamp=... level=ERROR run=... message="stream error" providerID=opencode
 *  modelID=glm-5.3-flash-free session.id=ses_xxx ... error.error="AI_APICallError:
 *  Free usage limit reached. ..."`
 *
 * 别的会话的失败、别的级别的行，都不算。
 */
export function parseTurnFailureLine(line: string, sessionId: string): string | null {
  if (!line.includes(`session.id=${sessionId}`)) return null
  if (!line.includes('level=ERROR')) return null
  const reason = /error\.error="([^"]*)"/.exec(line)?.[1]
  return reason
    ? `OpenCode turn failed: ${reason}`
    : 'OpenCode turn failed (see the runtime log)'
}

/**
 * 上游的 token 形状：`{input, output, reasoning, cache: {read, write}}`。
 * 一个字段都没有就是拿不到，返回 null（绝不编造）。
 */
export function normalizeTokens(tokens: unknown): BridgeTokens | null {
  if (!tokens || typeof tokens !== 'object') return null
  const raw = tokens as Record<string, unknown>
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const cache = (raw.cache ?? {}) as Record<string, unknown>

  const out: BridgeTokens = {
    input: num(raw.input),
    output: num(raw.output),
    reasoning: num(raw.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
  }

  return Object.values(out).some(value => value !== undefined) ? out : null
}

/**
 * 运行时把「模型点错工具」改写成 `invalid` 后塞进 `state.input` 的内容：
 * `{ tool: <模型真正想调的名字>, error: <原始错误信息> }`。
 */
export interface InvalidToolActivity {
  /** 模型真正点名想调的工具（可能是一个我们没提供的外部工具名） */
  tool?: string
  /** ai-sdk 的原始错误文案，含 `Model tried to call unavailable tool '...'` 或参数校验信息 */
  error?: string
}

export function readInvalidToolActivity(part: BridgePart): InvalidToolActivity | null {
  if (part.tool !== INVALID_TOOL) return null
  const input = part.state?.input
  if (input && typeof input === 'object') {
    const raw = input as Record<string, unknown>
    return {
      tool: typeof raw.tool === 'string' ? raw.tool : undefined,
      error: typeof raw.error === 'string' ? raw.error : undefined,
    }
  }
  // 有的路径只给了一段 JSON 字符串
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>
      return {
        tool: typeof parsed.tool === 'string' ? parsed.tool : undefined,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
      }
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * 这次 `invalid` 是不是「模型把一个不存在/参数不合法的东西当成工具调了」。
 *
 * 两种来源的处置完全不同，所以必须分开：
 *  - `NoSuchToolError`（`Model tried to call unavailable tool`）：模型把提示里列出的
 *    **外部工具名**当成原生工具发了。这是我们"列外部工具名 + format 强制 required"
 *    逼出来的，属于**提示词**问题；
 *  - `InvalidToolInputError`（`Invalid input for tool`）：模型选对了 `StructuredOutput`，
 *    但参数过不了我们那张严格信封 schema，属于 **schema 太严**的问题。
 */
export function classifyInvalidTool(activity: InvalidToolActivity): 'unknown_tool' | 'bad_arguments' | 'unclassified' {
  const error = activity.error ?? ''
  if (/unavailable tool|NoSuchToolError/i.test(error)) return 'unknown_tool'
  if (/Invalid input for tool|InvalidToolInputError/i.test(error)) return 'bad_arguments'
  return 'unclassified'
}

/**
 * 判定一次回合是否真的"动了原生工具"。
 *
 * 三条规则，都是从实测的运行时行为反推出来的：
 *
 *  1. **有信封就不算违规。** 运行时在拿到结构化输出后会把它放在
 *     `info.structured`；模型哪怕中途点错过工具，只要最终交出了信封，
 *     这个回合对客户端就是有用的，没有理由判失败。
 *  2. **`invalid` 不是原生工具。** 它是运行时合成的垃圾桶，模型根本看不见它
 *     （运行时把它从 `activeTools` 里摘掉）。把它算成 native tool activity
 *     就会报出 `native_tool_activity ... tool "invalid"` 这种自相矛盾的错误。
 *  3. **只有真的去执行原生工具才算违规，而且只罚"真的动了手"。**
 *     权限层已经全 deny，所以被执行到的原生工具一定是我们漏配的权限；
 *     被拦下（`status: 'error'`）的那次不算——那是围栏按设计生效。
 */
export function findNativeToolActivity(
  parts: BridgePart[] | undefined,
  options: { hasEnvelope: boolean },
): { tool: string } | null {
  // 规则 1：拿到信封就一律放行，后面的原生工具痕迹不再追究
  if (options.hasEnvelope) return null

  const native = (parts ?? []).find(
    part =>
      part.type === 'tool' &&
      part.tool !== undefined &&
      part.tool !== ENVELOPE_TOOL &&
      part.tool !== INVALID_TOOL &&
      part.state?.status !== 'error',
  )
  return native?.tool ? { tool: native.tool } : null
}

export class OpencodeBridge {
  private child: ChildProcess | null = null
  private base = ''
  private auth = ''
  private log = ''
  private readonly paths: BridgePaths
  private readonly launcher: { command: string; args: string[] }
  private readonly onExit: (() => void) | undefined

  constructor(
    paths: BridgePaths,
    launcher: { command: string; args: string[] } = { command: 'opencode', args: [] },
    onExit?: () => void,
  ) {
    this.paths = paths
    this.launcher = launcher
    this.onExit = onExit
  }

  get running(): boolean {
    return this.child !== null
  }

  /** 起 `opencode serve`（--pure 关掉插件），健康就绪才返回。 */
  async start(): Promise<{ version: string }> {
    if (this.child) throw new Error('OpenCode bridge already running')

    const port = 47000 + Math.floor(Math.random() * 2000)
    const password = randomBytes(18).toString('hex')
    this.base = `http://127.0.0.1:${port}`
    this.auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`

    const child = spawn(
      this.launcher.command,
      [...this.launcher.args, 'serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)],
      {
        cwd: this.paths.workDir,
        env: runtimeEnv({
          XDG_CONFIG_HOME: join(this.paths.root, 'config'),
          XDG_DATA_HOME: join(this.paths.root, 'data'),
          XDG_CACHE_HOME: join(this.paths.root, 'cache'),
          XDG_STATE_HOME: join(this.paths.root, 'state'),
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_SERVER_USERNAME: 'opencode',
          OPENCODE_CONFIG_CONTENT: JSON.stringify(isolatedConfig()),
          OPENCODE_DISABLE_AUTOUPDATE: 'true',
          OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
          OPENCODE_DISABLE_CLAUDE_CODE: 'true',
          OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        // npx.cmd 在 Windows 上必须经 shell 启动；真实 opencode.exe 不需要，但无害
        shell: process.platform === 'win32',
      },
    )

    this.child = child
    this.log = ''
    child.stdout?.on('data', chunk => {
      this.log = (this.log + chunk.toString()).slice(-4000)
    })
    child.stderr?.on('data', chunk => {
      this.log = (this.log + chunk.toString()).slice(-4000)
    })
    child.on('exit', () => {
      this.child = null
      this.onExit?.()
    })

    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!this.child) {
        throw new Error(`OpenCode runtime exited during startup: ${this.log.slice(-400)}`)
      }
      const health = await this.request<{ healthy?: boolean; version?: string }>(
        'GET',
        '/global/health',
        4000,
      )
      if (health.status === 200 && health.json?.healthy) {
        return { version: health.json.version ?? 'unknown' }
      }
      await new Promise(resolve => setTimeout(resolve, 800))
    }
    this.stop()
    throw new Error(`OpenCode runtime did not become healthy in ${HEALTH_TIMEOUT_MS}ms`)
  }

  stop(): void {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.kill()
    } catch {
      // 进程可能已经退出
    }
  }

  /**
   * 盯着运行时的日志文件，找出「这个会话的回合失败了」以及失败原因。
   *
   * 为什么要盯日志：免费池配额耗尽时（实测：连续跑二三十个回合后），
   * 运行时既不返回响应也不在会话接口里报错，只在日志里写一行
   * `level=ERROR ... error.error="AI_APICallError: Free usage limit reached..."`。
   * 没有这个观察者，请求就会一直挂到 5 分钟超时，客户端只会看到"网关无响应"。
   */
  private watchTurnFailure(
    sessionId: string,
    abort: AbortController,
  ): { stop: () => void; failure: () => string | null } {
    const logPath = join(this.paths.root, 'data', 'opencode', 'log', 'opencode.log')
    let offset = 0
    let failure: string | null = null

    const tick = () => {
      if (failure) return
      try {
        const stat = statSync(logPath)
        if (stat.size <= offset) return
        const fd = openSync(logPath, 'r')
        try {
          const length = stat.size - offset
          const buffer = Buffer.alloc(length)
          readSync(fd, buffer, 0, length, offset)
          offset = stat.size
          for (const line of buffer.toString('utf8').split('\n')) {
            const reason = parseTurnFailureLine(line, sessionId)
            if (!reason) continue
            failure = reason
            abort.abort()
            return
          }
        } finally {
          closeSync(fd)
        }
      } catch {
        // 日志文件还没建出来，或者刚被轮转：下一拍再看
      }
    }

    const timer = setInterval(tick, 1000)
    timer.unref?.()

    return {
      stop: () => clearInterval(timer),
      failure: () => failure,
    }
  }

  /** 模型清单：只保留计费为 0 的条目，名字是否带 free 不参与判断。 */
  async models(): Promise<BridgeModel[]> {
    const response = await this.request<{ all?: Array<Record<string, unknown>> }>('GET', '/provider', 15000)
    if (response.status !== 200) {
      throw new Error(`/provider returned HTTP ${response.status}`)
    }
    const providers = response.json?.all ?? []
    const opencode = providers.find(entry => entry.id === 'opencode')
    const models = (opencode?.models ?? {}) as Record<string, Record<string, unknown>>
    return Object.entries(models).map(([id, model]) => ({
      id,
      name: typeof model.name === 'string' ? model.name : id,
      zeroCost: isZeroCost(model.cost),
      protocol:
        typeof model.api === 'string' && model.api.includes('/anthropic/') ? 'anthropic' : 'openai',
      context:
        typeof (model.limit as Record<string, unknown> | undefined)?.context === 'number'
          ? ((model.limit as Record<string, unknown>).context as number)
          : undefined,
    }))
  }

  /**
   * 发一条消息并等它跑完。免费模型单轮 30–60 秒是常态，所以超时给到 5 分钟；
   * 期间同时盯着 /permission，任何审批请求一律拒绝（agent 不能在本机动手）。
   */
  async chat(request: BridgeChatRequest, signal?: AbortSignal): Promise<BridgeReply> {
    const withTools = (request.tools?.length ?? 0) > 0
    const session = await this.request<{ id?: string }>('POST', '/session', 15000, {
      title: 'ModelPort',
      permission: Object.entries(NATIVE_PERMISSIONS).map(([permission, action]) => ({
        permission,
        pattern: '*',
        action,
      })),
    })
    if (session.status !== 200 || !session.json?.id) {
      throw new Error(`Failed to create session: HTTP ${session.status}`)
    }
    const sessionId = session.json.id

    let fenced = true
    const fence = (async () => {
      while (fenced) {
        const pending = await this.request<Array<{ id?: string }>>('GET', '/permission', 4000)
        for (const item of Array.isArray(pending.json) ? pending.json : []) {
          if (item?.id) {
            await this.request('POST', `/permission/${encodeURIComponent(item.id)}/reply`, 4000, {
              reply: 'reject',
            })
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    })()

    const started = Date.now()
    let firstByteMs = 0
    const body: Record<string, unknown> = {
      model: { providerID: 'opencode', modelID: request.modelId },
      agent: withTools ? 'chat2api' : 'chat2api-chat',
      parts: [{ type: 'text', text: request.prompt }],
    }
    if (request.system) body.system = request.system
    if (withTools) {
      body.format = {
        type: 'json_schema',
        schema: buildEnvelopeSchema({
          tools: request.tools ?? [],
          requireCall: request.requireCall === true,
          singleCall: request.singleCall === true,
        }),
      }
    }

    const controller = new AbortController()
    const abortOnCallerSignal = () => controller.abort()
    signal?.addEventListener('abort', abortOnCallerSignal)
    // 免费池配额耗尽时运行时不返回响应，只在日志里写一行错误。
    // 不盯着它，请求就会一直挂到 5 分钟超时；盯上就能立刻失败并带上原因。
    const watcher = this.watchTurnFailure(sessionId, controller)

    const reply = await this.request<{
      parts?: BridgePart[]
      info?: { tokens?: { input?: number; output?: number }; structured?: unknown }
    }>(
      'POST',
      `/session/${encodeURIComponent(sessionId)}/message`,
      MESSAGE_TIMEOUT_MS,
      body,
      controller.signal,
      () => {
        if (!firstByteMs) firstByteMs = Date.now() - started
      },
    )
    fenced = false
    await fence.catch(() => {})
    watcher.stop()
    signal?.removeEventListener('abort', abortOnCallerSignal)

    await this.request('DELETE', `/session/${encodeURIComponent(sessionId)}`, 8000).catch(() => {})

    const turnFailure = watcher.failure()
    if (turnFailure) {
      throw new Error(turnFailure)
    }

    if (reply.status !== 200) {
      throw new Error(`OpenCode replied HTTP ${reply.status}: ${reply.text.slice(0, 200)}`)
    }

    // 信封先读，围栏后判：**拿到信封就说明这次回合对客户端有用**，
    // 模型中途点错过工具也不该判失败（运行时自己会重试纠正，
    // `agent.steps` 也留了自纠的额度）。
    const envelope = reply.json?.info?.structured ?? this.structuredPart(reply.json?.parts)

    // 围栏的第二道：模型一旦真的**执行**了 OpenCode 的原生工具（读写文件、跑命令…），
    // 说明它想自己动手而不是把动作交给客户端。这种回合必须判失败，不能把
    // 原生工具调用当成"给客户端的工具调用"交出去。
    // 判据见 findNativeToolActivity：信封优先、`invalid` 不算原生工具、
    // 被围栏挡下（status=error）的那次不算违规。
    const nativeTool = findNativeToolActivity(reply.json?.parts, { hasEnvelope: envelope !== undefined })
    if (nativeTool) {
      throw new Error(
        `native_tool_activity: the model tried to use the OpenCode tool "${nativeTool.tool}" instead of returning an envelope`,
      )
    }

    // 走到这里还没信封，且确实有过 `invalid`：把它真正的原因带出去。
    // 报 "native_tool_activity ... invalid" 是错的（模型看不见那个工具），
    // 真实情况是模型点了工具表里没有的名字、或者信封参数不合 schema。
    if (envelope === undefined) {
      const invalid = (reply.json?.parts ?? [])
        .map(part => readInvalidToolActivity(part))
        .find(activity => activity !== null)
      if (invalid) {
        const kind = classifyInvalidTool(invalid)
        const asked = invalid.tool ? `tool "${invalid.tool}"` : 'an unnamed tool'
        const detail = invalid.error ? `: ${invalid.error}` : ''
        if (kind === 'unknown_tool') {
          throw new Error(
            `envelope_violation: the model called ${asked} as a native tool instead of writing it into the envelope${detail}`,
          )
        }
        if (kind === 'bad_arguments') {
          throw new Error(
            `envelope_violation: the model's envelope did not satisfy the schema (${asked})${detail}`,
          )
        }
        throw new Error(`envelope_violation: the model called ${asked} instead of returning an envelope${detail}`)
      }
    }

    const text = envelope
      ? String((envelope as { content?: string }).content ?? '')
      : (reply.json?.parts ?? [])
          .filter(part => part.type === 'text' && typeof part.text === 'string')
          .map(part => part.text as string)
          .join('')
    const toolCalls = envelope
      ? (((envelope as { calls?: BridgeToolCall[] }).calls ?? []) as BridgeToolCall[])
      : []

    const tokens = reply.json?.info?.tokens
    return {
      text,
      toolCalls,
      tokens: normalizeTokens(tokens),
      firstByteMs,
      totalMs: Date.now() - started,
    }
  }

  private structuredPart(parts?: BridgePart[]): unknown {
    const part = (parts ?? []).find(
      candidate =>
        candidate.type === 'tool' &&
        candidate.tool === ENVELOPE_TOOL &&
        candidate.state?.status === 'completed' &&
        candidate.state?.input !== undefined,
    )
    return part?.state?.input
  }

  private async request<T>(
    method: string,
    path: string,
    timeoutMs: number,
    body?: unknown,
    signal?: AbortSignal,
    onFirstByte?: () => void,
  ): Promise<{ status: number; json: T | null; text: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort)
    try {
      // 启动阶段端口还没监听时会直接抛 fetch failed，这不是致命错误，交给调用方按 status=0 处理
      const response = await fetch(this.base + path, {
        method,
        headers: {
          Authorization: this.auth,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      onFirstByte?.()
      let json: T | null = null
      try {
        json = JSON.parse(text) as T
      } catch {
        json = null
      }
      return { status: response.status, json, text }
    } catch (error) {
      return { status: 0, json: null, text: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
}
