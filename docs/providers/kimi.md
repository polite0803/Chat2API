# Kimi

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | kimi |
| 官网 | https://www.kimi.com |
| API Base | https://www.kimi.com |
| 认证 | JWT Token |
| 凭据字段 | `token` |

## 默认模型

| 显示名称 | 实际模型 ID | 场景 |
| --- | --- | --- |
| K3 | k3-agent | SCENARIO_OK_COMPUTER |
| K2.8 | k28-agent-preview | SCENARIO_OK_COMPUTER |
| Instant | k2d6-chat | SCENARIO_CHAT |

对话请求本身不带模型 ID，只带场景，所以上表第三列就是发出去的全部区别。

## 适配状态

已适配：Connect JSON 对话接口、流式对话、非流式对话、多轮会话、账号级批量清理对话记录、联网搜索和思考参数。

后续验证：官网 `ChatService` 协议字段、K2 系列场景 ID、批量删除接口的返回格式。

## 教程

1. 登录 `www.kimi.com`。
2. 打开 DevTools -> Application -> Cookies，复制 `kimi-auth` 值，或复制可用 JWT/refresh token。
3. 在供应商管理中添加 Kimi 账号，填入 `token`。
4. 内置模型为官网当日在售的三条（`K3` / `K2.8` / `Instant`，2026-10-27 取自
   `ConfigService/GetAvailableModels`）。旧的 `Kimi-K2.6` 只保留映射别名，指向 `k2d6-chat`，
   方便老配置继续可用；`Kimi-K2.5` 已不再映射。
5. 卡片菜单里的「更新模型」会重新拉这份清单，追加到在线模型里。
