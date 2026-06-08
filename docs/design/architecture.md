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
          +--> direct answer via main Codex thread
          |
          +--> model tool decision via temporary Codex thread
                 |
                 +--> AgentRegistry tool
                        |
                        +--> linear sub-agent own Codex thread + internal tool loop
                        +--> future sub-agent own Codex thread
```

## 2. 目录结构

```
prompts/
├── main-agent.md                  # MainAgent prompt
├── triage.stable.md               # Linear stable triage rules
└── triage.mutable.md              # Linear mutable routing knowledge
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
│   │   ├── session-store.ts        # ExternalSessionRef -> agentSessionId -> main codexThreadId
│   │   └── session-trace-store.ts  # 后台展示用消息、主子调用与工具调用投影
│   ├── sub/
│   │   └── linear/
│   │       ├── index.ts            # Linear owning sub-agent
│   │       ├── tools/              # Linear-only tools
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
│   ├── admin.ts                    # session/trace/agentCalls/toolCalls 管理后台 API
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
        ├── views/admin-view.tsx    # session/trace/agentCalls/toolCalls 管理后台
        ├── api.ts
        └── sse.ts

```

## 3. 核心边界

- `MainAgent` 是唯一 agent 入口，负责路由和编排，不直接读写 Linear。
- prompt 统一存放在根目录 `prompts/`；`MainAgent` 读取 `prompts/main-agent.md`，`linear` 子 agent 读取 `prompts/triage.stable.md` + `prompts/triage.mutable.md`。
- `MainAgent` 自己处理普通 direct chat；需要领域能力时，由主 agent 决定是否调用 `AgentRegistry` 暴露的子 agent tool。
- `AgentRegistry` 只管理真正的领域子 agent 注册和 capability 匹配。
- `linear` 子 agent 是 Linear owning sub-agent，所有 Linear issue/session 读取和写回都收敛到这里；主 agent、bridge 和其他子 agent 不直接读写 Linear。
- 应用托管的 `CodexRunner` 使用独立 `CODEX_HOME`。启动时从用户 Codex 配置生成 `.data/codex-home/config.toml`，只保留 `CODEX_ALLOWED_PLUGINS` 白名单中的插件配置；默认白名单为空，因此 main/sub-agent 的 Codex thread 不会看到 Linear、GitHub、Figma、Gmail、Browser 等 Codex 插件。
- `integration/linear-agent` 只把 Linear event envelope 转成通用 `AgentTask` 并调用 `MainAgent.dispatch()`；它不读写 Linear 业务数据，也不直接选择或调用子 agent。
- `AgentSessionStore` 维护 `ExternalSessionRef -> agentSessionId -> main codexThreadId`；direct chat 上下文恢复依赖 main Codex thread，不依赖 Egg 自己拼历史消息。
- 子 agent 不能复用 main agent 的 `codexThreadId`；进入 `SubAgent.invoke()` 前必须剥离 main thread，子 agent 如需 Codex runtime 必须自己启动独立 thread。
- `SessionTraceStore` 按 `agentSessionId` 记录后台展示用投影，包括消息、主子 agent 调用、工具调用和 usage；它不是上下文源，不喂回 Codex。
- 每个 session 独立目录存储 `session.json` 和 `trace.json`；不保留旧 `context.json` 兼容。
- `RunCoordinator` 管理并发和取消：不同 session 可并发，同一 session 串行。
- `CodexRunner` 是 Codex SDK 的唯一封装点，业务层只看到 `threadId`、最终回复、usage 和工具事件。

## 4. 当前骨架状态

- 已建立 V2 task/result/session/tool/sub-agent 合同。
- 已将 MainAgent prompt 外置到 `prompts/main-agent.md`。
- 已将 `prompts/triage.md` 拆成 `prompts/triage.stable.md` 与 `prompts/triage.mutable.md` 两部分：稳定规则不可由 agent 修改，团队职责等可迭代信息放在 mutable 文件。
- 已将子 agent 暴露为项目内 `EggTool`；Direct Chat 先由 MainAgent 的 Codex 决策 run 选择是否调用 `linear` tool，再由代码执行对应子 agent tool。
- 已建立 Linear bridge 和 direct chat bridge。
- 已建立 Direct chat 链路：`/api/direct-chat/sessions` 新建 session，`/api/direct-chat/messages` 进入主 agent；普通聊天由主 agent 直接调用 Codex runtime。
- 已建立 Direct chat 流式链路：`/api/direct-chat/messages/stream` 通过 SSE 输出 Codex runtime 事件和 `message.delta`。
- 已建立 React/Vite 前端：`/chat` 可发起 direct chat、新建 session 并消费 SSE；`/admin` 可查看 session 来源、trace 投影、主子 agent 调用和工具调用，支持删除 session。
- 已在 `trace.json` 中记录 `agentCalls`，Admin 后台可查看 `main -> linear` 等主子 agent 调用链。
- 已为 `linear` 子 agent 挂载旧分诊链路的内部工具：`fetch_trace`、`submit_triage_result`。
- 已接入 `linear` 子 agent 自己的 Codex 执行链路：子 agent 读取根目录 stable + mutable prompt，独立 start/resume 自己的 Codex thread，通过结构化 `tool_call` JSON 驱动内部 EggTool，再把工具结果喂回同一个子 agent thread。
- `linear` 子 agent 的 Codex run、内部工具调用和 Codex runtime 工具事件都会写入 `SessionTraceStore.toolCalls`，并保留 `subAgentCodexThreadId`；该 thread 不绑定为 main Direct Chat thread。
- 已在应用托管的 Codex SDK runtime 中启用独立 `CODEX_HOME` 和插件白名单；默认不加载任何 Codex 插件，Linear 读取和写回只能通过 `linear` 子 agent 注入的 reader/writer 与内部 EggTool 完成。
- session/trace 已改为按 session 文件夹落盘：`.data/sessions/<agentSessionId>/session.json` 与 `trace.json`。
- 已引入 `@assistant-ui/react` 作为后续 chat UI/runtime adapter 候选；当前 UI 直接消费 Egg 自定义 SSE 协议。
- 已建立 lightweight `bootstrap.ts`，用于启动 V2 skeleton 和手动 dispatch。
- V1 legacy 实现、旧测试和批量 triage 脚本已删除。

## 5. 下一步

1. 在 `src/infra/linear/` 继续补齐 Linear OAuth、Webhook、AgentSession activity 能力；`LinearApiClient` 已放在该目录。
2. 继续完善 Linear issue/session 的上下文收集和 writer 注入；`submit_triage_result` 已具备真实 Linear issue update/comment 写回能力。
3. 用 `RunCoordinator` 接管 issue triage 和 AgentSession 的并发与取消。
4. 为 `@assistant-ui/react` 补 Egg SSE runtime adapter，替换当前本地 chat view 实现。
