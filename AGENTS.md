# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Chat2API Manager is an Electron desktop application that provides an OpenAI-compatible API proxy for eight built-in AI chat services (DeepSeek, GLM, Kimi, Mimo, MiniMax, Qwen, Qwen AI, Z.ai). It enables using any OpenAI-compatible client with these services across macOS, Windows, and Linux.

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

The only workflow in this repository is `.github/workflows/release.yml`, which runs **only on a tag
push** matching `v*.*.*` / `v*.*.*-*`. Nothing lints, typechecks or tests on push, and
`electron-vite build` transpiles without type checking - a green build says nothing about types.
There is no `npm test` script and no test framework dependency; the suite runs on Node's built-in
test runner:

```bash
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

Two `tests/skills/` files fail on a Windows checkout for environmental
reasons (a child process spawned with a macOS-style `/private/tmp` fixture path, and a `\n`-only regex
against CRLF files).

Packaging constraints worth knowing before a release: macOS produces **dmg only** (no zip), which
breaks `electron-updater` on macOS; no build is code-signed and macOS is not notarized; the
`build.publish` block decides where `--publish=always` uploads and which repo the packaged
auto-update feed points at, so it must match the repository you are releasing from.

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
│   │   │   └── management/ # /v0/management/* HTTP API
│   │   ├── middleware/     # managementAuth
│   │   ├── toolCalling/    # Tool-calling engine + client protocol adapters
│   │   ├── services/       # contextManagementService (history trimming)
│   │   └── sessionManager.ts # Session table + delete-after-chat flag
│   ├── oauth/              # OAuth authentication
│   │   ├── manager.ts      # OAuth flow orchestration
│   │   ├── inAppLogin.ts   # In-app browser login with token auto-extraction
│   │   └── adapters/       # Provider-specific OAuth adapters
│   ├── providers/          # Provider configurations
│   │   ├── builtin/        # Built-in provider configs (one file per provider)
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
   same file (only deepseek keeps a separate `-stream.ts`) and export it from `adapters/index.ts`
5. Add one entry to the `providerForwarders` array in `src/main/proxy/forwarder.ts`
6. Add the UI icon mapping and i18n entries

`src/main/store/types.ts` needs no edit: it re-exports `builtinProviders` as `BUILTIN_PROVIDERS`.

### Online Model List Update
A builtin provider opts in by declaring `modelsFetch` in `src/main/providers/builtin/<provider>.ts`
(`url`, optional `method`/`body`, `reader`, `auth`, extra `headers`).
`src/main/providers/modelCatalog.ts` makes the request; `modelListReaders.ts` turns the payload into
`{ displayName, actualModelId }` pairs and `modelListRequest.ts` builds the request. `{uuid}` inside the
url or a string body value is replaced with a fresh `crypto.randomUUID()` per call, for the providers
that key their list on a client-generated install id (千问国内站's `ut`).

`auth` is a list of rules moving one `account.credentials` field into the request:
`{ from, into: 'header', header, prefix }`, `{ from, into: 'cookie', cookie }`, or
`{ from: 'cookies', into: 'cookie-map' }`. Declaring any rule means an active account is required; an
absent `auth` list means the endpoint answers anonymously. Every rule must resolve - a partial cookie
set is refused locally as `missing_credential_field` (naming the fields, never their values) instead of
going out and coming back as an upstream 401. Rules apply in order, first writer wins, so listing the
`auth` is unused by any shipped provider right now - the one adapter that needed a stored cookie map was Perplexity, and that provider has been removed. A later rule cannot overwrite a cookie or header an earlier rule set.
cookies.

Six readers exist, tried in this order under `reader: 'auto'`: `openai-list` (`data: [{id, name?}]`),
`qwen-double-data` (`data: {data: [...]}`), `kimi-available-models` (`availableModels: [{id, displayName?}]`,
deduped by id), `qwen-cn-model-list` (`data: [{modelCode, displayModelName, show}]`, `show: false` dropped),
`minimax-cloud-config` (`{base_resp, models: [{model_id, display_name}]}`) and `mimo-bot-config`
(`data.modelConfigList`, keeping only `isInPromptNameList === true`).
An unrecognised payload reports `unrecognized_shape` instead of returning an empty list, so an upstream
change never looks like "this provider has no models".

Status of the eight web-chat providers (verified 2026-10-27 by anonymous requests, plus logged-in session
replays): `qwen-ai` (`data:[{id,name}]`) and `kimi` (`availableModels:[{id,displayName}]`, POST)
answer anonymously; `minimax` answers anonymously at
`GET https://agent.minimax.cn/minimax-cloud/api/v1/config?biz_id=3&app_id=3001&client=web` with the
`{base_resp, models:[{model_id, display_name}]}` envelope - note that host is `agent.minimax.cn`, not the
`agent.minimaxi.com` its `apiEndpoint` declares, and the site today lists `MiniMax-M3.1-Flash` and
`MiniMax-M3` while the shipped list still says `MiniMax-M2.7`; `zai` returns `{data:[{id,name}]}` for
`GET /api/models` with an account JWT (403 without a token, 401 with a bad one); `qwen` (千问国内站)
answers anonymously at `chat2-api.qianwen.com` - a different host from its `apiEndpoint` - with the
`{code,msg,success,data:[{modelCode,displayModelName,show}]}` envelope; `mimo` answers anonymously at
`GET https://aistudio.xiaomimimo.com/open-apis/bot/config` with
`{code,msg,data:{modelConfigList:[{model,name,isInPromptNameList}]}}` - that array carries ~15 entries whose
`name` values collide (four share `mimo-omni`) because most are internal or retired, so the reader keeps
only `isInPromptNameList === true`, which is exactly the three the site offers today
(`MiMo-V2.6-Flash`, `MiMo-V2.6-Pro`, `MiMo-V2.6-Pro-UltraSpeed`) and is also what stops two models landing
on one display name.
Not declared, with the reading behind each: **deepseek has no list to sync** - its UI exposes only the
thinking/search switches, and `client/settings?scope=model` (also `main`, `provider`) returns
`biz_code:1 SETTINGS_NOT_FOUND` even with the site's own registered `did` replayed inside a logged-in
session, so there is nothing to fetch rather than a fetch we are blocked from; **glm does have a list
endpoint, but a plain HTTP client cannot reach it** -
`GET https://chatglm.cn/chatglm/agent-api/operation/detail?tag=available_models` replies
`{status, message, result:{default:{agent,am,guest,non_vip,svip,vip}, models:[{selected_model, display_name,
chat_switch, am_switch, description, am_description, display_tag, reasoning_efforts:[{am_effort, display_name,
description, effort}]}]}, rid}`, read live through the site's own `Home/GetAvailableModels` action, and the
current list is `glm-5.3` + `glm-5.3-flash` - the two codes `builtin/glm.ts` already maps. The result is
persisted to `localStorage.vuex → Home.models`, which is why opening its model switcher makes no network call
and why an earlier pass of this document wrongly called those options a bundled constant. What blocks wiring
it is the request contract, not login: every call carries a per-request signature (`X-Timestamp`, `X-Nonce`,
`X-Sign` = `md5("<obfuscated ms>-<uuid v4 without dashes>-<salt inlined in main.*.js>")`) plus `App-Name`,
`X-Device-Id` (localStorage `chatglm-deid`), `X-Request-Id` and the `X-App-*` set, and the whole origin sits
behind a RiverSecurity-style WAF (`ssxmod_itna`/`ssxmod_itna2` cookies, `_waf_*` storage). Unsigned requests
fail the same way with logged-in cookies and without them (`400`, `status 40001`), and a request signed from
this machine with the reconstructed formula also fails (`400`, `status 40003`), so the gate is bot detection
rather than authentication: a static `modelsFetch` rule cannot satisfy it, and a bespoke signer would be
guessing a salt that the site can rotate at any build. GLM therefore keeps `supportsModelFetch` off, shows the
"does not support dynamic model updates" line, and its drift is fixed by editing `builtin/glm.ts` with the
codes read from a real chat request body.
**perplexity was removed as a provider on 2026-10-27** - its site could not be reached from the
development machine at all (connection failure, no model list call observed), so nothing about its
list could be verified and the config shipped a single placeholder model named `Auto`.

Fetched models are stored in `userModelOverrides[providerId].fetchedModels` (+ `fetchedAt`), **not** in
`provider.supportedModels` - the startup sync rewrites that field from code. They merge into
`getEffectiveModels()` as `source: 'fetched'`, after built-in and user-added entries, skipping names
that already exist or are excluded, and `providers:resetModels` clears them along with the rest of the
overrides.

The action is the single `providers:updateModels` channel. The card menu renders it only when the stored
provider record carries `supportsModelFetch`, which startup derives from the shipped config. Failures
return a typed `reason` (`unsupported`, `no_active_account`, `http_status`, `empty`,
`unrecognized_shape`, `network_error`), each with its own message in the UI.

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
(the engine plus per-client protocol adapters under `protocols/`) and, for the Qwen and Z.ai
adapters, by `src/main/proxy/promptToolUse.ts`. `services/promptInjectionService.ts` and
`proxy/prompt/` are not wired into the live request path.

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
- Config writes validate `apiKeys`, `proxyHost`, `enableApiKey`; `/v0/management/proxy/start` and
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
  `400 unsupported_parameter`. Custom providers keep passing all of them through. None of the web
  upstreams exposes a token-limit field or a truncation signal, so the proxy never forwards
  `max_tokens` and can never emit `finish_reason:"length"`.
- qwen-ai only accepts a single user message per request, so its adapter renders the whole
  conversation (including assistant and tool turns) into one transcript via
  `utils/transcript.ts`; zai already sends the full `messages` array.
- A `tool_choice:"required"` / forced call that the model did not make is reported on the
  non-stream response as `X-Chat2API-Tool-Violation: required`, and in streaming mode as an
  additive `x_chat2api_tool_violation: "required"` field on the finish chunk (clients that ignore
  it see an unchanged stream).
- Every `/v1/*` response carries `X-Request-Id`; it matches the request log row.
- Tool call ids are `call_<requestId>-<n>`. Managed markup that fails to parse is stripped from
  content while the surrounding text is preserved; qwen-ai / zai / minimax streams are post-processed
  by `toolCalling/streamPlanWrapper.ts` so plan-less stream handlers can still emit `tool_calls`.
- `/v0/management/sessions*` is retired and answers 501: there is no server-side session table.

## Data Storage

Application data lives in `~/.chat2api/`:
- `data.json` - one electron-store file holding config, providers, accounts, sessions, statistics and
  app logs (there is no separate `providers.json` / `accounts.json`)
- `store.key` - this install's data key, sealed by the OS keystore
- `system-prompts.orphaned.json` - written once by the first start after the prompt library was
  removed: whatever a user had saved is moved here and the `systemPrompts` key is dropped
- `request-logs/` - detailed request logs

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
| `src/main/proxy/adapters/<provider>-stream.ts` | Only if you want a separate stream handler file (only deepseek does; the rest keep the handler class inside the adapter) |
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

| Type | Description | Providers | Credential Field |
|------|-------------|-----------|------------------|
| `userToken` | User Token | DeepSeek | `token` |
| `jwt` | JWT Token | Kimi, MiniMax, Qwen AI, Z.ai | `token` |
| `refresh_token` | Refresh Token | GLM | `refresh_token` |
| `tongyi_sso_ticket` | SSO Ticket | Qwen | `ticket` |
| `cookie` | Cookie Auth | Mimo (three cookie fields) | `service_token`, `user_id`, `ph_token` |

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

Example: to change the Z.ai model list, edit only `src/main/providers/builtin/zai.ts`:
```typescript
supportedModels: ['GLM-5.1', 'GLM-5-Turbo', 'GLM-5V-Turbo', ...]
```
