# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

ModelPort is an Electron desktop application that provides an OpenAI-compatible API proxy for standard HTTP model endpoints. It ships four provider classes: the `opencode` local runtime, a 74-entry aggregate catalogue of key-based / key-less endpoints (see "Aggregate Provider Catalogue"), the twelve account channels served by the vendored channel pack (see "Account Channels"), and user-defined custom providers. It runs on macOS, Windows, and Linux.

## Build Commands

```bash
# Development
npm run dev              # Start dev server (macOS/Linux)
npm run dev:win          # Start dev server (Windows)

# Build
npm run build            # Build the application
npm run build:mac        # Build for macOS (dmg only)
npm run build:win        # Build for Windows (nsis)
npm run build:linux      # Build for Linux (AppImage, deb)
npm run build:all        # Build for all platforms

# Preview production build
npm run preview
```

## Verification

`.github/workflows/ci.yml` runs the full gate (build + typecheck + suite) on every push and pull
request across Linux, Windows and macOS; `.github/workflows/release.yml` builds and publishes the
installers on a tag push matching `v*.*.*` / `v*.*.*-*`. `electron-vite build` transpiles without type
checking - a green build says nothing about types - which is why the gate runs both `tsc` programs.

The suite runs on Node's built-in test runner and must run on a Node that strips TypeScript natively
(22.18+ / 23.6+ / 24; CI pins 24). `scripts/check-node-version.mjs` fails fast with the fix when the
`node` on PATH is an older 22.x, where every `.test.ts` dies with `ERR_UNKNOWN_FILE_EXTENSION` - a
runtime problem, not a test failure. `npm run gate` is exactly what CI runs:

```bash
npm run gate                                           # build + tsc x2 + full suite
# equivalently, step by step:
npm run build                                          # bundle + check-source-artifacts guard
npx tsc --noEmit -p tsconfig.json                      # renderer + shared
npx tsc --noEmit -p tsconfig.node.json                 # main + preload
node --test "tests/**/*.test.ts" "tests/**/*.test.mjs" "tests/**/*.test.js"
```

Both `tsc -p tsconfig.json` (renderer + shared) and `tsc -p tsconfig.node.json` (main + preload +
shared) are clean - 0 errors. The two configs are standalone `tsconfig`s with no `references` /
`composite` wiring: each one includes `src/shared/**/*.ts` directly, so any error either one reports is
real. Do not reintroduce a project reference between them - a composite `tsconfig.node.json` makes the
renderer program resolve `@shared/*` through not-yet-built declaration outputs, which surfaces as
`TS6305` "output file has not been built" and silently suppresses the real downstream type errors.

**Eight test files cannot run in a pipe-blocking sandbox, and that is not a regression.** They fail
with `spawn EPERM` before any assertion executes, on both of the suite's two child-process paths:

| Files | Mechanism |
|-------|-----------|
| `tests/channels/{qoder-plan-gate,qoder-session-payload,workbuddy-port,minimax-tool-call-name}.test.ts` | `esbuild.build()` spawns the esbuild service binary |
| `tests/skills/modelport-{har-tool-fixture,tool-client-replay,provider-model-matrix,management-api}.test.mjs` | `spawnSync('node', …)` captures the child's stdout through a pipe |

Both hit the same boundary: a confined process cannot open a named pipe. (`node --test` spawns one
child per test file, so in a spawn-blocking sandbox the *whole* command fails regardless of content;
running a single file as `node tests/…/<file>.test.ts` works for every dependency-free test, just
not for the esbuild ones.) Counting these as regressions costs real time - re-run the same command in
a normal environment before touching source. Before attributing a red to your own change, check
whether the failing file mentions `esbuild` or `child_process` at all, and whether the file it reads
is one you edited: this checkout carries a large body of uncommitted work, so a red in
`tests/tool-calling/tool-settings-ui.test.ts` (which asserts on strings inside
`src/renderer/src/components/models/ToolCallingPanel.tsx`) or a `tsconfig.node.json` error coming
from `src/main/index.ts` can be somebody else's pending edit rather than your regression.

Two further `tests/skills/` cases fail on a Windows checkout for environmental reasons independent
of the above (a child process spawned with a macOS-style `/private/tmp` fixture path, and a `\n`-only
regex against CRLF files).

Packaging constraints worth knowing before a release: macOS produces **dmg only** (no zip), which
breaks `electron-updater` on macOS; no build is code-signed and macOS is not notarized; the
`build.publish` block decides where `--publish=always` uploads and which repo the packaged
auto-update feed points at, so it must match the repository you are releasing from.

The packaged asar ships **no `node_modules`** (`build.files` excludes the directory), so every
main-process runtime dependency must be bundled by rollup - an external dependency is a startup
crash, not a size saving. 1.4.5 externalized `electron-store` and left every install at
`Storage not initialized, please call initialize() first`; `tests/build/main-bundle-deps.test.ts`
keeps it bundled, and `store.ts` loads it inside `initialize()`'s try so a future packaging mistake
surfaces as a real error instead of that generic message.

## Architecture

```
src/
├── main/                    # Electron main process
│   ├── index.ts            # App entry point
│   ├── ipc/                # IPC handlers (main ↔ renderer communication)
│   ├── proxy/              # Proxy server (Koa)
│   │   ├── server.ts       # HTTP server, API-key middleware, `proxyServer` singleton
│   │   ├── forwarder.ts    # Request forwarding; dispatch via the `providerForwarders` registry
│   │   ├── loadbalancer.ts # Account selection (round-robin / fill-first / failover)
│   │   ├── modelMapper.ts  # Model -> actual model / preferred provider / preferred account
│   │   ├── adapters/       # Provider-specific adapters (+ stream handlers)
│   │   ├── routes/         # chat.ts, completions.ts, models.ts
│   │   │   └── management/ # /v1/management/* HTTP API
│   │   ├── middleware/     # managementAuth
│   │   ├── toolCalling/    # Tool-calling engine + client protocol adapters
│   │   ├── services/       # contextManagementService (history trimming)
│   │   └── sessionManager.ts # Session table + delete-after-chat flag
│   ├── oauth/              # OAuth authentication
│   │   ├── manager.ts      # OAuth flow orchestration
│   │   ├── inAppLogin.ts   # In-app browser login with token auto-extraction
│   │   └── adapters/       # Provider-specific OAuth adapters
│   ├── channelPack/         # Vendor channel-pack host: worker.ts + compat shims + bridge.ts
│   ├── providers/          # Provider configurations
│   │   ├── builtin/        # Built-in provider configs (one file per provider)
│   │   ├── aggregate/      # Aggregate catalogue (registry data + manager)
│   │   ├── accountChannels/ # Twelve login channels: catalogue, vault, manager, runtimeState
│   │   └── custom.ts       # Custom provider support
│   ├── store/              # Persistent storage (electron-store)
│   │   ├── store.ts        # Main store manager with IPC bridge
│   │   ├── types.ts        # Type definitions and default values
│   │   └── config.ts       # Configuration management
│   └── tray/               # System tray integration
├── preload/                # Context bridge (IPC API exposure)
├── renderer/               # React frontend
│   ├── components/         # UI components
│   ├── pages/              # Page components
│   ├── stores/             # Zustand state management
│   └── i18n/               # Internationalization (en-US, zh-CN)
└── shared/                 # Shared types between main and renderer
```

## Key Concepts

### Provider Adapters
Each AI provider has a dedicated adapter in `src/main/proxy/adapters/` that handles:
- Message format conversion (OpenAI format → provider-specific format)
- Authentication header construction
- Stream response parsing
- Multi-turn conversation context

Adapters share no interface: each `chatCompletion()` returns a different shape
(`{response, sessionId}`, `{response, conversationId}`, `{stream, sessionId}`, ...) and session
teardown is variously named `deleteSession` / `deleteConversation` / `deleteChat`. The forwarder
only needs `is<Provider>Provider(provider)` plus the call signature it handles.

To add a new provider:
1. Create config in `src/main/providers/builtin/<provider>.ts`
2. Register it in `src/main/providers/builtin/index.ts` (both `builtinProviders` and `builtinProviderMap`)
3. Create OAuth adapter in `src/main/oauth/adapters/<provider>.ts` and register it in that folder's `index.ts` (two switches)
4. Create proxy adapter in `src/main/proxy/adapters/<provider>.ts`; keep its stream handler class in the
   same file (no provider keeps a separate `-stream.ts` any more) and export it from `adapters/index.ts`
5. Add one entry to the `providerForwarders` array in `src/main/proxy/forwarder.ts`
6. Add the UI icon mapping and i18n entries

`src/main/store/types.ts` needs no edit: it re-exports `builtinProviders` as `BUILTIN_PROVIDERS`.

### Online Model List Update
Only two model-list sources exist after the web-provider retirement, and
`src/main/providers/modelListSource.ts` decides between them in this order:

- `runtime` - a builtin that declares `runtimeModels: true` (today only `opencode`). The list
  comes from the local runtime, not from an endpoint, so it has no `modelsFetch` at all.
- `http` - a builtin that declares `modelsFetch` (`url`, optional `method`/`body`, `reader`,
  `auth`, extra `headers`). `src/main/providers/modelCatalog.ts` makes the request;
  `modelListReaders.ts` turns the payload into `{ displayName, actualModelId }` pairs.
- `unsupported` - everything else. Startup writes `supportsModelFetch` from this, so a provider
  with neither source shows "does not support dynamic model updates".

Two readers exist, tried in this order under `reader: 'auto'`: `openai-list`
(`data: [{id, name?}]`, also `{models: [...]}`-shaped payloads that carry `id`) and
`openai-free-list` (the same payload filtered to `isFree === true`, used for the Kilo free pool;
a catalogue with no free model reports `empty`, never a paid model). An unrecognised payload
reports `unrecognized_shape` instead of returning an empty list, so an upstream change never
looks like "this provider has no models".

The `auth` rule list (`{ from, into: 'header', header, prefix }`, `{ from, into: 'cookie', cookie }`,
`{ from: 'cookies', into: 'cookie-map' }`) is unchanged and unused by any shipped provider: no
builtin declares `modelsFetch` now. `{uuid}` placeholders in the url/body are still substituted
with a fresh `crypto.randomUUID()` per call for any future declaration.

Aggregate providers do not use `modelsFetch`; their sync path lives in
`providers/aggregate/manager.ts`. `syncModels(id)` probes the catalogue's `modelsUrl`, or
`<baseUrl>/models` when the catalogue declares none, with every stored key in turn, then **merges**
the upstream ids into the provider's namespaced model list (see "Aggregate Provider Catalogue").

**models.dev is a fallback, and the upstream answer is tri-state.** When the probe fails
(`no_model_list`, `invalid_api_key`, `http_status`, `network_error`) `syncModels` retries the
**models.dev** catalogue (`https://models.dev/api.json`, read by `src/shared/modelsDev.ts`) under the
same entry id, and the result carries `modelSource: 'models.dev'` so the UI can say the list may lag
upstream. The decision lives in `planSyncModelIds()` and is unit-tested, because the easy mistake is
treating "upstream answered zero models" as "unavailable":

- `null` (probe failed) - **only** this unlocks the models.dev fallback;
- `[]` (probe succeeded, zero models) - the upstream's own answer; it must never be replaced by a
  third-party list, or a request is sent to a model the vendor does not serve;
- `[...]` - upstream wins outright, even when models.dev lists more, so a curated registry list is
  never widened behind the user's back.

The reader is deliberately narrow: it takes only `id` + `name`, drops every non-chat `type`
(`embedding` / `reranking` / `transcription` / `image` / `video` / `speech`), and never reads
`cost` / `limit` / `tool_call` from models.dev - those belong to `aggregateQuota.ts` and
`modelCapabilities.ts`, and copying them here would create a second source of truth.


Fetched models are stored in `userModelOverrides[providerId].fetchedModels` (+ `fetchedAt`), **not** in
`provider.supportedModels` - the startup sync rewrites that field from code. They merge into
`getEffectiveModels()` as `source: 'fetched'`, after built-in and user-added entries, skipping names
that already exist or are excluded, and `providers:resetModels` clears them along with the rest of the
overrides.

The action is the single `providers:updateModels` channel. The card menu renders it for a builtin whose
record carries `supportsModelFetch`, and for every `type: 'aggregate'` record; an aggregate id is
routed to `aggregateProviderManager.syncModels` instead of the builtin `modelsFetch` path. Failures
return a typed `reason` (`unsupported`, `no_active_account`, `http_status`, `empty`,
`unrecognized_shape`, `network_error`, plus aggregate-only `invalid_api_key`), each with its own
message in the UI.

### Aggregate Provider Catalogue

`src/main/providers/aggregate/registry.ts` is data transcribed from the reference registry:
74 entries / 473 models. Beyond dropping `openai` and `github_copilot` (browser-login account
channels - the class that was retired) and `fleetrelay_t1` (responses-only relay), seven model rows
were removed on 2026-10-29 because upstream no longer serves them (3 anthropic ids the API answers
with an error, 4 xai ids retired 2026-05-15 whose slugs still resolve and silently redirect), and
`mistral_codestral` was withdrawn as a whole because its host is absent from Mistral's published
docs while `codestral-latest` is already covered by `mistral`. `agnes` was switched on the same day
to the vendor's China host (`https://api.agnes-ai.cn/v1`) with `agnes-3.0-flash` / `agnes-2.5-flash`
in place of the deprecated `agnes-2.0-flash` (`agnes-3.0-pro` is still 即将上线). `qiniu` was added
for the Conatus campaign (model `qiniu/conatus-free`, 1亿 tokens/day for verified accounts to
2026-11-30); its receipt carries `tpd`/`contextWindow`, and the entry must be withdrawn when the
campaign ends because the vendor stops serving the model entirely. `sensenova` was added for the
Token Plan public beta; its schema rejects fields the official table does not list, so the entry
declares `dropParams` (`response_format`, `enable_thinking`, `tool_choice=auto`,
`tools[].function.strict`).
`tests/aggregate/registry.test.ts` pins that list so a re-transcription cannot resurrect them.
`openai_api` stays and is served over the chat wire. `vertex` / `vertex-partner` are listed with
`authKind: 'unsupported'` because Google ADC cannot be produced here.

- `manager.ts` only writes a provider record when the user saves one, so the provider list never
  carries 70+ unusable rows. The record is `type: 'aggregate'`, `id` = registry id, and carries
  `wire`, `authHeader`/`authPrefix`, `aggregateId`, `supportedModels`, `modelMappings`.
  `initializeDefaultProviders()` only repairs `type === 'builtin'` records, so aggregate records
  survive a restart.
- Accounts: a keyed entry stores **one account per key** (the config dialog takes one key per line);
  the load balancer round-robins the entry's requests over them, so a rate-limited key falls through
  to the next. A key-less entry (`kilo`, `ollama`, `lmstudio`, `llamacpp`) gets a credential-less
  active account so the load balancer can route it.
- Display names are `<providerId>/<modelId>`. `save()` writes `provider.modelMappings`
  (displayName -> upstream id) and a global `config.modelMappings` entry with
  `preferredProviderId`, which is what makes `loadbalancer` route a name to exactly one entry.
  Removing the provider drops both.
- Wires: `openai-chat` reuses the forwarder's default branch (70 entries).
  `anthropic-messages` (`anthropic`, `glm`'s `/api/anthropic`, `minimax-cn`) uses
  `proxy/adapters/anthropic.ts`, which converts messages/system/tool_use blocks and re-emits the
  SSE stream as OpenAI chunks with `skipTransform`.
- `openai-responses` is **outbound only** (`wire: 'openai-responses'`, path `/responses`), for
  endpoints that expose nothing but the Responses API. `forwarder.forwardResponsesWire()` takes the
  request over from the default branch *before* any chat body is built, because the two differ in
  three ways:
  - no prompt-based tool injection - Responses has native tools, and layering the managed prompt
    on top would double the tool description;
  - the body is rebuilt by `chatToResponsesRequest()` rather than copied field by field;
  - the stream is translated per event, not buffered to the end, so time-to-first-byte stays equal
    to the upstream's first delta.

  `src/shared/responsesWire.ts` holds all of it as pure functions (`chatToResponsesRequest`,
  `responsesBodyToChat`, `responsesEventToChatChunks`) so the translation is testable without
  network. Four rules are load-bearing and each has a test in `tests/shared/responses-wire.test.ts`:
  - `usage` is `null` when upstream did not report it - never zero-filled;
  - exactly one `[DONE]`, emitted once even if upstream closes without `response.completed`;
  - `response.failed` / `error` becomes a `{"error": ...}` frame, never assistant text;
  - `refusal` and `function_call` output items never leak into `message.content`.

  There is **no inbound `/v1/responses` route**: a client speaking Responses to this proxy would
  need the reverse codec, and no known client asks for it yet.
- Auth header: `Authorization: Bearer` by default, `x-api-key` for the anthropic wire, `api-key`
  for `azure_openai`; `forwarder.buildHeaders()` reads `provider.authHeader`/`authPrefix`.
- A baseUrl containing `{placeholders}` is never expanded: the user has to override it. `test`
  probes the list endpoint for connectivity; `syncModels` merges what it answers into the exposed
  list (only adds, never removes, so curated lists and per-model parameters survive). `kilo`
  uses the `openai-free-list` reader, so only `isFree: true` models are exposed.
- Parametpolicy passes every parameter through for any `type !== 'builtin'` provider, so aggregate
  requests are never silently stripped.

### Load Balance Strategies

`LoadBalanceStrategy` is `round-robin | fill-first | failover | smart | pace`. The first three use
pool order and failure history only. The last two are driven by the quota ledger
(`src/main/proxy/quota/ledger.ts` + the pure logic in `src/shared/quotaPacing.ts`):

- **`smart`** picks the candidate whose quota window **resets soonest**, so allowance that is about
  to roll over gets used instead of wasted;
- **`pace`** picks the candidate with the most **remaining allowance per hour** until its window
  closes.

Three rules, all encoded in `tests/shared/quota-pacing.test.ts`:

1. **Reset time is derived, never stored.** The ledger keeps usage only; `quotaPacing` recomputes the
   boundary from the window definition (rolling minute / rolling 24h aligned to whole windows, UTC
   calendar month). `quota-ledger.json` keeps its current format.
2. **No derivable reset means no opinion.** A candidate whose provider has no enforceable cap, or
   whose ledger read failed, does not participate; `selectByQuotaPacing()` returns `null` and
   `selectAccount()` falls back to `fill-first` order. Never a forced pick, never a dropped
   candidate - "cannot compute" is not "cannot serve".
3. **An exhausted candidate is a last resort.** `pickBestPace` skips candidates with zero remaining
   when any usable one exists; `pickSoonestReset` ranks full candidates after every candidate that
   still has allowance, even when the full one resets sooner.

`auto` has its own scoring profile per strategy (`AutoRoutingStrategy` mirrors the same five values).
Its `smart`/`pace` branches cannot see reset times - scoring runs before selection - so they only
raise the weight of `headroom` and `quota`; the actual reset-aware step happens later in
`loadbalancer`.

The union is declared **twice** (`src/shared/types.ts` and `src/main/store/types.ts`) with no type
wiring between them, and the UI carries two hard-coded maps plus the selector list.
`tests/shared/load-balance-strategies.test.ts` pins all five values across the two unions, the auto
enum, the selector, both label maps and both locales, because missing one produces a strategy that
silently cannot be selected or renders as `undefined`.

### Aggregate Free-Quota Layer

The free-tier caps of the aggregate catalogue live in a generated sidecar,
`src/shared/aggregateQuota.ts` (`entryId -> { rpm, rpd, tpm, tpd, monthlyTokens, contextWindow,
source, perModel, docUrl, asOf, officialNote }`). It is produced by
`scripts/build-aggregate-quota.mjs` from the evidence receipts in
`docs/data/free-quota-research/*.json`; edit the receipts, then re-run the script - never hand-edit
the output. Each receipt row must carry a verbatim quote and a `docUrl`, and the generator flips
`source` to `documented` **only** when at least one number is present (a page that was found but
publishes nothing is `undocumented`). Receipts may set `withdrawn: true` to keep the evidence for an
entry that left the catalogue.

Current coverage: 16 of 74 entries have at least one documented number; the rest are `undocumented`.
Two rules follow from that and are easy to break:

- **`undocumented` never blocks a candidate.** "No published cap" is not "no quota": the gate
  (`proxy/quota/gate.ts`) and `limits.resolveCaps()` only enforce when a real cap exists, otherwise
  the entry routes as before. 58 of 74 entries depend on this.
- **A cap that is not in tokens is never converted.** `officialNote` carries the vendor's own unit
  and conditions (Cloudflare's Neurons/day, kilo's requests/hour/IP, concurrency limits, monthly USD
  spend, minimum-purchase thresholds). The panel displays it verbatim; it takes no part in
  enforcement.

Runtime accounting and enforcement:

- `proxy/quota/ledger.ts` keeps per `(providerId, accountId, modelId)` counters in
  `quota-ledger.json` (debounced write, temp-file rename, corrupt file set aside). Windows are
  **rolling** last-minute / last-24h plus a **UTC calendar month** - intentionally not the vendor's
  calendar day, so an exhausted window is detected earlier rather than later.
- `proxy/quota/observations.ts` learns caps from what the user's own traffic already returned:
  `x-ratelimit-limit-*` headers and `limit: N` plus an axis keyword in a 429 body. Learning is
  fill-or-lower only, never raise, and an unparsable axis is not guessed. This is the only channel
  through which `undocumented` entries ever gain a number.
- `proxy/quota/limits.ts` merges entry caps, per-model caps and learned caps (each only lowers) and
  reports which window is full; `monthlyTokens` > `rpd`/`tpd` > `rpm`/`tpm` in reporting order.
- `routes/chat.ts` meters every success exit (non-stream body, both stream branches) and feeds the
  learner from every response. Usage the upstream did not report is estimated for the ledger only -
  it is never written into the client's response body, which stays `usage: null`.

**The estimate has two rules that used to be violated in both directions at once**
(`proxy/quota/usage.ts`, pinned by `tests/proxy/quota-usage.test.ts` and fenced by
`tests/proxy/quota-metering.test.ts`):

- **`sseDeltaText()` strips the SSE framing before estimating output.** Feeding the raw collected
  stream to `chars/4` counts every frame envelope as model text — ~150-260 characters per emitted
  token, i.e. output inflated 40-65x. Measured on this machine after the fix: raccoon's
  ledger average fell **4.7x** (48,695 → 10,345 tokens/request) and loomy's 1.5x on identical
  traffic, the difference being exactly the frame bytes. Do not read this as "every provider number
  was 40x wrong": TRAE's 503,769 estimated tokens/request happened to sit within 0.1% of TRAE's own
  reported 503,128 - the estimate was inflated there too, but its requests were near-empty of deltas,
  so the two errors cancelled. An estimate is only trustworthy per provider, which is why the
  upstream/estimated pools stay separate. Text with no `data:` lines passes through unchanged (the
  non-stream path hands in plain content; returning `''` for it would erase real output). SSE with no
  deltas at all estimates 0, because frame bytes are not the model's answer. Tool-call
  `name`/`arguments` count as output.
- **`usageInputText()` counts `messages` + `system` + `tools`.** The old
  `JSON.stringify(request.messages ?? [])` omitted tool schemas, which for agent clients are
  usually the largest part of the request - so input was underestimated while output was
  overestimated, and the number that decides "is prefix replay worth fixing" was wrong in the
  flattering direction.
- **`cacheReadTokens` is an upstream-reported subset of input, and is absent, never 0, when the
  upstream did not report it.** `0` is a claim ("nothing was cached"); absence is the fact ("this
  path does not tell us"). The day counter stores `upstreamCacheRead` and the dashboard row renders
  only above zero, so a channel that reports nothing cannot be read as "caching failed". Caps are
  deliberately **unchanged**: `ledger.record()` still subtracts `totalTokens`, because whether a
  cache read also consumes the vendor's own allowance is unevidenced, and crediting it as free would
  make `smart`/`pace` believe a fuller window than we can prove.
- `normalizeDayBucket()` derives its field list from `emptyBucket()` (loop, not transcription), and
  `accumulateDayBucket()` runs its persisted input through it. Both exist because buckets come off
  the disk: an older `data.json` predating any added field would otherwise make `base.field + x`
  `NaN` and poison the whole day.

**Inside the pack, `TokenUsage.inputTokens` means "input *excluding* cache reads."** The gateway adds
`cacheReadTokens`/`cacheWriteTokens` back (`openai-gateway/usage.ts::toOpenAiUsage`) - that convention
is what the documented 2026-10-04 Codex under-count fix rests on. So an adapter that starts reporting a
cache field must know which convention that field carries, and `vendor/channel-pack/src/usage-cache.ts`
is the single place that decides, **by field name rather than by provider** (a provider can change
gateway without changing its name): `prompt_tokens_details.cached_tokens` and
`prompt_cache_hit_tokens` are **subsets** of `prompt_tokens` → subtract; `cache_read_input_tokens`
(Anthropic) is **parallel** to `input_tokens` → never subtract. Reversing it either double-counts the
cache (inflated context, the client compacts too early) or double-deducts it (reported context pinned
near zero, auto-compaction never fires). Pinned by `tests/channels/usage-cache.test.ts`, including
"absent stays absent" and the `cached > prompt` clamp. TRAE previously read only three usage keys, so
its cache-read total of 0 on this machine is *either* "TRAE does not cache" *or* "TRAE reports it and
we never looked" - indistinguishable until this landed.

Bare model names across entries:

- A request for `glm-5.2` (no `<entry>/` prefix) is expanded by
  `shared/aggregateRouting.ts` into an ordered chain over every entry serving that exact id, ordered
  by headroom, and `loadbalancer.selectChainCandidates()` turns it into candidates. A prefixed name
  (`glm/glm-5.2`) is a pinned choice and is never expanded; `preferredAccountId` is likewise a hard
  pin.
- `forwarder.forwardChainCompletion()` and `forwardAutoCompletion()` share one loop
  (`forwardFirstReachable`), so both fail over on 429/5xx/no-status and stop on other 4xx. When the
  chain is used, `routes/chat.ts` adopts the account that actually answered and sets
  `X-ModelPort-Aggregate-Chain` to its entry id - observability without log-reading.

The aggregate page renders one quota cell per entry with five mutually exclusive states
(`needs-key`, `exhausted`, `documented`, `undocumented`, `absent`) plus a separate free-pool badge;
the numbers always carry their window, and "exhausted" means the documented cap against **this
app's** metering, not a live balance. Displaying a live balance would need a vendor quota endpoint,
which this project deliberately does not call on its own.

### Aggregate Per-Model Cost Classification

Quota answers "how much may I send"; cost answers "does this model cost extra". Separate sidecars,
because the sources differ in kind:

- `src/shared/aggregateQuota.ts` - **vendor-official** caps, every number with `docUrl` + `asOf`.
- `src/shared/aggregatePricing.ts` - **third-party** prices (`models.dev`, USD / 1M tokens) **and**
  the vendor-official free list. Generated by `scripts/build-aggregate-pricing.mjs` from
  `docs/data/models-dev-cost.json`; refresh the snapshot with `--payload <api.json>`, then re-run.
  Never hand-edit either sidecar.

`src/shared/aggregateCost.ts` is the single classifier (`aggregateCostOf`); consumers read
`AggregateModelInfo.cost` rather than inspecting prices. Four classes, in evidence order:

| class | evidence | meaning |
|-------|----------|---------|
| `free` | `official` > `catalogue` > `third-party` | no extra cash outlay |
| `included` | `plan` | allowance already inside a subscription |
| `priced` | `third-party` | metered by token |
| `unknown` | `none` | nothing known - neither free nor paid |

Four rules are load-bearing, each pinned by `tests/aggregate/aggregate-cost.test.ts`:

1. **A zero price is not "free".** Subscription endpoints (`AGGREGATE_PLAN_ENTRIES`: `kimi_code`,
   `zai`, `glm-cn`, `qwencloud`, `qwencloud_coding`, `xiaomi-tokenplan`, `sensenova`) show a zero
   *marginal* price on models.dev because the allowance was bought up front; calling that "free"
   says a user can run without paying when the plan allowance simply ends. The list is hand-written
   with a per-entry reason - **do not** regex on "plan" in the id: `sensenova`'s host is
   `token.sensenova.cn` (no "plan" substring), while `zai_api` is the same vendor's *metered*
   endpoint (`api.z.ai/api/paas/v4`) and keeps its real prices.
2. **Alignment is by exact `baseUrl` only** (host + path, trailing slash ignored). Brand names and
   bare hosts collide: `zai` (coding-plan, zero) and `zai_api` (pay-as-you-go, metered) serve the
   same ids at contradictory prices. A `baseUrl` matching more than one models.dev provider is
   skipped, never guessed.
3. **USD is never folded into a multiplier.** A multiplier is *relative*; a price is absolute.
   Converting needs a base this repo does not have, so `costBucketOfAggregateClass` answers only
   "does it cost extra": `free`/`included` -> `free`, `priced` -> `above-base`, `unknown` ->
   `unknown` (neutral). No ordering, no price comparison.
4. **Unknown is a real answer.** An unmarked, unpriced model stays `unknown`, never folded into the
   free bucket. `aggregateCostCounts` keeps four separate counts so the panel shows "N free / N in
   plan / N metered / N unlabelled" instead of a misleading free/paid split.

`auto` routing reads this through `costBucketFor` in `autoRouter.ts`, replacing the old
`freeModelsHint`-only branch that sent all 91 priced rows and every subscription endpoint to
`unknown` (which left `cheap` preference unable to avoid paid models). The panel renders one badge
per row plus a cost filter, and the free badge carries its evidence in the label ("Free
(vendor-declared)" / "Free (catalogue)" / "Free (third-party price)") because only the first is a
vendor claim.

`AGGREGATE_OFFICIAL_FREE` reuses the `freeModelIds` the quota receipts were already collecting but
the quota generator discarded; it keeps only ids the catalogue ships, since claiming a free model we
cannot route to advertises something that never answers.

### Account Channels

Twelve browser/device-code login channels - `lobsterai`, `qoder`, `qodercn`, `trae`, `cline`, `loomy`,
`raccoon`, `minimax`, `zcode`, `gemini`, `workbuddy`, `buddy` - are not HTTP endpoints either. Each one is a DSH
"channel pack" provider that owns its own login flow, account pool, daily credit claim and model
gating. The upstream implementation is **vendored as source**, not as a bundle:

- `vendor/channel-pack/src/` is the upstream tree (149 upstream TS files plus the local
  `qoder-plan-gate.ts`, `qoder-session.ts`, `queue-wait.ts` and the WorkBuddy family: `buddy.ts`,
  `buddy-auth.ts`, `buddy-oauth.ts`,
  `buddy-adapter.ts`, `buddy-balance-*.ts`, `product.ts`, `openai-gateway/tencent-fingerprint.ts`).
  `qoder-session.ts` and `queue-wait.ts` are deliberately **import-free** so their rules can be
  unit-tested by `import()`ing the source directly - vendor files carrying TS parameter properties
  (`qoder-wasm.ts`) cannot be, and need the esbuild path.
- Both buddy products resolve an account through `BuddyBalanceSelector` (`buddy-balance-rank.ts`
  supplies the 15-day expiring/permanent split). A product with `permanentLocked` and no expiring
  credits throws instead of falling back to pool order: the fallback would burn permanent credits
  and make the lock meaningless. Free models skip the balance query entirely, since they cost 0.
- `src/main/channelPack/compat/` holds the shims for the private packages the upstream imports
  (`virtual:*`, `@deepseek-ai/*`, `undici`, `image-pricing`). They are only reachable through
  esbuild aliases; `src/main/types/channelPack.d.ts` declares the virtual modules so `tsc` never
  walks into the vendor tree.
- `scripts/build-channel-pack.mjs` bundles `src/main/channelPack/worker.ts` into
  `resources/channel-pack/worker.mjs` (gitignored; the `.wasm` / `LICENSE` / `NOTICE.md` next to it
  are vendored and tracked). `npm run build` and both dev scripts run it first.
- The worker **cannot live inside the asar**: `package.json` copies `resources/channel-pack` to
  `extraResources`, and `bridge.ts` resolves it from `process.resourcesPath` when packaged
  (`resources/channel-pack` in dev).
- Two env vars are mandatory at spawn. `DSH_CHANNEL_PACK_STATE_DIR=<dataDir>` (the pack appends
  its own `channel-pack/` subdirectory, so state lands next to our `credentials.json`); without it
  the pack writes its accounts into the user's real `~/.dsh`; and
  `DSH_OPENAI_GATEWAY_ENABLED=0`, otherwise the pack mounts its own fixed-port (8326) OpenAI
  gateway and the second instance dies with `EADDRINUSE`.

Flow: `bridge.ts` (main) spawns the worker and shuttles
`credential | log | changed | ready | sse | completion | done | result | error` up and
`credential-result | cancel | close | models | rpc | complete` down. Credentials never travel by
message value: the worker asks, `vault.ts` resolves from
`<dataDir>/channel-pack/credentials.json` (values encrypted through `storeManager`), and only
`{value}` / `undefined` goes back. Provider management is an in-worker HTTP route (`/api/channel-pack`)
whose result is `{ok:true,value}` / `{ok:false,error}`; the methods used here are `provider.status`,
`provider.setEnabled`, `account.list|create|update|delete`, `login.poll`, `credits.balances`,
`credits.claimAll`, `model.list` and `usage.autoCheckin` (the global one-switch daily auto-claim: no
argument reads its state, a boolean writes it).

The model catalogue comes from `model.list`, **not** from `bridge.models()` — with exactly one
exception: `model.list` carries no context window, so `manager.models()` pulls the OpenAI-shaped
`/v1/models` view **once per cache refresh** (shared by all twelve channels) and merges only
`context_window` into the catalogue (`modelCatalog.ts::attachContextWindows`). The view cannot say a
model's multiplier or its `disabled` / `dead` state, which is why `model.list` stays authoritative.
`model.list` returns `{models: [{id, name, disabled, dead, isFree?}]}` and is the only place
that knows a model's **credit weight** - there is no numeric field for it, the multiplier is appended
to the display name in one of three shapes:

```
MiniMax M3 · x4.0          rate only          (loomy / lobsterai / qoder)
GLM-5-3-Flash · x0.2→x0.1  base → effective   (qoder promo / raccoon)
Qwen3.8-Flash · 免费        free               (qoder priceFactor 0 / cline / raccoon)
```

`providers/accountChannels/modelCatalog.ts` is the single parser (`splitModelLabel` +
`readModelList`); everything else reads `ChannelModelInfo`. Three rules: a missing `weight` stays
`undefined`, **never** `0` - trae / minimax report no rate at all, and treating "unknown" as free
would make a user pick a metered model expecting a free quota; an upstream `isFree: true` wins
over the label, so a model is free when `isFree` is set **or** the weight parses to 0; and a missing
`contextWindow` stays missing, **never** a guess - `autoRouting` hard-filters on `contextTokens`, so
inventing a small number silently removes whole channels from every long-context request, which is
the opposite of the "unknown is a real answer" rule the router is built on.

The IPC surface is `channels:models` (one channel's catalogue, 30s cache),
`channels:refreshModels` (re-read online, then rewrite the provider record and the global model
mappings; failures return `reason: 'empty'` while keeping the old record), and the two model
mutations `channels:setModelDisabled` / `channels:clearDeadModels` (`model.setDisabled` /
`model.clearDead`, both returning the fresh catalogue). All three clear the **whole** catalogue cache
and run a full `syncProviders()` rather than refreshing one channel: a partial cache would make
`syncProviders` see the other channels as having no models, and an enabled record with an empty model
list becomes a wildcard route target.

`syncProviders` writes only the models that are neither `disabled` nor `dead` into
`supportedModels` / `modelMappings`. `model.list` deliberately keeps both in the catalogue - a model
the user switched off has to stay visible or it can never be switched back on, and a dead model needs
to stay visible for `model.clearDead` - but exposing them as routable would send requests to models
that are guaranteed to fail (disabled) or that the pack pruned for repeatedly failing (dead; the only
self-heal is a 30-day TTL, so the clear button is the sole manual recovery). Account credentials are
renewed through `channels:rpc('account.refresh', {accountId})` and the pool order through
`channels:rpc('account.reorder', {provider, orderedIds})` - the load balancer hands requests out in
pool order, so reordering is how a user picks the preferred account.

`manager.ts` mirrors that state into provider records. It only writes one when the channel has at
least one account, so the provider list never grows twelve unusable rows; records are
`type: 'account'`, `apiEndpoint: channel://<id>` (a placeholder that is never requested),
`supportsModelFetch: false`, an identity `supportedModels` / `modelMappings` plus the global
`config.modelMappings` entry carrying `preferredProviderId`, and a credential-less local account so
the load balancer can route. Two rules are easy to get wrong: **zero accounts means the record is
deleted**, and **accounts but an empty model list means `enabled: false`** - an enabled provider with
no models is treated as a wildcard by `providerSupportsModel` and would swallow every model name.
Model ids are `<channel>/<model>`; the worker splits on the first `/`, so nothing plain-prefixes
them twice.

`checker.ts` answers `online` / `unknown` for these from `accountChannels/runtimeState.ts` - it must
never send HTTP to the `channel://` endpoint and never start the worker as a side effect of a status
check. The request path is one `providerForwarders` entry (`provider.type === 'account'`) that hands
the body to `bridge.complete` / `bridge.openStream`; the stream is already OpenAI-shaped, so it
returns `skipTransform: true`.

**The host retry budget is per provider class, and for account channels it is one short retry**
(`src/main/proxy/retryPolicy.ts::planForwardRetries`, the only consumer being
`forwardChatCompletion`'s loop). Account channels already own queueing, quota and account-switch
backoff inside the worker, so the old uniform `5000ms x retryCount(3)` stacked a second backoff on
top - and a host-side retry is not free there: it re-resolves the credential across the thread
boundary, re-encrypts the entire history through WASM and re-hits upstream. Dropping retries to zero
would be the opposite mistake, because the pack does *not* cover two transient classes (worker
restart, `TRANSPORT`), so the host keeps exactly one 500ms attempt. The policy only ever **lowers**
a caller-supplied budget: `forwardAutoCompletion` passes `{ maxRetries: 0 }` as an instruction
(fail the candidate, move to the next), and raising it would double the chain's wait.

**Tool calls round-trip through the pack gateway twice, and both hops can lose the name.** The
chat projection (`vendor/channel-pack/src/openai-gateway/stream.ts`) takes a tool call's `name`
**only** from the `tool-call-delta` chunk and ignores the one in `block-end`, so an adapter that
omits `name` on the delta yields an OpenAI-shaped `tool_calls` with no `function.name`. The client
echoes that history back, the gateway's inbound check
(`messages.ts` `convertToolCalls`) rejects it with `assistant.tool_calls contains an invalid
function call`, and the whole conversation dies on a request that looks fine. minimax hit exactly
this - it recorded the tool name in `content_block_start` but never put it on the delta; the fix
adds `name` there, and `tests/channels/minimax-tool-call-name.test.ts` drives the real vendor
parser plus the real gateway projection (bundled through esbuild, since vendor source cannot be
imported directly under `node --test`) so a regression is caught at the wire format, not at the
adapter's internals.

That inbound error is also why the worker pre-validates the history itself
(`src/main/channelPack/toolCallValidation.ts`, called from `worker.ts` before `toGenerateOptions`):
the pack's own message says only "invalid function call", so a client developer has no way to tell
which message, which call, or which field is wrong. The pre-check mirrors the gateway's rules
exactly - it must never reject what the gateway accepts - and reports the coordinates plus the
received type (`messages[2].tool_calls[0].function.arguments must be a string, received object`).
It throws with `status: 400` so the client sees `invalid_request_error` rather than a 500.

**Qoder's numeric business codes are classified by code/payload, never by HTTP status**, and each
one has exactly one home: `model-queue.ts` for `10605` (queue) and `110` (daily billing quota:
`QUOTA_EXCEEDED`, switch account and mark the model until 00:00 UTC+8), `qoder-plan-gate.ts` for
`112`. The `10605` wait is **sliced, not truncated**: `rawQueueDelayMs()` returns the server's
declared delay uncapped and `queue-wait.ts`'s `planQueueWait()` sleeps that whole delay in slices of
≤ 10s (`DSH_QODER_QUEUE_SLICE_MS`), honoring at most 30s of it (`DSH_QODER_QUEUE_MAX_WAIT_MS`)
before re-sending **once**. The old code clamped the *wait* to 10s and re-sent, so a server-said-30s
queue cost three full encrypted requests plus three full prefills. `queueDelayMs()` keeps the old
clamped semantics but is now only for callers that want a single `Retry-After` hint; the adapter must
use the uncapped one. `112` is a **plan/tier gate**, not quota: the
upstream answers (HTTP 200, inside the SSE envelope) with
`{"code":112,"message":"{\"isHighestTier\":false,\"pricingUrl\":\"https://qoder.com.cn/pricing?client=qoder\"}"}`
while a free model on the same account still works (measured 2026-10-29: `qodercn/dfmodel` gated,
`qodercn/qfmodel` fine), so only an upgrade changes the answer. It is recognised in all three
channels - the envelope-unwrapped frame, the bare frame, and a non-SSE JSON body - and becomes a
readable `PERMISSION_DENIED` (non-retryable) error carrying the pricing URL, never a credential
refresh. Leaving it as `SERVER` produced the reported symptom: raw JSON plus `(112/model_error)` in
the client, and five pointless retries. `compat/dshLlm.ts` also keeps the upstream status in
`failure.status` (the contract `openai-gateway/stream.ts` and `opencode-adapter.ts` already read),
so a 4xx survives to the client instead of degrading to 502.

**Qoder's `session_id` is a conversation identity, not a per-request nonce**
(`qoder-session.ts::deriveQoderSessionId`, consumed by `buildQoderInferPayload` via
`QoderInferAsk.sessionId`). The adapter re-sends the **whole** history every turn, so a random
session id (`crypto.randomUUID()`, the old behaviour) makes turn N pay for a cold prefill of turns
1..N-1 on every single round - that is the measured-feel "much slower than the IDE", because the IDE
talks inside one server-side session. Derivation dims are `model / account / system / first user
text` (same set `gemini.ts::deriveGeminiSessionId` uses; the hash itself is not the vendor's), and
the value stays UUID-shaped so the wire does not change form. Three rules follow: **the first** user
message, never the last (the last one changes every turn and would recreate the bug); `generation 0`
must hash identically to "no generation" (otherwise shipping this rotates every live conversation
and throws away the cache it was meant to build); and the account is part of the seed, so a
queue/quota account switch rotates the session with it. Rotation is bounded and observed: a 409
`duplicate_request` bumps `sessionGeneration` (a same-content resend under a reused session would
otherwise hit the same dedupe), and `looksLikeSessionConflict` bumps it once more - but only on
wording that is actually about the session or the context length, never on `10605` / `110` / `112`,
each of which already has a correct handler. `DSH_QODER_SESSION_REUSE=0` restores random ids;
`onSessionConflictFallback` logging is the only signal that reuse is being rejected upstream.

**A test of the envelope path must peel the envelope first.** Production is
`consumeOpenAiSse(unwrapQoderEnvelopeStream(response, 'qoder'))` (`qoder-adapter.ts`), and the two
halves are not interchangeable: handing the raw envelope to `consumeOpenAiSse` shows it a frame with
no `choices` and none of the inner `code`, so it drops the frame silently and the stream ends
normally. A test written that way asserts on a `undefined` error and reads as a product regression -
`tests/channels/qoder-plan-gate.test.ts` hit exactly this (it even destructured
`unwrapQoderEnvelopeStream` and never called it), while every bare-frame and non-SSE case passed.
Any new case for this pipeline should drive the pair in production order rather than testing the
consumer in isolation.

**Reasoning is replayed into the inbound history, because the client does not send it back.**
DeepSeek-family upstreams reject an assistant turn that carries `tool_calls` without the
`reasoning_content` it produced (see the reasoning note in `openai-gateway/messages.ts`). Measured
2026-10-30 on one 274-turn capture: `trae/deepseek-v4.1-flash` was missing `reasoning_content` on
**253 of 274** tool-call turns (92%) while `loomy/GLM-5.3-Flash` missed only 4 of 41 (its upstream
does not require the pairing) - which is exactly why only the DeepSeek-family channels failed, with
the upstream's own generic `assistant.tool_calls contains an invalid function call`.
`channelPack/reasoningReplay.ts` fixes it on the proxy side: it observes **what we emit downstream**
(not what the upstream produces, because upstreams express reasoning either as a field or as an
inline `<think>` tag that `sse.ts` un-shifts, and the downstream is where those two forms have
already merged), caches it **by `tool_call.id`** - the only stable anchor both sides share, since the
client may rewrite content - and injects it on the next request when the client left it out.
Four rules: a turn the client already sent reasoning for is **never touched**; a turn with genuinely
no reasoning is never filled (no fabrication) and is not cached; the cache is **bounded**
(`REPLAY_MAX_IDS`, 4096 ids, oldest-first) because it is cross-request state and an unbounded one
would be a de-facto session table; and `DSH_REASONING_REPLAY=0` restores plain pass-through, which is
the first thing to try if an upstream ever starts validating that the replayed reasoning matches its
own record. Acceptance criterion, pinned by `tests/channels/reasoning-replay.test.ts`: after replay,
`countToolCallShapes().missingReasoning` is 0 with the `assistantWithCalls` denominator unchanged.

**The shadow counter exists because request-body logging structurally cannot answer this.**
`countToolCallShapes()` (same file as the validator, and **pure observation** - it never affects
validation) logs one line per request that has tool-call turns. Body logging was tried first and
failed for a concrete reason: a real request body measured **1.8 MB** while
`requestLogConfig.maxBodyChars` truncates **from the head** (8000 default, 40 000 at most), and
`tool_calls` necessarily live in the tail of `messages` - so the evidence was always cut off, and
raising the cap to fit would cost hundreds of MB per day. Logging counts instead of content answers
"how many turns are missing reasoning" with no user text on disk.

### Auto Routing (the virtual `auto` model)

`auto` is a reserved display name routed by `src/main/proxy/autoRouter.ts` (data collection, sticky
state, cooling) and `src/main/proxy/autoRouting.ts` (all pure decision logic, unit-tested directly).
Its candidate pool is exactly `getEffectiveModels(provider)`, i.e. the models the user kept served -
auto never widens that.

**Capability is tri-state and unknown is a real answer.** `ModelCapability` (vision/tools) is
`yes | no | unknown`; `contextTokens` is `undefined` when unknown and never defaulted to a number.
Sources, highest first: `Provider.modelCapabilities` (written by the builtin sync and by the
account-channel sync from `ChannelModelInfo`), the static table in
`src/main/proxy/modelCapabilities.ts`, the provider-level fallback there, then the name heuristics.
The static table is keyed by provider record id and *also* retried against the part after the last
`/`, because aggregate display names are `<entryId>/<modelId>` and the old table silently missed
every one of them.

Filtering rules: an image request only reaches a model whose vision is `yes` (an image dropped
upstream is a wrong answer); `tools: no` is excluded but unknown is allowed with a small penalty; a
known `contextTokens` filters hard and an unknown one uses `UNANNOTATED_CONTEXT_FLOOR` (64000).

**Contract filtering.** `contractNeeds()` derives what the response shape depends on - `n > 1` and
`response_format: json_object | json_schema`. Only builtin providers fail those (see
`parameterPolicy.ts`). If no candidate can satisfy the contract: `n > 1` is a 400
`unsupported_parameter`, while `response_format` still routes and sets
`X-ModelPort-Auto-Degraded: response_format` - returning free text beats refusing the request, but it
must never be silent.

**Cost and preference.** `costBucketOf()` (shared with the channels UI) turns the channel
multiplier into a bucket; unknown is neutral, never "cheap". `prefer` is
`balanced | fast | strong | cheap`, stored in `autoRouting.prefer`, overridable per request with
`X-Auto-Prefer`. It changes both the target tier and the weight the cost factor carries: balanced
0.2, fast 0.2, strong 0.1, cheap 0.6 (cost enters as `weight * (costScore - 0.5)`, so an unknown
cost contributes exactly zero). Builtin and custom providers have no cost data at all.

**Stickiness is a bonus, not a pin.** The previous candidate for the same conversation
(`conversationKey` = system prompt + first user message) scores +0.12 (same account) or +0.06 (same
model, another account). A cooled-down or exhausted candidate simply leaves the pool.

Response headers on every `auto` response: `X-ModelPort-Route` (winner), `X-ModelPort-Auto-Prefer`,
`X-ModelPort-Auto-Reason` (`only` / `sticky` / `score`), `X-ModelPort-Auto-Attempts` (set after
forwarding), and `X-ModelPort-Auto-Degraded` when a contract was relaxed. An empty candidate pool
answers 503 with `details.missing` (`vision` / `tools` / `context`) instead of a bare "no model".
The same decision record is stored on `RequestLogEntry.auto`.

### Runtime-backed Providers (OpenCode)
OpenCode does not talk HTTP: a builtin can declare `runtimeModels: true` in `builtin/<provider>.ts`,
which means its model list comes from a local runtime instead of an endpoint. Three places treat that
flag differently from a normal provider, and all three are easy to get wrong:

- **The endpoint is a placeholder.** `apiEndpoint: 'opencode://local'` is never requested; it exists
  so the provider record stays complete. `providers:add` therefore must not apply the
  http/https rule to it: `CustomProviderManager.validate` asks `isRuntimeBackedProvider(id, type)`
  (`providers/endpointPolicy.ts`), which only answers yes when the **shipped builtin config** says
  `runtimeModels` - a caller-supplied flag would let any custom provider skip the check.
- **A local account has to exist.** A credential-less provider still needs one active account or the
  load balancer refuses to route, so `storeManager.ensureLocalAccount()` creates an empty active
  account for every builtin with no `credentialFields`. It runs inside `initialize()`, before
  `isInitialized` is set, so it must check `this.store` and never `ensureInitialized()`.
- **Status checks must not send HTTP.** Probing `opencode://local` is axios's "Unsupported protocol
  opencode:". `ProviderChecker.checkProviderStatus` answers `unknown` (runtime not started yet) or
  `online` (already running) from `opencodeService.getState()` instead, and never starts the runtime
  as a side effect of a status check.

The same flag decides where the model list comes from: `providers/modelListSource.ts` resolves
`runtime` **before** `http`, because a runtime-backed provider has no `modelsFetch` at all and would
otherwise be reported as "does not support online updates".

A runtime-backed provider answers slowly (one agent turn is 30-60s), so its streaming request must
not wait for that turn before opening the stream: `forwardOpencode` returns a
`createDeferredCompletionStream()` that already carries the role chunk, so the response headers go
out at once and the body follows. Otherwise any client with a response-header deadline (AxAgent:
10s) fails the request before the answer exists. `ForwardResult.deferred` marks that case, and the
route then records the total elapsed time instead of the time to first byte.

The envelope is constrained at the decoding layer, not just in the prompt: `opencode/envelopeSchema.ts`
builds `calls[].items` as an `anyOf` over the tools actually offered (each name is a `const`, its
parameter schema is inlined) and turns `tool_choice: required`/a forced function into `minItems: 1`
and `parallel_tool_calls: false` into `maxItems: 1`. Two constraints are deliberately **not**
enforced, because the runtime hard-codes `toolChoice: "required"` for every `format: json_schema`
turn: `required` on a call is `['name']` only (`arguments` may be omitted), and
`additionalProperties` is `true` at both levels. Anything stricter turns a harmless extra field or a
missing `arguments` into `InvalidToolInputError`, which the runtime rewrites into its `invalid` tool
and the whole turn is lost. What must stay strict is the tool-name `const` and the inlined parameter
schema. `usage` is reported in the OpenAI shape
(prompt = input + cache read/write, completion = output + reasoning, plus the `*_details` fields)
because the upstream reports it; it stays `null` when it does not, and the contract's "never
fabricated" rule still holds. Non-text content (images) is rejected with 400 before the stream
opens instead of being dropped silently.

**`invalid` is the runtime's trash can, not a tool the model called.** `opencode-ai@1.19.4` ships a
builtin tool literally named `invalid` (description `"Do not use"`) and removes it from the model's
`activeTools`. It only appears through `experimental_repairToolCall`: when the model names a tool
that is not in the table (`NoSuchToolError`) or passes arguments that fail the schema
(`InvalidToolInputError`), the runtime rewrites that call to `tool: "invalid"` and stashes the truth
in `state.input = {tool, error}`. So `part.tool === 'invalid'` means "the model did not speak in the
envelope this time", **not** "the model touched a native tool". The old fence exempted only
`StructuredOutput` and `status: 'error'`, so it flagged `invalid` as native activity and reported the
self-contradictory `native_tool_activity ... tool "invalid"`, killing a turn the runtime would have
retried and corrected. `bridge.ts::findNativeToolActivity` now applies three rules in order: an
envelope short-circuits everything (the runtime retries, and `agent.steps` leaves room for it);
`invalid` never counts as a native tool; only a native tool that actually **executed** with no
envelope is a violation (permission-denied attempts come back `status: 'error'` and do not count).
Genuine `invalid` turns now throw `envelope_violation`, split by source into `unknown_tool_call`
(the model fired an external tool name as a native function - a prompt problem) and
`envelope_schema_mismatch` (right tool, schema too tight). `probe.ts` caches both for 10 minutes
only and `adapters/opencode.ts::resolveTools` deliberately does **not** downgrade the model to
chat-only for them: they describe our prompt and schema, not model capability, and downgrading locks
the model out of tool use for the whole TTL.

**Do not re-add agent-level `tools: {bash: false, …}`.** In `opencode-ai@1.19.4` that key is marked
`@deprecated` in the schema, the agent-config merge loop copies every other field but skips `tools`,
and `ToolRegistry.tools()` does not filter by permission. Only the top-level `config.tools` is
translated (into permission rules), and even that gates execution rather than hiding a tool. Native
tools are therefore held off by `permission` alone - `bash/edit/read/glob/grep/list/webfetch/
websearch/task/todowrite/question/lsp/doom_loop/skill/external_directory` all `deny` - plus the
`/permission` poll that rejects everything, and the model will still *see* them.

Two more facts about that path, both measured on 2026-10-27:

- **Turns can run in parallel.** The runtime supports concurrent sessions (one session per
  request); the service used to serialize them, which multiplied the wait by the client's
  concurrency. Measured: 3 serial turns 10.3s vs 3 parallel turns 2.6s and 4 parallel turns 3.6s,
  all successful. `opencode/concurrency.ts` admits `MAX_CONCURRENT_TURNS = 10` - the client
  (AxAgent) fans out 10 agent nodes per round, so a lower cap just multiplies its wait - and queues
  the rest; the capability probe shares that budget. Only 4 has a measurement behind it; the quota
  was exhausted before 6/8/10 could be measured, so treat 10 as "matched to the client", not
  "verified".
- **The free pool has a quota, and running out of it fails silently.** After roughly twenty-odd
  turns the runtime stops answering, does not report an error on the session API, and only writes
  `level=ERROR ... error.error="AI_APICallError: Free usage limit reached..."` to its own log. The
  bridge watches that log per session id and aborts the request, so the turn fails in ~3s with the
  reason instead of hanging for the 5-minute timeout; the forwarder maps it to 429. A dead runtime
  process must also be replaced, not reused: `ensureStarted()` drops a bridge whose child died and
  starts a new one, otherwise every later request fails with "Failed to create session: HTTP 0".

### IPC Communication
All main-renderer communication uses IPC channels defined in `src/main/ipc/channels.ts`. The naming convention is `domain:action` (e.g., `proxy:start`, `accounts:add`).

### Session Management
`sessionManager.ts` keeps a store-backed session table (with a 60s sweeper). The only thing the
request path consults is `shouldDeleteAfterChat()`, which returns `SessionConfig.deleteAfterTimeout`
- "drop the session after this reply" versus keep it for reuse. There is no `single`/`multi` mode
field and no `parentMessageId` handling in `SessionConfig`.

### Tool Prompt Injection
Tool calling for clients without native support is handled by `src/main/proxy/toolCalling/`
(the engine plus per-client protocol adapters under `protocols/`). Only `opencode` has a
`providerProfiles` entry today; other providers are treated as native-tool providers.
`services/promptInjectionService.ts` and `proxy/prompt/` are not wired into the live request path.

### Session Management Flow
Context continuity travels in the request itself: the forwarder hands the client's message history
to the provider adapter, which maps it onto that provider's conversation primitives.
`sessionManager.ts` keeps the store-backed session table, its 60s sweeper and
`shouldDeleteAfterChat()`; `getOrCreateSession()` and `createSession()` have no callers on
that path.

## Public API Contract

- Auth is fail-closed: once any enabled API key exists, `/v1/*` always requires it
  (`Authorization: Bearer` or `X-API-Key`; `?api_key=` is no longer read, and comparison is a
  constant-time digest compare). With no key configured the server only binds a loopback host
  (`127.0.0.1` / `::1` / `localhost`) and `start()` refuses anything else; CORS `*` is sent only in
  that key-less loopback mode.
- Config writes validate `apiKeys`, `proxyHost`, `enableApiKey`; `/v1/management/proxy/start` and
  `/restart` reject non-loopback hosts with `invalid_host`.
- Errors use OpenAI shapes: 401/403 → `authentication_error`, 429 → `rate_limit_error` plus
  `Retry-After` (and the account is penalised), other 4xx → `invalid_request_error`, 5xx →
  `api_error`. A failure after the stream started is an `data: {"error": ...}` frame, never
  assistant text, and every stream carries exactly one `[DONE]`.
- `usage` is `null` unless the upstream reported real token counts; it is never fabricated.
- Built-in providers silently drop `response_format`, `stream_options`, `logit_bias`, `seed`,
  `max_tokens`, `top_p`, `stop`, `frequency_penalty` and `presence_penalty` in
  `proxy/parameterPolicy.ts`, because OpenAI-compatible clients send them by default and a `400`
  would take the whole client offline; only `n > 1` changes the response shape and still returns
  `400 unsupported_parameter`. Custom and aggregate providers keep passing all of them through.
  No endpoint exposes a token-limit field or a truncation signal, so the proxy never fabricates
  one and can never emit `finish_reason:"length"` on its own.
- A `tool_choice:"required"` / forced call that the model did not make is reported on the
  non-stream response as `X-ModelPort-Tool-Violation: required`, and in streaming mode as an
  additive `x_modelport_tool_violation: "required"` field on the finish chunk (clients that ignore
  it see an unchanged stream).
- Every `/v1/*` response carries `X-Request-Id`; it matches the request log row.
- Response headers that carry dynamic text (the `auto` winner in `X-ModelPort-Route` via
  `utils/headerValue.ts::routeHeaderValue`, `X-ModelPort-Aggregate-Chain`) go through
  `toHeaderValue`. Node validates header values as Latin-1 and throws `ERR_INVALID_CHAR`
  (`Invalid character in header content [...]`) on any character above `0xFF`; eight
  account-channel names contain Chinese (`TRAE (字节)`, `Qoder (中国版)`, …) and custom provider
  names are user-typed, so interpolating them raw turned a successful auto route into
  `500 {"type":"internal_error"}`. ASCII-only values pass through unchanged; anything else is
  percent-encoded per UTF-8 byte (so `decodeURIComponent` restores it, and CR/LF can never
  inject a header).
- `/v1/models` (both the list and the single-model route) carries `context_window` **only when the
  upstream declared one** - the key is omitted otherwise, never `0` and never a guessed default,
  because clients time their own compaction off this number and an over-stated ceiling turns into a
  hard upstream rejection. It is resolved by `store/modelServing.ts::contextWindowOf` from
  `Provider.modelCapabilities`, so it covers exactly what the syncs could prove (builtin sync,
  account-channel sync via the pack's `/v1/models` view). User aliases and the `auto` entry carry
  nothing: `auto` can land on any model, so advertising a window for it would be a lie about a
  number chosen later.
- Tool call ids are `call_<requestId>-<n>`. Managed markup that fails to parse is stripped from
  content while the surrounding text is preserved. The anthropic wire maps upstream `tool_use`
  blocks to native OpenAI `tool_calls`; `opencode` streams go through
  `toolCalling/streamPlanWrapper.ts`.
- `/v1/management/sessions*` is retired and answers 501: there is no server-side session table.

## Data Storage

Application data lives in `~/.modelport/`. The Electron profile directory is pinned to
`<appData>/modelport` by `app.setPath('userData', ...)` in `src/main/index.ts` and must stay pinned:
`safeStorage` seals `store.key` and every credential against that profile, so letting the path follow
`package.json`'s `name` (which is what Electron does by default) makes an existing install unreadable
the moment the package is renamed.

- `data.json` - one electron-store file holding config, providers, accounts, sessions, statistics and
  app logs (there is no separate `providers.json` / `accounts.json`)
- `store.key` - this install's data key, sealed by the OS keystore
- `system-prompts.orphaned.json` - written once by the first start after the prompt library was
  removed: whatever a user had saved is moved here and the `systemPrompts` key is dropped
- `request-logs/` - detailed request logs
- `quota-ledger.json` - aggregate free-quota counters (per provider/account/model, rolling minute
  and 24h windows plus a UTC month) and the caps learned from upstream responses
- `channel-pack/` - the channel pack's own state (its account pool, whatever the upstream pack
  writes under `DSH_CHANNEL_PACK_STATE_DIR`) plus `credentials.json`, which holds the login
  credentials handed to the worker, one encrypted value per account

Credential protection has two layers, both with known limits: the store file is encrypted with a
random per-install key kept as `store.key`, sealed by the OS `safeStorage` (`resolveEncryptionKey()`
in `src/main/store/store.ts`), and individual credentials use `safeStorage` again. If `safeStorage`
is unavailable there is no key to bind to the machine, so the data file is written unencrypted and
only a console warning is logged.

Key migration and its edges: a `data.json` written by a release that still used the compiled-in
`chat2api-fixed-encryption-key-v1` is migrated on first start - read with the legacy key, copied to
`data.json.pre-key-migration.bak`, rewritten under the new key, then verified by comparing the
payload (`src/main/store/keyMigration.ts`). Any failure restores the backup and removes the key file,
so a half-finished migration never replaces real data with an empty store; for the same reason startup
refuses the "corrupted data" recovery path (which moves `data.json` aside) when a key file exists and
the data file predates this run. A missing `data.json` is not treated as a fresh install: startup
looks for `data.corrupted.<ts>.json` / `.pre-key-migration.bak` copies (newest first) and puts the
first readable one back - as-is when it is already under this install's key, re-encrypted when it is
a fixed-key file - so a downgrade-and-upgrade round trip recovers instead of starting empty. Downgrading to a release from before this change cannot read the new
file: it treats it as corrupt and moves it to `data.corrupted.<ts>.json`, so the data is recoverable
but not transparently.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Electron 33+ |
| Frontend | React 18 + TypeScript |
| Styling | Tailwind CSS |
| State | Zustand |
| Build | Vite + electron-vite |
| Server | Koa |

## Coding Guidelines

### Immutability (CRITICAL)
ALWAYS create new objects, NEVER mutate existing ones. Use `update` functions that return new copies.

### Error Handling
Handle errors comprehensively:
- Validate all user input before processing
- Provide user-friendly error messages in UI-facing code
- Log detailed error context on the server side
- Never silently swallow errors

### Input Validation
Validate at system boundaries (user input, external APIs). Use schema-based validation where available.

### Security
- Validate all API keys before use
- Sanitize all user inputs
- Never trust external data (API responses, user input, file content)
- Rotate any exposed secrets immediately

## macOS Development Note

A workaround is applied for V8 JIT compiler crash on macOS ARM64 (Electron 33 bug):
```typescript
app.commandLine.appendSwitch('js-flags', '--jitless --no-opt')
```
This trades some performance for stability.

## Adding a New Provider

### Overview

Adding a new provider requires modifications across 4 layers: Provider Config, OAuth Authentication, Proxy Adapter, and UI. The following guide covers all necessary steps.

### Core File Modification Checklist

#### 1. Provider Config Layer (Required)

| File | Purpose |
|------|---------|
| `src/main/providers/builtin/<provider>.ts` | Provider configuration definition |
| `src/main/providers/builtin/index.ts` | Register in `builtinProviders` array **and** `builtinProviderMap` |

#### 2. OAuth Authentication Layer (Required)

| File | Purpose |
|------|---------|
| `src/main/oauth/adapters/<provider>.ts` | OAuth adapter implementation |
| `src/main/oauth/adapters/index.ts` | Register in `createAdapter()` and `getSupportedAuthMethods()` |
| `src/main/oauth/types.ts` | Add to `MANUAL_TOKEN_CONFIGS` (optional) |

#### 3. Proxy Adapter Layer (Required)

| File | Purpose |
|------|---------|
| `src/main/proxy/adapters/<provider>.ts` | Proxy adapter implementation |
| `src/main/proxy/adapters/<provider>-stream.ts` | Only if you want a separate stream handler file (no shipped provider does; all keep the handler class inside the adapter) |
| `src/main/proxy/adapters/index.ts` | Export adapter |
| `src/main/proxy/forwarder.ts` | Add `forward<Provider>()` method **and** one entry in the `providerForwarders` registry |

#### 4. UI Layer (Required)

| File | Purpose |
|------|---------|
| `src/renderer/src/i18n/locales/zh-CN.json` | Chinese translations |
| `src/renderer/src/i18n/locales/en-US.json` | English translations |
| `src/renderer/src/components/providers/ProviderCard.tsx` | Add icon mapping |
| `src/assets/providers/<provider>.svg` | Provider icon file |

### Step-by-Step Implementation

#### Step 1: Provider Configuration

```typescript
// src/main/providers/builtin/<provider>.ts
import type { BuiltinProviderConfig } from '../../store/types'

export const providerConfig: BuiltinProviderConfig = {
  id: 'provider-id',
  name: 'Provider Name',
  type: 'builtin',
  authType: 'userToken',  // See AuthType section below
  apiEndpoint: 'https://api.example.com',
  chatPath: '/chat/completions',
  headers: {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Origin': 'https://example.com',
    'Referer': 'https://example.com/',
  },
  enabled: true,
  description: 'Provider description',
  supportedModels: ['Model-1', 'Model-2'],
  modelMappings: {
    'Model-1': 'model-1-id',
    'Model-2': 'model-2-id',
  },
  credentialFields: [
    {
      name: 'token',
      label: 'Token',
      type: 'password',
      required: true,
      placeholder: 'Enter token',
      helpText: 'How to get token',
    },
  ],
  tokenCheckEndpoint: '/api/user',    // Optional
  tokenCheckMethod: 'GET',            // Optional
}

export default providerConfig
```

#### Step 2: Register Provider

```typescript
// src/main/providers/builtin/index.ts
import providerConfig from './provider'

export const builtinProviders: BuiltinProviderConfig[] = [
  // ...existing
  providerConfig,
]

export const builtinProviderMap: Record<string, BuiltinProviderConfig> = {
  // ...existing
  'provider-id': providerConfig,
}

export { providerConfig }
```

**CRITICAL**: `builtinProviders` and `builtinProviderMap` in this file are two separate literals and
both must be updated. `src/main/store/types.ts` re-exports them as `BUILTIN_PROVIDERS`, so it needs
no edit.

#### Step 3: OAuth Adapter

```typescript
// src/main/oauth/adapters/<provider>.ts
import axios from 'axios'
import { BaseOAuthAdapter } from './base'
import { OAuthResult, OAuthOptions, TokenValidationResult, AdapterConfig } from '../types'

const API_BASE = 'https://api.example.com'

export class ProviderAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'provider-id',
      authMethods: ['manual'],
      loginUrl: API_BASE,
      apiUrl: API_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    await shell.openExternal(API_BASE)
    return {
      success: false,
      providerId: options.providerId,
      error: 'Please log in via browser and enter Token manually',
    }
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const token = credentials.token
    if (!token) return { valid: false, error: 'Token cannot be empty' }

    try {
      const response = await axios.get(`${API_BASE}/api/user`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
        validateStatus: () => true,
      })

      if (response.status !== 200) {
        return { valid: false, error: 'Token is invalid or expired' }
      }

      return {
        valid: true,
        tokenType: 'access',
        accountInfo: {
          userId: response.data.id,
          email: response.data.email,
          name: response.data.name,
        },
      }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Validation failed' }
    }
  }

  async refreshToken(credentials: Record<string, string>) {
    return null  // Optional
  }
}

export default ProviderAdapter
```

#### Step 4: Register OAuth Adapter

```typescript
// src/main/oauth/adapters/index.ts
export { ProviderAdapter } from './provider'

export function createAdapter(providerType: ProviderType, config: AdapterConfig): BaseOAuthAdapter {
  switch (providerType) {
    // ...existing
    case 'provider-id':
      return new ProviderAdapter(config)
    default:
      throw new Error(`Unsupported provider type: ${providerType}`)
  }
}

export function getSupportedAuthMethods(providerType: ProviderType): string[] {
  switch (providerType) {
    // ...existing
    case 'provider-id':
      return ['manual']
    default:
      return ['manual']
  }
}
```

#### Step 5: Proxy Adapter

```typescript
// src/main/proxy/adapters/<provider>.ts
import axios, { AxiosResponse } from 'axios'
import { Account, Provider } from '../../store/types'

const API_BASE = 'https://api.example.com'

export class ProviderAdapter {
  private provider: Provider
  private account: Account
  private token: string

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    this.token = account.credentials.token || ''
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    sessionId: string
  }> {
    // 1. Get/refresh token
    // 2. Build request
    // 3. Send request
    // 4. Return response
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return true
  }

  static isProviderProvider(provider: Provider): boolean {
    return provider.id === 'provider-id' || provider.apiEndpoint.includes('example.com')
  }
}

export const providerAdapter = { ProviderAdapter }
```

#### Step 6: Stream Handler

```typescript
// src/main/proxy/adapters/<provider>-stream.ts
import { PassThrough } from 'stream'

export class ProviderStreamHandler {
  private model: string
  private sessionId: string
  private isFirstChunk: boolean = true
  private created: number

  constructor(model: string, sessionId: string, onEnd?: () => void) {
    this.model = model
    this.sessionId = sessionId
    this.created = Math.floor(Date.now() / 1000)
  }

  async handleStream(stream: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream> {
    const transStream = new PassThrough()
    
    stream.on('data', (chunk: Buffer) => {
      // Parse SSE data
      // Convert to OpenAI format
      // Write to transStream
    })

    stream.on('end', () => {
      transStream.write('data: [DONE]\n\n')
      transStream.end()
    })

    return transStream
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<any> {
    // Collect all data
    // Return OpenAI format response
  }

  private createChunk(delta: any, finishReason?: string): string {
    return `data: ${JSON.stringify({
      id: this.sessionId,
      model: this.model,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finishReason || null }],
      created: this.created,
    })}\n\n`
  }
}
```

#### Step 7: Register Proxy Adapter

```typescript
// src/main/proxy/adapters/index.ts
export { ProviderAdapter, ProviderStreamHandler, providerAdapter } from './provider'
```

#### Step 8: Add Forwarder Method

```typescript
// src/main/proxy/forwarder.ts
import { ProviderAdapter } from './adapters/provider'
import { ProviderStreamHandler } from './adapters/provider-stream'

// Register the provider in the dispatch table - doForward walks it, there is no if-branch to add:
private readonly providerForwarders: ProviderForwarder[] = [
  // ...existing entries
  {
    name: 'provider-id',
    matches: ProviderAdapter.isProviderProvider,
    forward: (request, account, provider, actualModel, startTime) =>
      this.forwardProvider(request, account, provider, actualModel, startTime),
  },
]

// Add forward method (signature must match the ProviderForwarder forward type):
private async forwardProvider(
  request: ChatCompletionRequest,
  account: Account,
  provider: Provider,
  actualModel: string,
  startTime: number
): Promise<ForwardResult> {
  // Implementation
}
```

#### Step 9: Add UI Translations

```json
// src/renderer/src/i18n/locales/zh-CN.json
{
  "provider-id": {
    "name": "供应商名称",
    "description": "供应商描述",
    "token": "Token",
    "tokenPlaceholder": "请输入 Token",
    "tokenHelp": "从网页版获取 Token",
    "models": {
      "Model-1": "模型 1 描述"
    }
  }
}
```

```json
// src/renderer/src/i18n/locales/en-US.json
{
  "provider-id": {
    "name": "Provider Name",
    "description": "Provider description",
    "token": "Token",
    "tokenPlaceholder": "Enter token",
    "tokenHelp": "Get token from web version",
    "models": {
      "Model-1": "Model 1 description"
    }
  }
}
```

#### Step 10: Add Icon Mapping

```typescript
// src/renderer/src/components/providers/ProviderCard.tsx
import providerIcon from '@/assets/providers/provider.svg'

const providerIcons: Record<string, string> = {
  // ...existing
  'provider-id': providerIcon,
}
```

### AuthType Reference

| Type | Description | Used by | Credential Field |
|------|-------------|-----------|------------------|
| `token` | generic API key | aggregate providers, custom | `apiKey` (aggregate) / `token` (custom) |
| `userToken` | single opaque token | `opencode` (runtime-backed; the local account is credential-less) | `token` |
| `cookie` | cookie bundle | custom cookie-based endpoints | provider-defined |

### Web Search Mode Implementation

Three ways to enable web search:

1. **Model Mapping**: Auto-enable via model name
```typescript
const modelLower = request.model.toLowerCase()
if (modelLower.includes('search')) {
  searchEnabled = true
}
```

2. **Custom Parameter**: Via `web_search` parameter
```typescript
if (request.web_search) {
  searchEnabled = true
}
```

3. **Custom Header**: Via request header
```typescript
if (headers['X-Enable-Search']) {
  searchEnabled = true
}
```

### Thinking Mode Implementation

Three ways to enable thinking mode:

1. **Model Mapping**: Auto-enable via model name
```typescript
const modelLower = request.model.toLowerCase()
if (modelLower.includes('r1') || modelLower.includes('think')) {
  thinkingEnabled = true
}
```

2. **Custom Parameter**: Via `reasoning_effort` parameter
```typescript
if (request.reasoning_effort) {
  thinkingEnabled = true
}
```

3. **Custom Header**: Via request header
```typescript
if (headers['X-Enable-Thinking']) {
  thinkingEnabled = true
}
```

### Thinking Content Handling

In stream handler, output thinking content to `reasoning_content` field:

```typescript
if (path === 'thinking') {
  delta.reasoning_content = processedContent
} else {
  delta.content = processedContent
}
```

### Model List Synchronization

**Single source of truth**: the model list lives only in
`src/main/providers/builtin/<provider>.ts` (`supportedModels`). `src/main/store/types.ts` re-exports
it as `BUILTIN_PROVIDERS`, so there is no second array to keep in sync.

### Testing Checklist

- [ ] Provider displays correctly
- [ ] Account can be added
- [ ] Account validation works
- [ ] Streaming chat works
- [ ] Non-streaming chat works
- [ ] Web search mode works
- [ ] Thinking mode works
- [ ] Model mapping works
- [ ] Multi-turn conversation works
- [ ] Session deletion works

## Updating Provider Configuration

Update **one** place: **`src/main/providers/builtin/<provider>.ts`** (model list, description, help
text, endpoint, headers, credential fields).

`initializeDefaultProviders()` in `src/main/store/store.ts` runs on every startup and, for each
builtin provider, force-overwrites `apiEndpoint`, `chatPath`, `supportedModels`, `modelMappings`,
`headers`, `credentialFields` and `description` in the stored record with the values from code. So:

- changes shipped in code reach the UI only after a restart;
- the same fields edited through the UI are discarded on the next startup (`enabled`, `name`,
  `authType` and stored credentials survive, as do per-model on/off choices kept in
  `userModelOverrides`);
- a builtin provider whose id no longer exists in code is deleted from the store at startup.

Example: to change the `opencode` model list, edit only `src/main/providers/builtin/opencode.ts`.
Aggregate entries are data, not code: edit `src/main/providers/aggregate/registry.ts` (and the
counts asserted in `tests/aggregate/registry.test.ts`).
