# Linear Agent Session 生命周期

## Session 状态流转

```
          ┌───────────┐
          │  pending   │  (session 刚创建)
          └─────┬─────┘
                │ agent 发送第一个 activity
                ▼
          ┌───────────┐
     ┌───>│  active    │<────────────────┐
     │    └──┬──┬──┬──┘                  │
     │       │  │  │                     │
     │       │  │  │  30 分钟无活动       │ agent 发送新 activity 可恢复
     │       │  │  └──────────────┐      │
     │       │  │                 ▼      │
     │       │  │           ┌─────────┐  │
     │       │  │           │  stale  │──┘
     │       │  │           └─────────┘
     │       │  │
     │       │  │ agent 发送 elicitation
     │       │  └──────────────────┐
     │       │                     ▼
     │       │              ┌──────────────┐
     │       │              │ awaitingInput │
     │       │              └──────┬───────┘
     │       │                     │ 用户响应 (prompted event)
     │       └─────────────────────┘
     │       │
     │       │ agent 发送 response
     │       └──────────────┐
     │                      ▼
     │               ┌───────────┐
     │               │ complete  │
     │               └───────────┘
     │       │
     │       │ agent 发送 error
     │       └──────────────┐
     │                      ▼
     │               ┌───────────┐
     │               │   error   │
     │               └───────────┘
     │
     │ 用户在已完成/出错的 session 发消息
     └──────────────────────────────┘
```

## 状态说明

| 状态 | 含义 |
|------|------|
| `pending` | Session 刚创建，等待 agent 响应 |
| `active` | Agent 正在工作中 |
| `awaitingInput` | Agent 发出 elicitation，等待用户输入 |
| `stale` | 30 分钟无 activity，session 变为 stale（可恢复） |
| `complete` | Agent 发送 response，工作完成 |
| `error` | Agent 发送 error，工作异常终止 |

## 关键时间约束

- **10 秒**：收到 `created` webhook 后，必须在 10 秒内发送第一个 `thought` activity，否则 agent 显示为无响应
- **30 分钟**：活动超时时间，超过 30 分钟无 activity 则 session 变为 stale
- **5 秒**：webhook 端点必须在 5 秒内返回 HTTP 200

## 触发 Session 的方式

1. **@mention agent** — 在 issue 或文档中 @mention agent
2. **Delegate issue** — 将 issue 的 delegate 设置为 agent
3. **用户在已有 session 中发消息** — 触发 `prompted` 事件，session 重新激活

## promptContext

Session 创建时，webhook payload 中包含 `promptContext` 字段，提供格式化的上下文信息，包括：
- Issue 的标题、描述、状态
- 相关的标签、项目
- 用户的具体指令

Agent 应利用此上下文来理解任务背景。

## Issue 状态管理

当 agent 被 delegate 处理一个 issue 时：
- 如果 issue 不在 `started`、`completed` 或 `canceled` 状态，应将其移到第一个 `started` 状态
- 查询 team 的 workflow states，筛选 type 为 "started"，选 position 最小的
- 如果当前没有 `Issue.delegate`，agent 应将自己设为 delegate
