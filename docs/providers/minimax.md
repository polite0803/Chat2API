# MiniMax

| 项目 | 说明 |
| --- | --- |
| 供应商 ID | minimax |
| 官网 | https://agent.minimaxi.com |
| API Base | https://agent.minimaxi.com |
| 认证 | JWT Token |
| 凭据字段 | `token`, `realUserID` |

## 默认模型

| 显示名称 | 实际模型 ID |
| --- | --- |
| M3.1-Flash | MiniMax-M3.1-Flash |
| M3 | MiniMax-M3 |

清单取自 `agent.minimax.cn` 的 `/minimax-cloud/api/v1/config?biz_id=3&app_id=3001&client=web`
（2026-10-27 实测：匿名可读，`{base_resp, models:[{model_id, display_name}]}`，两条）。

## 适配状态

已适配：流式对话、非流式对话、多轮会话、账号级清理对话记录、`realUserID+JWTtoken` 组合凭据。

后续验证：官网模型名称升级、MCP/多智能体字段、历史会话删除接口分页。

## 教程

1. 登录 `agent.minimaxi.com`。
2. 从浏览器请求或本地存储中复制 JWT token；如有 `realUserID`，可单独填入。
3. 在供应商管理中添加 MiniMax 账号。
4. 内置模型为官网当日在售的两条；旧的 `MiniMax-M2.7` 只保留映射别名，指向 `MiniMax-M3`，
   方便老配置继续可用。
