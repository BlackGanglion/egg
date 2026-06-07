# Egg — V2 核心架构

## 1. 目标形态

Egg 采用“一个主 agent + N 个子 agent”的结构。所有外部入口只调用主 agent，主 agent 先判断任务是否需要领域能力；不需要时直接调用 Codex runtime 回答，需要时再把对应子 agent 当作 tool 调用。子 agent 负责具体业务边界。

```
External trigger
  |
  +--> integration/* bridge
          |
          v
      MainAgent.dispatch(task)
          |
          +--> direct answer via CodexRunner
          |
          +--> AgentRegistry
                 |
                 +--> linear sub-agent
                 +--> future sub-agents
```

## 2. 目录结构

```
prompts/
└── main-agent.md                  # MainAgent prompt
src/
├── agent/
│   ├── types.ts                    # AgentTask / AgentResult / SubAgent / dispatch context
│   ├── registry.ts                 # 子 agent 注册与 capability 查找
│   ├── main/
│   │   └── index.ts                # 唯一主 agent 入口 dispatch()
│   ├── runtime/
│   │   ├── codex-runner.ts         # Codex SDK 适配层，统一 thread/run/tool 事件
│   │   └── run-coordinator.ts      # 多 session 并发、同 session 串行、取消
│   ├── session/
│   │   ├── session-store.ts        # ExternalSessionRef -> agentSessionId -> codexThreadId
│   │   └── session-trace-store.ts  # 后台展示用消息与工具调用投影
│   ├── sub/
│   │   └── linear/
│   │       ├── index.ts            # Linear owning sub-agent
│   │       └── workspace/
│   │           ├── prompts/
│   │           │   └── triage.md
│   │           ├── evals/
│   │           └── notes/
│   └── tool/
│       ├── types.ts                # EggTool 项目内工具接口
│       └── schema.ts               # 工具 schema 适配入口
├── integration/
│   ├── linear-agent/
│   │   ├── bridge.ts               # Linear envelope -> AgentTask
│   │   └── types.ts
│   └── direct-chat/
│       └── bridge.ts               # Chat message -> AgentTask
├── infra/
│   └── linear/                     # 后续恢复 OAuth/Webhook/API 封装
├── routes/
│   ├── admin.ts                    # session/trace/toolCalls 管理后台 API
│   ├── direct-chat.ts              # Direct chat session/message API
│   ├── health.ts
│   └── ui.ts                       # React/Vite 构建产物托管
├── utils/
│   ├── config.ts
│   └── logger.ts
└── web/
    ├── index.html
    └── src/
        ├── views/chat-view.tsx     # Direct chat 前端，消费 SSE
        ├── views/admin-view.tsx    # session/trace/toolCalls 管理后台
        ├── api.ts
        └── sse.ts

```

## 3. 核心边界

- `MainAgent` 是唯一 agent 入口，负责路由和编排，不直接读写 Linear。
- `MainAgent` 的 prompt 存放在 `prompts/main-agent.md`，代码只负责读取并拼接运行时上下文。
- `MainAgent` 自己处理普通 direct chat；只有判断需要领域能力时，才通过 `AgentRegistry` 调用子 agent。
- `AgentRegistry` 只管理真正的领域子 agent 注册和 capability 匹配。
- `linear` 子 agent 是 Linear owning sub-agent，后续所有 Linear issue/session 读取和写回都收敛到这里。
- `integration/linear-agent` 只把 Linear event envelope 转成通用 `AgentTask`，不读写 Linear 业务数据。
- `AgentSessionStore` 维护 `ExternalSessionRef -> agentSessionId -> codexThreadId`；上下文恢复依赖 Codex thread，不依赖 Egg 自己拼历史消息。
- `SessionTraceStore` 按 `agentSessionId` 记录后台展示用投影，包括消息、工具调用和 usage；它不是上下文源，不喂回 Codex。
- 每个 session 独立目录存储 `session.json` 和 `trace.json`；不保留旧 `context.json` 兼容。
- `RunCoordinator` 管理并发和取消：不同 session 可并发，同一 session 串行。
- `CodexRunner` 是 Codex SDK 的唯一封装点，业务层只看到 `threadId`、最终回复、usage 和工具事件。

## 4. 当前骨架状态

- 已建立 V2 task/result/session/tool/sub-agent 合同。
- 已将 MainAgent prompt 外置到 `prompts/main-agent.md`。
- 已建立 `linear` 子 agent workspace，并将 triage prompt 放入 `src/agent/sub/linear/workspace/prompts/triage.md`。
- 已建立 Linear bridge 和 direct chat bridge。
- 已建立 Direct chat 链路：`/api/direct-chat/sessions` 新建 session，`/api/direct-chat/messages` 进入主 agent；普通聊天由主 agent 直接调用 Codex runtime。
- 已建立 Direct chat 流式链路：`/api/direct-chat/messages/stream` 通过 SSE 输出 Codex runtime 事件和 `message.delta`。
- 已建立 React/Vite 前端：`/chat` 可发起 direct chat、新建 session 并消费 SSE；`/admin` 可查看 session 来源、trace 投影和工具调用，支持删除 session。
- session/trace 已改为按 session 文件夹落盘：`.data/sessions/<agentSessionId>/session.json` 与 `trace.json`。
- 已引入 `@assistant-ui/react` 作为后续 chat UI/runtime adapter 候选；当前 UI 直接消费 Egg 自定义 SSE 协议。
- 已建立 lightweight `bootstrap.ts`，用于启动 V2 skeleton 和手动 dispatch。
- V1 legacy 实现、旧测试和批量 triage 脚本已删除。

## 5. 下一步

1. 按新边界重新实现 Linear OAuth、Webhook、LinearApiClient。
2. 将 Linear issue/session 的读取与写回实现到 `src/agent/sub/linear`。
3. 用 `RunCoordinator` 接管 issue triage 和 AgentSession 的并发与取消。
4. 为 `@assistant-ui/react` 补 Egg SSE runtime adapter，替换当前本地 chat view 实现。
