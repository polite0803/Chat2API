# DeepSeek

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | deepseek |
| 官网 | https://chat.deepseek.com |
| API Base | https://chat.deepseek.com/api |
| 认证 | User Token |
| 凭据字段 | `token` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| deepseek-default | default |
| deepseek-expert | expert |
| deepseek-vision | vision |

## 适配状态

已适配：流式对话、非流式对话、多轮会话、账号级清理对话记录、Web 搜索/思考模式别名、托管工具调用提示注入。

后续验证：官网请求头版本、搜索和思考参数、会话删除接口在官网升级后的兼容性。

模型名于 2026-10-27 对齐官网现名：官网 `client/settings?scope=model` 与模型切换器均已不再提供 `deepseek-v4-flash` / `deepseek-v4-pro`，
改为三条“模式”（站点缓存 `__ds_remote_feature_store_model.entries.model_configs` 实测读数）：
`default`=快速模式（`enabled:true`、`switchable:true`、默认）、`expert`=专家模式（`enabled:false`）、`vision`=识图模式（`enabled:false`）。
本供应商仍把三条都列进清单，因此打 `deepseek-expert` / `deepseek-vision` 目前会拿到上游错误，需等官网重新启用。
上游请求体不含模型名，只有 `model_type`，由 `resolveDeepSeekChatOptions` 按名字里是否含 `expert` / `vision` 决定；旧名 `deepseek-v4-*` 及其 `-think` / `-search` 别名已列入退役名单，启动时会从用户自定义映射与覆盖里清除，需要保留旧客户端名的请在全局模型映射里自行添加。

## 教程

1. 登录 `chat.deepseek.com`。
2. 打开 DevTools -> Application -> Local Storage，复制用户 token。
3. 在 Chat2API Manager 的供应商管理中添加 DeepSeek 账号，填入 `token`。
4. 在模型管理中保留默认模型；如需搜索/思考别名，使用全局模型映射指向默认模型。
