# 工具规格定义

## 1. 当前状态

当前 `@openai/codex-sdk` 调用路径没有直接接收 Egg 的 JavaScript tool list。EggTool 由 Egg runtime 自己执行：Codex 先按 prompt 协议输出结构化 tool call JSON，Node 侧执行对应 EggTool，再把工具结果作为下一轮 prompt 继续发回同一个 Codex thread。

`MainAgent` 调用 `CodexRunner.run()` 时传入：

- `prompt`
- `threadId`
- `signal`
- metadata

`CodexRunner` 调用 Codex SDK：

- `startThread()` 或 `resumeThread()`
- `thread.run(prompt)`

因此 Codex SDK 原生可见的是 Codex runtime 自带能力，例如 command execution、file change、web search、MCP tool call。Egg 内部的子 agent tool 和 Linear 内部 tool 不是 Codex SDK 原生 function tool，而是通过结构化 JSON 协议由 Egg runtime 调用并记录到 `SessionTraceStore`。

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

当前实现：

1. `SubAgent` 必须实现 `asTool()`，返回项目内部 `EggTool`。
2. `AgentRegistry.asTools()` / `getTool(name)` 暴露已注册子 agent 的工具形态。
3. `linear` 子 agent 暴露名为 `linear` 的 tool。
4. 该 tool 最终仍调用 `LinearSubAgent.invoke()`；Linear SDK 读写实现在 `src/infra/linear/**`，通过 `LinearSubAgentOptions.tools` 注入给子 agent。

主 agent 基于模型判断后的 tool 调用链路已接入 Direct Chat：

1. MainAgent 使用临时 Codex thread 读取 main prompt、runtime context、`tool-decision` runtime mode 和 `AgentRegistry.asTools()` 的工具描述。
2. Codex 只输出 `answer` 或 `tool` 决策 JSON。
3. 代码按决策调用对应 `EggTool`；这里不做关键词/正则分流。
4. tool 调用结果会通过 `agent_call.completed` SSE 事件立即返回给前端，同时进入最终 Direct Chat prompt，再由 main Codex thread 生成给用户的回复；最终 `done.result.data.toolRun` 也保留本次 tool 结果。

具体 tool-decision 行为规则放在本地 `prompts/main-agent.md`，代码只注入 runtime mode 与工具目录。

thread 边界：

- 决策 run 使用临时 Codex thread，不绑定到 session。
- main Direct Chat 回复使用 `AgentSessionStore` 中绑定的 main `codexThreadId`。
- 子 agent tool 执行时拿到的是 `SubAgentDispatchContext`，不包含 main `codexThreadId`。
- 子 agent 如需 Codex runtime，必须自己启动独立 thread，并且不能复用 main thread。

后续可选演进路径：

1. MCP 暴露：把子 agent 能力暴露为 Codex 可见 MCP tool，让 Codex 在推理过程中真实调用。

长期更符合架构的是 MCP 暴露；当前阶段先用 MainAgent 决策层实现主 agent 自主判断和代码层 tool 执行。

## 3.1 Linear Sub-Agent 内部 Tools

`linear` 子 agent 维护自己的内部工具集，不直接暴露给 main agent。main agent 只看到 `linear` 这个子 agent tool；进入 linear 后才使用这些 Linear 专属工具。

当前已挂载：

- `fetch_linear_issue_overview`: 获取 Linear issue 的标题、描述、状态、负责人、已有 priority/labels，以及后续可调用的分段读取工具。
- `fetch_linear_issue_comments`: 分页读取 Linear issue comments，返回 `items` 和 `pageInfo.nextCursor`。
- `fetch_linear_issue_team_members`: 分页读取 issue 所属 team 的可分配成员。
- `fetch_linear_issue_labels`: 分页读取 issue 所属 team 的可用 labels。
- `fetch_linear_issue_workflow_states`: 分页读取 issue 所属 team 的 workflow states。
- `fetch_trace`: 从 lab.gooo.ai / Langfuse 读取 trace，支持 `tools` 和 `conversation` 两种模式。
- `submit_triage_result`: 提交分诊结果并写回 Linear；稳定挂载在 linear 子 agent 内部，执行时从 task 的 `issueId` / `identifier` 读取完整 issue context，再通过注入的 `LinearIssueWriter` 写回。

边界：

- 这些工具位于 `src/agent/sub/linear/tools/**`。
- 读 Linear issue 的 reader 和写 Linear 的 writer 只能从 `LinearSubAgentOptions.tools` 注入。
- main agent、bridge、adapter 不 import Linear SDK，也不直接调用这些 reader/writer。
- `LinearSubAgent.invoke()` 已接入自己的 Codex thread/tool loop：读取根目录 `prompts/triage.stable.md` 和 `prompts/triage.mutable.md` 并拼接，启动独立子 agent Codex thread，解析 `tool_call` JSON，执行内部 EggTool，再把工具结果发回同一个子 agent thread，直到收到 `final` JSON。
- `triage.stable.md` 保存稳定规则，不允许 agent 修改；`triage.mutable.md` 保存团队职责等可迭代知识，后续明确 prompt 迭代任务只能修改这一部分。
- `linear.codex_run`、`linear.fetch_linear_issue_*`、`linear.fetch_trace`、`linear.submit_triage_result` 和 Codex runtime 工具事件都会写入 session trace。

## 4. Trace

所有 Codex runtime 工具事件都进入后台 trace：

- `command_execution`
- `file_change`
- `web_search`
- `mcp_tool_call`
- `codex_error`

trace 只用于后台展示、审计和排障，不作为上下文源。

主子 agent 调用单独进入 `agentCalls`：

- `parentAgent`: 当前固定为 `main`
- `childAgent`: 例如 `linear`
- `mode`: `main-dispatch` 或 `tool-decision`
- `status`: `started`、`completed`、`failed`、`skipped`、`needs_input`
- `input` / `output` / `error`: 调用入参与子 agent 结果

Admin 后台同时展示 `agentCalls` 和 `toolCalls`，避免把“主调用子 agent”和“Codex runtime 工具事件”混在一起。

## 5. Streaming

Direct chat 的流式入口是 SSE：

- endpoint: `POST /api/direct-chat/messages/stream`
- content type: `text/event-stream`
- final event: `done`
- error event: `error`

事件名复用 Codex normalized event 名称，例如 `thread.started`、`message.delta`、`tool_call`、`turn.completed`；主子 agent 调用额外输出 `agent_call.started`、`agent_call.completed`、`agent_call.failed`。这样 React 前端可以直接用 `fetch()` 读取 `ReadableStream`，后续也可以把同一层封装成 assistant-ui 或 Vercel AI SDK 需要的 transport。
