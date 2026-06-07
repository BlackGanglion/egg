# 工具规格定义

## 1. 当前状态

当前 `@openai/codex-sdk` 调用路径没有直接接收 Egg 的 JavaScript tool list。

`MainAgent` 调用 `CodexRunner.run()` 时传入：

- `prompt`
- `threadId`
- `signal`
- metadata

`CodexRunner` 调用 Codex SDK：

- `startThread()` 或 `resumeThread()`
- `thread.run(prompt)`

因此 Codex 当前可见的是 Codex runtime 自带能力，例如 command execution、file change、web search、MCP tool call。Egg 只从 `turn.items` 中提取这些事件并写入 `SessionTraceStore`。

## 2. EggTool

项目内保留轻量工具合同：

```typescript
export interface EggTool<TParams = unknown, TResult = EggToolResult> {
  name: string;
  description: string;
  parameters: unknown;
  execute(params: TParams, context: ToolExecutionContext): Promise<TResult>;
}
```

这个接口是项目内部工具抽象，不等于 Codex SDK 已经能直接调用这些工具。

## 3. 子 Agent 作为 Tool

目标形态：

- 子 agent 表示领域能力。
- 主 agent 在需要领域能力时，把子 agent 当 tool 调用。
- Linear 能力应收敛为 `linear.*` 工具/子 agent 能力。

可选实现路径：

1. MainAgent 代码层路由：主 agent 自己判断 task 类型并调用 `SubAgent.invoke()`。
2. MCP 暴露：把子 agent 能力暴露为 Codex 可见 MCP tool，让 Codex 在推理过程中真实调用。

长期更符合架构的是第 2 种；否则“子 agent 是 tool”只发生在代码 dispatch 层，不发生在 Codex 推理层。

## 4. Trace

所有 Codex runtime 工具事件都进入后台 trace：

- `command_execution`
- `file_change`
- `web_search`
- `mcp_tool_call`
- `codex_error`

trace 只用于后台展示、审计和排障，不作为上下文源。

## 5. Streaming

Direct chat 的流式入口是 SSE：

- endpoint: `POST /api/direct-chat/messages/stream`
- content type: `text/event-stream`
- final event: `done`
- error event: `error`

事件名直接复用 Codex normalized event 名称，例如 `thread.started`、`message.delta`、`tool_call`、`turn.completed`。这样 React 前端可以直接用 `fetch()` 读取 `ReadableStream`，后续也可以把同一层封装成 assistant-ui 或 Vercel AI SDK 需要的 transport。
