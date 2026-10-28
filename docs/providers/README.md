# Provider Adaptation Guides

这些文档记录内置供应商的认证方式、默认模型、适配状态和后续教程入口。更新模型或新增供应商能力时，优先同步对应供应商文档。

经过 1.5 的退役，Web UI 页面接入的八家供应商（deepseek / glm / kimi / mimo / minimax / qwen / qwen-ai / zai）已移除，其旧文档不再适用。

| Provider | 类别 | 文档 |
| --- | --- | --- |
| opencode | 本机运行时（`runtimeModels`） | [OpenCode](opencode.md) |
| 聚合目录 | 73 条渠道（API Key / 免费额度 / 本机） | 数据源为 `src/main/providers/aggregate/registry.ts`，无独立文档 |
| 自定义供应商 | 用户自建 HTTP 端点 | 在应用内的供应商页面直接添加 |

聚合渠道的流程：

1. 在**聚合渠道**页面选择条目，需要 Key 时填入密钥；Base URL 含 `{placeholders}` 的条目（Azure、Vertex）必须先覆盖。
2. 保存后生成 `type: 'aggregate'` 的供应商记录，模型名为 `<providerId>/<modelId>`，并同步写入 `modelMappings`。
3. 该条目声明了 `modelsUrl` 时可在页面触发模型发现，结果写入 `userModelOverrides[providerId].fetchedModels`。
4. Kilo 为免密条目（`authKind: none`），保存时创建空凭据的本地账户，可立即路由；其模型只保留 `isFree` 项。

本机运行时供应商的流程：

1. `src/main/providers/builtin/opencode.ts` 声明 `runtimeModels: true`，端点 `opencode://local` 只是占位，不会被请求。
2. 模型列表来自运行时（`providers/modelListSource.ts` 判定 `runtime` 优先于 `http`）。
3. 状态检查由 `ProviderChecker.checkProviderStatus` 从 `opencodeService.getState()` 回答，不发 HTTP。

用 OpenAI-compatible `/v1/chat/completions` 验证流式、非流式、多轮、工具调用与模型发现。
