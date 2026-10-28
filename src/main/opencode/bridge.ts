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

/** OpenCode 的原生工具一律不许真执行：默认 'ask'（弹审批由我们拒），其余直接 deny */
const NATIVE_PERMISSIONS: Record<string, string> = {
  '*': 'ask',
  question: 'deny',
  websearch: 'deny',
  codesearch: 'deny',
  webfetch: 'deny',
  task: 'deny',
  plan_enter: 'deny',
  plan_exit: 'deny',
  todowrite: 'deny',
}

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
 * 原生工具在 agent 层直接关掉：只拒绝（deny）只是不让它执行，模型仍然看得见这些工具、
 * 仍然会去调用，然后整回合被判失败。要让模型"看不见"，就得从工具清单里摘掉。
 * StructuredOutput 保留 —— 它是承载信封的工具。
 */
const NATIVE_TOOLS_DISABLED: Record<string, boolean> = {
  bash: false,
  edit: false,
  write: false,
  read: false,
  glob: false,
  grep: false,
  list: false,
  patch: false,
  webfetch: false,
  websearch: false,
  codesearch: false,
  todowrite: false,
  task: false,
  question: false,
  plan_enter: false,
  plan_exit: false,
}

/** 隔离配置：原生工具一律要审批（我们一律拒），自动更新/分享/外部技能全关 */
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
        tools: NATIVE_TOOLS_DISABLED,
      },
      'chat2api': {
        mode: 'primary',
        description: 'External client inference only',
        prompt: TOOL_AGENT_PROMPT,
        permission: NATIVE_PERMISSIONS,
        tools: NATIVE_TOOLS_DISABLED,
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
      title: 'Chat2API',
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
      parts?: Array<{
        type?: string
        text?: string
        tool?: string
        state?: { input?: unknown; status?: string }
      }>
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

    // 围栏的第二道：模型一旦真的用了 OpenCode 的原生工具（读写文件、跑命令…），
    // 说明它想自己动手而不是把动作交给客户端。这种回合必须判失败，不能把
    // 原生工具调用当成"给客户端的工具调用"交出去。
    // 被围栏挡下的那次尝试（status=error）不算违规——那是模型被拦住，
    // 正如 RuiC-oc-ferry 的判据：只罚"真的动了手"。
    const nativeTool = (reply.json?.parts ?? []).find(
      part =>
        part.type === 'tool' &&
        part.tool !== 'StructuredOutput' &&
        part.state?.status !== 'error',
    )
    if (nativeTool) {
      throw new Error(
        `native_tool_activity: the model tried to use the OpenCode tool "${nativeTool.tool}" instead of returning an envelope`,
      )
    }

    const envelope = reply.json?.info?.structured ?? this.structuredPart(reply.json?.parts)
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

  private structuredPart(
    parts?: Array<{
      type?: string
      text?: string
      tool?: string
      state?: { input?: unknown; status?: string }
    }>,
  ): unknown {
    const part = (parts ?? []).find(
      candidate =>
        candidate.type === 'tool' &&
        candidate.tool === 'StructuredOutput' &&
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
