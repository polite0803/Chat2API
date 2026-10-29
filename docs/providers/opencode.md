# OpenCode

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | opencode |
| 凭据 | **无**（不需要登录、不需要 API key） |
| 请求路径 | 不走 HTTP：由本机 OpenCode 运行时完成一次 agent 回合，再由本应用包装成 OpenAI 形状 |
| 单轮耗时 | 约 30–60 秒 |
| 计费 | 免费（模型按"四个价格字段全 0"筛选） |

## 为什么是这个形态

免费池不对任意 HTTP 客户端开放。实测（2026-10-27）三种凭据打
`https://opencode.ai/inference/v1/chat/completions`：

| 凭据 | 免费模型 | 付费模型 |
| --- | --- | --- |
| 无 | 429 `FreeUsageLimitError` | — |
| Console API key | 429 同上（`/models` 200） | 402 `Insufficient account funds` / 403 `Model access is disabled` |
| Console OAuth token（设备码换来的） | 429 同上 | 403 同上 |

而**隔离数据目录 + 零凭据的 OpenCode 客户端自己**可以正常用免费模型（实测回 `PONG`）。
也就是说能力绑在客户端上，和账号额度无关。所以唯一可行路径就是 Ferry 那套：
本应用起一个自己的 OpenCode 运行时，通过它的本机 HTTP/SSE 接口发消息。

## 实现

| 模块 | 作用 |
| --- | --- |
| `src/main/opencode/runtime.ts` | 找运行时：`OPENCODE_BIN` → `~/.opencode/bin` → npm 全局 → PATH → `npx opencode-ai@<pin>` 兜底 |
| `src/main/opencode/bridge.ts` | 起 `opencode serve --pure`，健康门；`/provider` 取模型并按价格筛；`/session` + `/session/{id}/message` 发消息，同时轮询 `/permission` 一律 reject |
| `src/main/opencode/service.ts` | 单例：懒启动、**串行排队**（一次一个 agent 回合）、退出清理 |
| `src/main/opencode/prompt.ts` | 把 OpenAI 消息数组渲染成"带角色标记的转录 + 一句系统指令" |
| `src/main/opencode/probe.ts` | 模型体检：判断该模型能否按信封产出工具调用；判定带 TTL 缓存 |
| `src/main/proxy/adapters/opencode.ts` | 把回合结果包装成 OpenAI 的 `chat.completion` / SSE 分片 |

隔离性：`XDG_CONFIG_HOME / DATA_HOME / CACHE_HOME / STATE_HOME` 四个目录各自指向
`~/.chat2api/opencode/` 下的独立目录，**不读也不写用户全局的 `~/.local/share/opencode`**；
环境变量只继承白名单那十几个，别的 provider 的 key 与 OpenCode 自己的授权都不带进来
⇒ 这条通路天然零凭据；工作目录是一个空目录，agent 的工具即便被触发也落不到真实项目里。

## agent 层怎么裁的（照 RuiC-oc-ferry 的形状）

| 环节 | 做法 |
| --- | --- |
| 隔离配置 | 用 `OPENCODE_CONFIG_CONTENT` 注入（不是写配置文件），另带 `OPENCODE_DISABLE_AUTOUPDATE/PROJECT_CONFIG/CLAUDE_CODE/EXTERNAL_SKILLS` |
| 两个 agent | `chat2api-chat`（纯文本）与 `chat2api`（带工具），prompt 是 Ferry 两条 prompt 的改写 |
| 工具 | 原生工具在 agent 层**关掉**（`tools: {bash:false,…}`），只留 `StructuredOutput` 承载信封。只在权限层 deny 不够——模型仍看得见这些工具、仍会去调，然后整回合被判失败 |
| 围栏 | 会话级 permission 表把原生工具标成 ask/deny，同时轮询 `/permission` 一律 `reply:'reject'`；真跑了原生工具的回合判失败（被围栏挡下的那次尝试不算违规，与 Ferry 同口径） |
| 工具归属 | 模型只能把"要调什么"写进 `{content, calls}` 信封，由我们翻译成 OpenAI 的 `tool_calls`；客户端没给过的工具名一律丢弃 |

## 并发与配额

**回合可以并行**。运行时（`opencode serve`）本身支持并发会话——每个请求一个独立
session，互不影响。早期我们把服务层做成了严格串行（一次一个回合），那是自己加的
限制，不是上游的限制。实测（2026-10-27，真运行时 + 真免费池，单回合约 3.2 s）：

| 变体 | 耗时 | 结果 |
| --- | --- | --- |
| 串行 3 回合 | 10.3 s | 3/3 成功 |
| 并行 3 回合 | **2.6 s** | 3/3 成功 |
| 并行 4 回合 | **3.6 s** | 4/4 成功 |

现在放行到 **10 个回合并行**（`opencode/concurrency.ts` 的 `TurnLimiter`），超出的排队。
体检探针也算回合，走同一份并发预算。

这个 10 是**对齐客户端扇出**：调用方（AxAgent）一轮会同时发 10 个 agent 节点，闸门低于它
就等于把等待时间乘上倍数。**实测覆盖到 4 并发**（零失败）；6/8/10 当时没法测——免费池配额
被前面几轮测量打满，所有回合都直接返回 `Free usage limit reached`。所以"10 并发"没有实测读数，
真跑起来若上游对并发有意见，桥接层会在 3 秒内快速失败成 429，不会挂住。

**但免费池有配额。** 连续跑二三十个回合后，上游会开始报：

```
AI_APICallError: Free usage limit reached. Free models work in OpenCode;
subscribe to OpenCode Go to keep going
```

配额耗尽时运行时**既不返回响应也不在会话接口里报错**，只在它自己的日志里写一行
`level=ERROR ... session.id=... error.error="AI_APICallError: Free usage limit reached..."`。
所以：

- 桥接层一边发回合，一边盯运行时的日志，按 `session.id` 认出「我这个回合失败了」，
  立刻中止并把原因带出去。实测：配额耗尽时回合 **3.2 秒**失败并带上原文，
  而不是挂满 5 分钟超时（那是修之前的行为）。
- 代理层把这条错误映射成 **429 rate_limit_error**，客户端知道该退避，而不是当成网关故障重试。
- 并发再高也换不来更多吞吐——配额是按回合算的，并发只是让同样数量的回合更快打完。

## 实测（2026-10-27）

| 变体 | 时延 | input token | 结果 |
| --- | --- | --- | --- |
| OpenCode 默认 build agent | 7.9 s | 87,820 | PONG（agent 壳的代价） |
| 我们的 `chat2api-chat`（纯文本） | **3.1–4.2 s** | **3,516** | PONG |
| 我们的 `chat2api`（带工具） | 15.0 s | 3,770 | 文本 + 信封；该模型仍偏好原生 bash → 被围栏挡下并丢弃 |

把 agent 壳裁掉之后，上下文从 9 万降到 3.5k（-96%），单轮快一倍以上。

## 已知边界

1. **`usage` 是"这个回合"的口径**：上游报了就照 OpenAI 合并口径转发
   （`prompt = input + cache.read + cache.write`、`completion = output + reasoning`，
   并带 `prompt_tokens_details.cached_tokens` / `completion_tokens_details.reasoning_tokens`），
   流式在 `[DONE]` 前补一帧 `choices: []` 的 usage。注意它含适配器自己的系统提示与本轮工具清单，
   **不等于客户端原始请求的 token**；上游一个数都没报时仍是 `null`，不编。
2. **只吃文本，图片明确报错**：`image_url` / `input_image` / `image` 一律 400
   `UnsupportedContentError`（在开流之前就报，不会先发响应头再塞错误帧）——静默丢掉会让客户端
   以为模型"看过图了"。
3. **流式是"一次性"的**：agent 不吐 token 流，整段答复在一个内容分片里发出，之后 `finish_reason`、usage 帧与 `[DONE]`。
4. **采样参数不生效**：`temperature` / `max_tokens` 这些是网页端的对话参数，上游不认。
5. **工具是否可用取决于模型**，所以每个模型先做一次"信封体检"：
   - 探针用一个指令式提示（"调用 `probe_tool`"）并检查信封里有没有那个调用；
   - 判定按原因给不同 TTL（成功/只是不听话 6 小时、限流 10 分钟、下线 1 小时），缓存落在
     `~/.chat2api/opencode/probe-cache.json`，跨重启复用；
   - 判定为"纯对话"的模型，请求路径就不给它工具清单（再给，它会转头去用原生工具）；
   - 判定为"会调工具"的模型，把客户端的工具清单按 Ferry 的措辞交给它；它若仍写了原生工具名，
     先纠正重试一次，仍不听话就把这类调用丢掉，只保留正文。

   实测：`glm-5.3-flash-free` 与 `big-pickle` 都是 tool-capable（探针 3–5 s）；
   带工具的真实请求 4.2 s 返回 `get_weather{city:"Beijing"}`。
6. **工具在解码层就被限定住**：信封 schema 的 `calls[].items` 用 `anyOf` 把每个工具名写成
   `const`、把该工具的参数 schema 直接内联；`tool_choice: required`（或指定函数）落成
   `minItems: 1`，`parallel_tool_calls: false` 落成 `maxItems: 1`，本轮不给工具则 `maxItems: 0`。
   模型编不出没提供的工具名，也编不出对不上的参数形状（见 `opencode/envelopeSchema.ts`）。
7. **免费模型清单会变**：清单来自本机运行时，只收**四个价格字段全 0** 的条目
   （含名字不带 free 但计费为 0 的 `big-pickle`）。点「更新模型」时，若运行时**还没起来**，
   会先跑一次 `models opencode --refresh` 把运行时包里的目录快照刷到最新（失败忽略）；
   运行时已经在跑就不刷——两个进程共用同一个数据目录，并发写会互相锁住。
8. **走 Anthropic 协议的那几个模型不收**：它们由 `/inference/anthropic/v1/messages` 提供，
   我们的通路是 OpenAI 形状，发不通。它们会被排除，并把名单写进「更新模型」的提示里
   （`…are served over the Anthropic protocol and are not reachable here: …`），不静默吞掉。
   （参照实现 ow-lite 不区分协议族；到底该不该收，取决于运行时是否自己按模型路由——
   **这一条我们还没验过**，记在这里等配额恢复后测。）
9. **工具不会被处理两次**：OpenCode 的档案标了 `handlesToolsItself`，托管工具层对它完全让开
   （既不注入提示、也不解析响应）；工具清单仍由托管层判定（`tool_choice` / 强制工具），
   但由 OpenCode 的信封翻译成 OpenAI 的 `tool_calls`。
8. **状态检查不报"离线"**：它的 `apiEndpoint` 是占位 scheme（`opencode://local`），拿它发 HTTP
   就是 axios 的 `Unsupported protocol opencode:`。点「检查状态」时读的是运行时有没有在跑：
   在跑＝在线；没在跑＝**状态未知**（附一句"首次请求时自动拉起"），不会顺手把运行时启动起来。
9. **响应头先发，正文后到**：一个回合 30–60 秒，流式请求不会等回合跑完才开流——先发一个只带
   `role` 的分片把响应头推出去，正文等回合结束再补。否则客户端只要有响应头超时（AxAgent 的
   SSE 诊断是 10 秒）就会先判失败再回退，这条链路永远打不通。实测：修之前 AxAgent 的请求在
   首字节前要等 5–7 分钟（还要排串行队列），修之后约 1 秒就拿到响应头。
10. **客户端断开就停**：请求带着 `AbortSignal`，客户端断开时上游回合一起停，不占着串行队列。
11. **添加时不需要凭据**：「添加供应商 → 内置供应商 → OpenCode」直接添加，页面会说明该供应商
    无需凭据；主进程给无凭据的内置供应商建一个空的本地账号，否则负载均衡不肯把请求发出去。
12. 首次请求会拉起运行时（npx 兜底时第一次要下载，可能数十秒），之后进程常驻直到应用退出。
13. **模型名带 `opencode/` 前缀**：对外名字是 `opencode/<运行时模型id>`（如 `opencode/deepseek-v4.1-flash-free`），
    与聚合条目（`<entryId>/<id>`）、账号通道（`<channel>/<id>`）同一命名空间；客户端请求这个名字，
    转发层经 `modelMappings` 翻回运行时认的裸 id。带前缀也把本机运行时与 `opencode_zen` 聚合条目里
    同名的免费模型（mimo/nemotron/big-pickle）分开了——裸名会撞车，前缀是点名。旧安装里用户侧的
    目录残留（上次同步的清单、停用名单）在启动时由 `namespaceModelOverrides`（`store/modelServing.ts`）
    一并搬进新命名空间，不会出现新旧两行；而能力徽章与探针仍按裸 id 查（`actualModelId`），
    所以模型页的体检结果不受影响。
