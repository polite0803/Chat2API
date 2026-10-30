/**
 * 应用内的 OpenCode 服务单例：懒启动、限并发执行、退出清理。
 *
 * 并发上限的由来见下面 maxConcurrentTurns 的注释：运行时本身支持并发会话，
 * 串行是我们早期自己加的限制；现在放行到 4 个回合并行，剩下的排队。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  OpencodeBridge,
  ensureBridgePaths,
  runtimeEnv,
  type BridgeChatRequest,
  type BridgeModel,
  type BridgeReply,
} from './bridge.ts'
import { TurnLimiter } from './concurrency.ts'
import { ProbeCache, probeCachePath, probeModel, type ProbeResult } from './probe.ts'
import { refreshModelCatalog, resolveOpencodeLauncher } from './runtime.ts'

/**
 * 同时跑几个回合。
 *
 * 取值依据是**客户端的扇出**：调用方（AxAgent）一轮会同时发 10 个 agent 节点，
 * 闸门低于这个数就等于把客户端的等待时间乘上倍数 —— 4 个并发时 10 个节点要排 3 轮。
 *
 * 已实测（2026-10-27，真运行时 + 真免费池，单回合约 3.2s）：
 * 串行 3 回合 10.3s、并行 3 回合 2.6s、并行 4 回合 3.6s，全部成功零失败。
 * 4 以上（6/8/10）当时没法测：免费池配额被前面几轮测量打满，所有回合都直接
 * 返回 "Free usage limit reached"。所以 10 这个上限是"对齐客户端扇出"，
 * 不是"实测过 10 并发"；真跑起来若上游对并发有意见，桥接层会 3 秒内快速失败成 429，
 * 不会挂住（见 bridge.ts 的 watchTurnFailure）。
 *
 * 运行时本身支持并发会话（每个请求一个独立 session），串行是我们早期自己加的限制。
 */
const MAX_CONCURRENT_TURNS = 10

export interface OpencodeServiceState {
  running: boolean
  version?: string
  launcher?: string
  models?: BridgeModel[]
  lastError?: string
}

class OpencodeService {
  private readonly limiter = new TurnLimiter(MAX_CONCURRENT_TURNS)
  private bridge: OpencodeBridge | null = null
  private starting: Promise<OpencodeBridge> | null = null
  private state: OpencodeServiceState = { running: false }
  private cache: ProbeCache | null = null

  getState(): OpencodeServiceState {
    return this.state
  }

  private root(): string {
    return join(homedir(), '.modelport', 'opencode')
  }

  private probeCache(): ProbeCache {
    if (!this.cache) this.cache = new ProbeCache(probeCachePath(this.root()))
    return this.cache
  }

  private async ensureStarted(options: { refreshCatalog?: boolean } = {}): Promise<OpencodeBridge> {
    if (this.bridge) {
      if (this.bridge.running) return this.bridge
      // 运行时进程已经没了（崩了 / 被 kill）：手上这个桥是僵尸，
      // 再拿它发请求只会得到 "Failed to create session: HTTP 0"，
      // 必须丢掉重起，否则这条通路就永久废了。
      this.bridge.stop()
      this.bridge = null
    }
    // 并发到达的请求共用同一次启动，别起出好几个运行时
    if (!this.starting) {
      const pending = this.startBridge({ refreshCatalog: options.refreshCatalog })
      this.starting = pending
      void pending.finally(() => {
        if (this.starting === pending) this.starting = null
      })
    }
    return this.starting
  }

  private async startBridge(options: { refreshCatalog?: boolean } = {}): Promise<OpencodeBridge> {
    const launcher = resolveOpencodeLauncher()
    const paths = ensureBridgePaths(this.root())

    // 刷新模型目录只能在运行时没起来时跑：两个进程共用同一个数据目录（SQLite），
    // 并发写会互相锁住。失败忽略，目录照旧用包里那份快照。
    if (options.refreshCatalog) {
      const refresh = await refreshModelCatalog(launcher, {
        env: runtimeEnv({}),
        cwd: paths.workDir,
      })
      console.log(
        `[OpenCode] catalog refresh ${refresh.ok ? 'ok' : 'failed'} (${refresh.detail})`,
      )
    }

    const bridge = new OpencodeBridge(
      paths,
      {
        command: launcher.command,
        args: launcher.args,
      },
      // 进程自己退了，状态也得跟着退：否则界面会一直显示"运行时在跑"
      () => {
        this.state = { ...this.state, running: false }
        if (this.bridge === bridge) this.bridge = null
      },
    )
    try {
      const health = await bridge.start()
      this.bridge = bridge
      this.state = {
        running: true,
        version: health.version,
        launcher: `${launcher.source}: ${launcher.command}${launcher.args.length ? ' ' + launcher.args.join(' ') : ''}`,
      }
      return bridge
    } catch (error) {
      this.state = {
        running: false,
        launcher: `${launcher.source}: ${launcher.command}`,
        lastError: error instanceof Error ? error.message : String(error),
      }
      throw error
    }
  }

  /** 拿一个回合名额；名额用完就排队等，不阻塞别人 */
  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    return this.limiter.run(task)
  }

  async models(options: { refreshCatalog?: boolean } = {}): Promise<BridgeModel[]> {
    return this.enqueue(async () => {
      const bridge = await this.ensureStarted({ refreshCatalog: options.refreshCatalog })
      const models = await bridge.models()
      this.state = { ...this.state, models }
      return models
    })
  }

  async chat(request: BridgeChatRequest, signal?: AbortSignal): Promise<BridgeReply> {
    return this.enqueue(async () => {
      const bridge = await this.ensureStarted()
      return bridge.chat(request, signal)
    })
  }

  /** 某个模型能不能按信封产出工具调用（带缓存，没有缓存就现探） */
  capability(modelId: string): ProbeResult | null {
    return this.probeCache().get(modelId)
  }

  /** 逐个体检；并发 2，避免把免费额度一次打满 */
  async probeModels(
    modelIds: string[],
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<Record<string, ProbeResult>> {
    const cache = this.probeCache()
    const results: Record<string, ProbeResult> = {}
    const pending: string[] = []
    for (const modelId of modelIds) {
      const cached = options.force ? null : cache.get(modelId)
      if (cached) results[modelId] = cached
      else pending.push(modelId)
    }
    if (pending.length === 0) return results

    const bridge = await this.ensureStarted()
    const workers = Array.from({ length: Math.min(2, pending.length) }, async () => {
      for (;;) {
        const modelId = pending.shift()
        if (!modelId) return
        // 体检也是真回合，也占配额 ⇒ 走同一份并发预算
        const result = await this.enqueue(() => probeModel(bridge, modelId, options.signal))
        cache.set(modelId, result)
        results[modelId] = result
      }
    })
    await Promise.all(workers)
    return results
  }

  stop(): void {
    this.bridge?.stop()
    this.bridge = null
    this.state = { running: false }
  }
}

export const opencodeService = new OpencodeService()
