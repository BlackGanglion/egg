# Linear Agent Signals

Signals 是附加在 Agent Activity 上的可选元数据，用于修改 activity 的解释和处理方式。Agent 和用户都可以在 activity 上附加 signal。

## Human → Agent Signals

### `stop` Signal

用户通过 Linear UI 的 "Send stop request" 下拉选项发送。

收到 `stop` signal 后，agent **必须**：
1. 立即停止所有操作（不再执行代码变更、API 调用等）
2. 发送一个 `response` 或 `error` activity 确认已停止，并说明当前状态

## Agent → Human Signals

通过 activity 的 `signal` 和 `signalMetadata` 字段发送。

### `auth` Signal

用于 `elicitation` 类型的 activity，表示 agent 需要用户完成第三方账户认证。

Linear 会渲染临时 UI 展示认证链接。用户完成认证后，agent 用 `thought` activity 继续工作。

```javascript
{
  agentSessionId: "...",
  content: {
    type: "elicitation",
    body: "请先完成认证以继续"
  },
  signal: "auth",
  signalMetadata: {
    url: "https://auth.example.com/oauth",
    userId: "...",
    providerName: "MyService"
  }
}
```

### `select` Signal

用于 `elicitation` 类型的 activity，向用户展示选项列表。

用户可以选择一个选项，也可以输入自由文本（此时 elicitation 被取消）。选中的选项以普通 `prompt` activity 发送回来。

```javascript
{
  agentSessionId: "...",
  content: {
    type: "elicitation",
    body: "你指的是 monorepo 中的哪个包？"
  },
  signal: "select",
  signalMetadata: {
    options: [
      { label: "frontend", value: "src/packages/frontend" },
      { label: "backend", value: "src/packages/backend" }
    ]
  }
}
```
