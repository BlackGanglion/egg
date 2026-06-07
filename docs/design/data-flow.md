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
        | 普通聊天不进入子 agent
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
```

关键点：
- Codex thread 是上下文源。
- Egg 只保存 `agentSessionId -> codexThreadId`。
- `trace.json` 只用于后台展示和审计，不喂回 Codex。
- 同一个 conversation 通过 `RunCoordinator` 串行执行。

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

event: turn.completed
data: {"type":"codex","event":{"type":"turn.completed","usage":{...}}}

event: done
data: {"channel":"web","conversationId":"...","messageId":"...","result":{...}}
```

旧的 `POST /api/direct-chat/messages` 保留为非流式 JSON 入口。
React/Vite 前端当前直接消费该 SSE 协议；`@assistant-ui/react` 已作为后续 runtime adapter 候选依赖接入。

## 2. Admin

```
GET /api/admin/sessions
        |
        +--> AgentSessionStore.list()
        +--> SessionTraceStore.list()
        |
        v
session source / messageCount / toolCallCount

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

React/Vite 管理后台通过这些 API 展示 session 来源、trace 消息、工具调用，并发起删除。

## 3. Linear Bridge

Linear 入口目前是新架构骨架：

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
        v
LinearSubAgent
```

下一步需要在 `src/infra/linear` 重新实现 OAuth、Webhook、Linear API client，并把 Linear 读写收敛到 `LinearSubAgent`。

## 4. 并发

- 不同 session 可并发。
- 同一 direct-chat conversation 串行。
- 同一 Linear issue/session 后续也应按各自 run key 串行。
- 全局并发由 `CODEX_MAX_CONCURRENT_RUNS` 控制。
