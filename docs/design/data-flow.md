# 数据流设计

## 1. Direct Chat

```
React chat UI / API client
        |
        v
POST /api/direct-chat/messages or /api/direct-chat/messages/stream
        |
        v
DirectChatBridge
        |
        | 1. ExternalSessionRef(source=direct-chat)
        | 2. AgentSessionStore.getOrCreate()
        | 3. RunCoordinator.enqueue(conversation)
        v
MainAgent.dispatch(direct-chat.message)
        |
        | 1. temporary Codex thread decides answer/tool
        | 2. if tool: execute sub-agent tool without main codexThreadId
        | 3. main Codex thread generates final answer
        v
CodexRunner.run()
        |
        | startThread() or resumeThread(codexThreadId)
        | thread.run(prompt) or thread.runStreamed(prompt)
        v
Codex runtime
        |
        v
AgentResult + ChatWriteCommand
        |
        v
SessionTraceStore 写入后台 trace 投影
        |
        +--> messages
        +--> agentCalls: main -> sub-agent
        +--> toolCalls
```

关键点：
- Codex thread 是上下文源。
- Egg 只保存 direct-chat 的 `agentSessionId -> main codexThreadId`。
- `trace.json` 只用于后台展示和审计，不喂回 Codex。
- `agentCalls` 记录主 agent 调用子 agent 的链路；`toolCalls` 记录 Codex runtime 和 Egg tool 事件。
- 同一个 conversation 通过 `RunCoordinator` 串行执行。
- 子 agent 已可通过 `AgentRegistry.asTools()` 暴露为工具；Direct Chat 不做关键词/正则分流，是否调用 `linear` tool 由 MainAgent 的 Codex 决策 run 决定。
- 子 agent 不共享 main Codex thread；subagent context 中没有 `codexThreadId`，后续子 agent 自己调用 Codex 时必须重新 start thread。

### 1.1 流式协议

`POST /api/direct-chat/messages/stream` 使用 SSE：

```
event: session
data: {"channel":"web","conversationId":"...","messageId":"..."}

event: thread.started
data: {"type":"codex","event":{"type":"thread.started","threadId":"..."}}

event: message.delta
data: {"type":"codex","event":{"type":"message.delta","delta":"...","text":"..."}}

event: tool_call
data: {"type":"codex","event":{"type":"tool_call","toolCall":{...}}}

event: agent_call.started
data: {"type":"agent_call.started","call":{"parentAgent":"main","childAgent":"linear","status":"started",...}}

event: agent_call.completed
data: {"type":"agent_call.completed","call":{"parentAgent":"main","childAgent":"linear","status":"completed","output":{...}}}

event: turn.completed
data: {"type":"codex","event":{"type":"turn.completed","usage":{...}}}

event: done
data: {"channel":"web","conversationId":"...","messageId":"...","result":{...}}
```

旧的 `POST /api/direct-chat/messages` 保留为非流式 JSON 入口。
`tool_call` 表示 Codex runtime / Egg tool 事件；`agent_call.*` 表示 MainAgent 调用子 agent 的生命周期，`completed` 事件会携带子 agent tool result。React/Vite 前端当前直接消费该 SSE 协议；`@assistant-ui/react` 已作为后续 runtime adapter 候选依赖接入。

## 2. Admin

```
GET /api/admin/sessions
        |
        +--> AgentSessionStore.list()
        +--> SessionTraceStore.list()
        |
        v
session source / messageCount / toolCallCount
        + agentCallCount

GET /api/admin/sessions/:agentSessionId
        |
        +--> AgentSessionStore.findByAgentSessionId()
        +--> SessionTraceStore.get()
        |
        v
session + trace

DELETE /api/admin/sessions/:agentSessionId
        |
        +--> SessionTraceStore.delete()
        +--> AgentSessionStore.deleteByAgentSessionId()
```

React/Vite 管理后台通过这些 API 展示 session 来源、trace 消息、主子 agent 调用和工具调用，并发起删除；详情页把主子 agent 调用放在 Agent Calls 区块，把 Codex/runtime 工具事件放在 Tool Calls 区块。

## 3. Linear Transport

Linear webhook / AgentSession 入口目前是新架构骨架。外部 Linear 事件只进入 bridge 做 envelope -> task 转换，然后统一调用 `MainAgent.dispatch()`；bridge 不直接调用任何子 agent。

```
Linear envelope
        |
        v
LinearAgentBridge
        |
        | envelope -> AgentTask
        v
MainAgent.dispatch()
        |
        | main agent decides and dispatches
        |
        | strip main codexThreadId
        |
        v
LinearSubAgent
        |
        | 1. load root prompts/triage.stable.md + triage.mutable.md
        | 2. start independent sub-agent Codex thread
        | 3. parse tool_call JSON from Codex output
        | 4. execute internal Linear EggTool
        | 5. feed tool result back to the same sub-agent thread
        v
AgentResult + subAgentCodexThreadId
```

当前 `LinearSubAgent` 已接入自己的 Codex thread/tool loop，并通过注入的 reader/writer 读取 issue/team/member/label/workflow state/comment 上下文、写回 issue update 与 comment；reader/writer 的真实 SDK 实现在 `src/infra/linear/linear-api-client.ts`。对外入口仍只到 main agent，Linear subagent 只接受 main agent 的分发或 tool 调用。

## 4. 并发

- 不同 session 可并发。
- 同一 direct-chat conversation 串行。
- 同一 Linear issue/session 后续也应按各自 run key 串行。
- 全局并发由 `CODEX_MAX_CONCURRENT_RUNS` 控制。
