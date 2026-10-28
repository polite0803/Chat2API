/**
 * 主进程 ↔ 渠道 Worker 的桥。
 *
 * Worker 负责全部渠道业务（登录、账号池、积分、上游协议），主进程只做四件事：
 * 1. 起停 Worker、崩溃后重建；
 * 2. 应答 `credentials` 消息（真正的加密落盘在主线程）；
 * 3. 把 `models()` / RPC / 对话请求转成消息；
 * 4. 把 SSE 文本逐帧送进响应流。
 *
 * 为什么必须独立 Worker：渠道包会起本地 HTTP 登录服务器、加载 WASM、跑长时间
 * 流式请求；放在主进程里任何一次阻塞都会冻住整个应用。Worker 产物因此也不能
 * 进 asar（`extraResources` 落到 `process.resourcesPath/channel-pack`）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import type { ChannelRpcResult } from '../../shared/channels'
import type { ChannelCredentialVault } from '../providers/accountChannels/vault'
import {
  markChannelRuntimeRunning,
  markChannelRuntimeStopped,
} from '../providers/accountChannels/runtimeState'

export class ChannelBridgeError extends Error {
  /** HTTP status to surface to the OpenAI client; undefined means 500. */
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ChannelBridgeError'
    this.status = status
  }
}

export interface ChannelCompletionRequest {
  requestId: string
  /** Full `<provider>/<model>` id the pack routes on. */
  model: string
  stream: boolean
  /** OpenAI-shaped request body (internal proxy fields already removed). */
  openAi: Record<string, unknown>
}

export interface ChannelBridgeOptions {
  /** App data dir; the pack keeps `channel-pack/state.json` under it. */
  dataDir: string
  vault: ChannelCredentialVault
  /** Called whenever the pack reports an account/model change. */
  onChanged?: () => void
  onLog?: (level: string, message: string) => void
}

interface Job {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  stream?: PassThrough
  timer?: NodeJS.Timeout
}

const START_TIMEOUT_MS = 30_000
const RPC_TIMEOUT_MS = 120_000

export function resolveChannelPackDir(): string {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'channel-pack')
    : join(app.getAppPath(), 'resources', 'channel-pack')
  return base
}

export class ChannelBridge {
  private readonly options: ChannelBridgeOptions
  private worker: Worker | null = null
  private readyPromise: Promise<void> | null = null
  private readonly jobs = new Map<string, Job>()
  private sequence = 0
  private shuttingDown = false

  constructor(options: ChannelBridgeOptions) {
    this.options = options
  }

  /** Providers the worker registered. Empty until `start()` resolves. */
  providers: string[] = []

  /** Worker process is alive and finished its first start. */
  get running(): boolean {
    return this.worker !== null && this.readyPromise !== null
  }

  async start(): Promise<void> {
    if (this.readyPromise !== null) return this.readyPromise
    this.readyPromise = this.spawn()
    try {
      await this.readyPromise
    } catch (error) {
      this.readyPromise = null
      throw error
    }
    return this.readyPromise
  }

  private spawn(): Promise<void> {
    const directory = resolveChannelPackDir()
    const workerPath = join(directory, 'worker.mjs')
    if (!existsSync(workerPath)) {
      return Promise.reject(new ChannelBridgeError(
        '渠道运行时尚未构建，请先执行 npm run build:channel-pack',
      ))
    }

    const worker = new Worker(workerPath, {
      workerData: { dataDir: this.options.dataDir },
      // 渠道包靠这个变量定位状态目录（`resolveChannelPackHome`）；不注入就会写进
      // 用户真实的 `~/.dsh`，与本应用的账号池分裂成两套。
      // 本机 OpenAI 兼容网关关掉：本应用自己就是 `/v1` 服务，再监听 8326 只会
      // 与已有实例抢端口，并多暴露一个没人用的入口。
      env: {
        ...process.env,
        DSH_CHANNEL_PACK_STATE_DIR: this.options.dataDir,
        DSH_OPENAI_GATEWAY_ENABLED: '0',
      },
    })
    this.worker = worker

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(
        () => finish(new ChannelBridgeError('渠道运行时启动超时')),
        START_TIMEOUT_MS,
      )

      worker.on('message', (message: Record<string, unknown>) => {
        if (message?.type === 'ready') {
          this.providers = Array.isArray(message.providers) ? message.providers as string[] : []
          markChannelRuntimeRunning()
          finish()
        }
        void this.handleMessage(message)
      })
      worker.on('error', (error: Error) => {
        this.options.onLog?.('error', `渠道运行时错误：${error.message}`)
        markChannelRuntimeStopped(error.message)
        finish(error)
        this.failAllJobs(new ChannelBridgeError(`渠道运行时错误：${error.message}`))
        this.dropWorker()
      })
      worker.on('exit', (code: number) => {
        if (this.shuttingDown) return
        this.options.onLog?.('error', `渠道运行时已退出（code=${code}）`)
        markChannelRuntimeStopped(`退出码 ${code}`)
        finish(new ChannelBridgeError('渠道运行时已退出'))
        this.failAllJobs(new ChannelBridgeError('渠道运行时已退出', 502))
        this.dropWorker()
      })
    })
  }

  private dropWorker(): void {
    this.worker = null
    this.readyPromise = null
  }

  private failAllJobs(error: Error): void {
    for (const [id, job] of this.jobs) {
      this.jobs.delete(id)
      if (job.timer) clearTimeout(job.timer)
      if (job.stream) {
        job.stream.destroy(error)
        job.reject(error)
      } else {
        job.reject(error)
      }
    }
  }

  private async workerOrThrow(): Promise<Worker> {
    await this.start()
    if (this.worker === null) throw new ChannelBridgeError('渠道运行时不可用', 503)
    return this.worker
  }

  /* ------------------------------------------------------------ 消息处理 */

  private async handleMessage(message: Record<string, any>): Promise<void> {
    switch (message?.type) {
      case 'ready':
        return
      case 'log':
        this.options.onLog?.(String(message.level ?? 'info'), String(message.message ?? ''))
        return
      case 'changed':
        this.options.onChanged?.()
        return
      case 'credential':
        await this.handleCredential(message)
        return
      case 'sse': {
        const job = this.jobs.get(String(message.id))
        job?.stream?.write(String(message.text ?? ''))
        return
      }
      case 'completion': {
        const job = this.jobs.get(String(message.id))
        if (!job) return
        this.settle(String(message.id))
        job.resolve(message.value)
        return
      }
      case 'done': {
        const job = this.jobs.get(String(message.id))
        if (!job) return
        this.settle(String(message.id))
        if (job.stream) {
          job.stream.end()
          job.resolve(true)
        } else {
          job.resolve(undefined)
        }
        return
      }
      case 'result': {
        const job = this.jobs.get(String(message.id))
        if (!job) return
        this.settle(String(message.id))
        job.resolve(message.value)
        return
      }
      case 'error': {
        const job = this.jobs.get(String(message.id))
        if (!job) return
        this.settle(String(message.id))
        const error = new ChannelBridgeError(
          String(message.message ?? '渠道请求失败'),
          typeof message.status === 'number' ? message.status : undefined,
        )
        if (job.stream) {
          job.stream.destroy(error)
        }
        job.reject(error)
        return
      }
      case 'closed':
        return
      default:
        return
    }
  }

  private settle(id: string): Job | undefined {
    const job = this.jobs.get(id)
    if (!job) return undefined
    this.jobs.delete(id)
    if (job.timer) clearTimeout(job.timer)
    return job
  }

  private async handleCredential(message: Record<string, any>): Promise<void> {
    const id = String(message.id)
    const args = (message.args ?? {}) as Record<string, unknown>
    let response: { type: string; id: string; ok: boolean; value?: unknown; error?: string }
    try {
      let value: unknown
      switch (message.op) {
        case 'resolve':
          value = await this.options.vault.resolve(args.ref)
          break
        case 'describe':
          value = await this.options.vault.describe(args.ref)
          break
        case 'set':
          await this.options.vault.set(args.ref, args.value)
          break
        case 'unset':
          await this.options.vault.unset(args.ref)
          break
        default:
          throw new Error(`未知的凭据操作：${String(message.op)}`)
      }
      response = { type: 'credential-result', id, ok: true, value }
    } catch (error) {
      response = {
        type: 'credential-result',
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    this.worker?.postMessage(response)
  }

  /* ------------------------------------------------------------ 对外操作 */

  async models(): Promise<Array<Record<string, unknown>>> {
    const value = await this.request('models', {}, RPC_TIMEOUT_MS)
    return Array.isArray(value) ? value as Array<Record<string, unknown>> : []
  }

  async rpc(method: string, payload: unknown): Promise<ChannelRpcResult> {
    const value = await this.request('rpc', { call: { method, payload } }, RPC_TIMEOUT_MS)
    if (value !== null && typeof value === 'object' && 'ok' in value) {
      return value as ChannelRpcResult
    }
    return { ok: false, error: { code: 'invalid_response', message: '渠道返回了未知的响应' } }
  }

  async complete(request: ChannelCompletionRequest): Promise<Record<string, unknown>> {
    const value = await this.request('complete', { request }, 0)
    if (value === null || typeof value !== 'object') {
      throw new ChannelBridgeError('渠道没有返回对话结果', 502)
    }
    return value as Record<string, unknown>
  }

  /**
   * 打开一条流式响应。
   *
   * 返回的流立刻可用（先回响应头），SSE 帧由 Worker 推入；客户端断开时通过
   * `cancel` 通知 Worker 中止上游请求，避免额度被白烧。
   */
  openStream(request: ChannelCompletionRequest): PassThrough {
    const stream = new PassThrough()
    const id = this.nextId()
    const job: Job = {
      resolve: () => undefined,
      reject: (error) => undefined,
      stream,
    }
    this.jobs.set(id, job)
    void this.workerOrThrow()
      .then(worker => {
        worker.postMessage({ type: 'complete', id, request })
      })
      .catch((error: Error) => {
        this.settle(id)
        stream.destroy(error)
      })
    stream.on('close', () => {
      if (!this.jobs.has(id)) return
      this.settle(id)
      this.worker?.postMessage({ type: 'cancel', id })
    })
    return stream
  }

  private request(type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId()
    return this.workerOrThrow().then(worker => new Promise<unknown>((resolve, reject) => {
      const job: Job = { resolve, reject }
      if (timeoutMs > 0) {
        job.timer = setTimeout(() => {
          this.settle(id)
          this.worker?.postMessage({ type: 'cancel', id })
          reject(new ChannelBridgeError('渠道请求超时', 504))
        }, timeoutMs)
      }
      this.jobs.set(id, job)
      worker.postMessage({ type, id, ...payload })
    }))
  }

  private nextId(): string {
    this.sequence += 1
    return `job-${this.sequence}`
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    markChannelRuntimeStopped()
    const worker = this.worker
    if (worker === null) return
    this.failAllJobs(new ChannelBridgeError('应用正在退出', 503))
    worker.postMessage({ type: 'close' })
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { void worker.terminate(); resolve() }, 3_000)
      worker.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.worker = null
    this.readyPromise = null
  }
}
