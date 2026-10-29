# vendor/channel-pack — 上游免费渠道包的来源与再构建

本目录基于 [Jet（iJetLi）](https://gitee.com/iJetLi) 发布的 MIT 渠道实现
吸收并裁剪的渠道实现，由 `dsh-our-free-model` 的 Host 半身在独立 fiber 上挂载，
提供 LobsterAI、Qoder、Qoder 中国版、TRAE、Cline、Loomy、Raccoon、MiniMax Code、ZCode、Gemini、WorkBuddy、CodeBuddy 十二个账号渠道的
登录流程、账号池、积分领取、模型黑名单与本地 OpenAI 网关可用。OFM 挂载时关闭上游 OpenCode 账号接入，原有匿名免费车道保持独立。
目录名与内部标识符在本插件的再构建中统一改为 channel-pack；出处与许可证不变。

- 上游作者：Jet（https://gitee.com/iJetLi）
- 吸收的提交：`345f0a07b22713c0ae189ca7d8b97ec4f64626c6`（2026-10-06）
- 许可证：MIT（见 `LICENSE`，与上游一致）

## 目录内容

| 路径 | 说明 |
| --- | --- |
| `src/` | 上游 TypeScript 源码，包含下述 OFM 本地适配（便于审计与再构建） |
| `pack.js` | **插件运行时实际加载的代码**：直接由 `src/` 经 `scripts/build-channel-pack.mjs` 打包成单文件（undici 内联，`@deepseek-ai/*` 保持外部），使发布清单不超文件上限 |
| `qoder-auth-wasm.wasm` | Qoder 加密推理所需的 WASM，必须与 `pack.js` 同目录（`pack.js` 按 `import.meta.url` 定位它） |
| `locale/` | 上游文案 |
| `scripts/`、`tsconfig.json`、`package.json` | 再构建所需的元数据（`lib/` 与 `node_modules/` 不入库，按下面步骤重建） |

宿主提供的依赖（`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-credentials`、
`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`）不在此目录，按 Node 解析规则
从安装它的 profile 的 `node_modules` 取；缺少时渠道包整体降级（`/summary.channels`
报告 `state: "failed"` 与原因），免费车道不受影响。

## 再构建

直接从受版本管理的 `src/` 打包，不使用未入库的 `lib/`：

```bash
# 从锁文件安装再构建依赖，不执行生命周期脚本
npm ci --ignore-scripts
# esbuild 放在仓库外，不引入插件运行依赖
npm install --prefix /tmp/ofm-channel-build --no-package-lock --ignore-scripts esbuild@0.25.12
OFM_ESBUILD_DIR=/tmp/ofm-channel-build npm run channel-pack
# qoder-auth-wasm.wasm 沿用上游已有文件，须与 pack.js 同目录
```

## OFM 本地适配

- `src/index.ts`：增加可选 `disableOpencode` 挂载配置；OFM 开启它时跳过重复 OpenCode adapter、默认匿名账号和能力表预热，保留历史账号及凭据。省略时维持上游行为。
- `src/channel-pack-rpc.ts`：追加同一配置，关闭时拒绝 `opencode.*` 与通用 `account.create(provider=opencode)`。
- 打包入口改为 `src/index.ts`；宿主模块仍保持外部，undici 内联。
- 再构建使用 esbuild 0.25.12，undici 8.11.2 沿用根目录锁文件，未借此升级运行依赖。
- `src/credential-expiry.ts` 与 `src/credit-expiry-window.ts` 提供渠道间共享的纯函数。积分临时窗口默认 15 天，可通过 `DSH_CREDIT_EXPIRING_WINDOW_DAYS` 显式设置为非负天数。

## 本地新增：WorkBuddy / CodeBuddy（腾讯）

两者都不在上述 OFM 提交里，是 2026-10-29 从 **OFM v2.5.1**（commit `3df868a`）单独移植的源码。
国际版（WorkBuddy）没有签到接口，每日积分只能在中国版（CodeBuddy）领取，故两个都要注册：

| 文件 | 改动 |
| --- | --- |
| `src/buddy.ts`、`src/product.ts`、`src/buddy-oauth.ts`、`src/buddy-auth.ts`、`src/buddy-adapter.ts`、`src/buddy-balance-rank.ts`、`src/buddy-balance-selector.ts`、`src/openai-gateway/tencent-fingerprint.ts` | 逐字拷贝（快照与校验和见 `docs/upstream/workbuddy-v2.5.1/`） |
| `src/buddy-adapter.ts` | `./llm-adapter.js` 的限流辅助改为 `./rate-limit.js`（本目录没有 `llm-adapter.ts`） |
| `src/buddy-oauth.ts` | 浏览器打开器从动态 `./login.js` 改为本目录既有的 `./open-browser.js` |
| `src/rate-limit.ts` | 补 `isModelSaturationError`（业务码 14003，与额度限流 6004 语义相反） |
| `src/channel-pack-store.ts` | 恢复前缀表补 `BUDDY` / `WORKBUDDY` |
| `src/index.ts` / `src/channel-pack-rpc.ts` | 注册 `workbuddy` 与 `buddy` 的 auth / adapter / 续期 / 两步登录；签到只挂 `buddy`，`workbuddy` 显式返回"国际版不支持签到" |

升级上游时这 9 个文件需重新移植。余额分档（`BuddyBalanceSelector`）已接线：两个产品各一份缓存，按「15 天内到期 / 永久」分档选号，锁定永久积分时不会回落到账号池顺序。

本目录**不含**上游的浏览器半身（`plugin-src/client`）与其设置页——
界面由 `dsh-our-free-model` 自己的三页界面取代，渠道操作经上游的
`/api/channel-pack` RPC 完成（`connection.rpc.call('/api', 'channel-pack', { method, payload })`）。
