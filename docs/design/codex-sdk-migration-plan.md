# Codex SDK 迁移计划

## 背景

Egg 当前的 agent 执行核心依赖 `@mariozechner/pi-agent-core`、`@mariozechner/pi-ai` 和 `@mariozechner/pi-coding-agent`。V2 改造目标是把 agent 核心切到 Codex，不再使用 pi 与 Kimi/Moonshot；Linear OAuth、Webhook、issue 查询、issue 更新、评论写回等交互链路继续保留。

官方 Codex SDK 文档给出的 TypeScript 包是 `@openai/codex-sdk`，运行在 Node.js 18+ 服务端环境，可在应用中启动、继续或恢复 Codex thread。迁移前需要先做最小 spike，锁定当前 SDK 的线程、运行结果、错误、取消、sandbox、模型配置和认证 API 形态。

## 目标

- 用 Codex TypeScript SDK 替换现有 pi agent runtime。
- 保留现有 Linear 能力，但 Linear API 读写统一收敛到 `linear` 子 agent；Webhook/OAuth 等入口设施只负责事件接入和认证。
- 保留“一个主 agent + N 个子 agent”的架构：主 agent 负责任务分发和编排，子 agent 负责具体任务执行；当前首个核心子 agent 是 `linear`，它负责 Linear 读写和 Linear issue 分诊判断。
- 对外只暴露主 agent：Linear 事件入口和直接聊天都进入主 agent，再由主 agent 分发给子 agent。
- Linear 入口与 agent runtime 解耦：Linear adapter/bridge 只产生日志安全的事件 envelope 和 session 映射，不读写 Linear 业务数据；所有 Linear API 读写由 `linear` 子 agent 完成。
- 保留分诊业务能力：`linear` 子 agent 收集 Linear issue 上下文、读取根目录 `prompts/triage.stable.md` + `prompts/triage.mutable.md`、启动独立 Codex thread，必要时调用 Langfuse trace 工具，并由同一个 `linear` 子 agent 写回 Linear。
- 支持多个 Linear issue / AgentSession / 直接聊天 session 同时进入：不同 session 可以并发运行，同一 session 内必须串行化或显式取消旧 run。
- 去掉 Moonshot/Kimi provider 配置和 OpenAI-compatible base URL 形态，改为 Codex/OpenAI 认证与模型配置。
- 保持 TypeScript strict，工具错误继续直接 `throw`。

## 非目标

- 不重写 Linear API/OAuth/Webhook。
- 不改变分诊 prompt 的业务规则和 owner 映射。
- 不引入新的数据库或队列。
- 不把 V2 改成云端 Codex Web/Linear 原生集成；本计划以本地服务内调用 Codex TypeScript SDK 为目标。

## 当前耦合点

| 区域 | 当前实现 | 迁移动作 |
| --- | --- | --- |
| Runtime | `new Agent(...)` + `agent.prompt(...)` | 替换为 Codex SDK thread/run 封装 |
| Model config | `LLMConfig` + `createModel()` + `LLM_PROVIDER=moonshot` | 改为 `CodexConfig`，保留模型等 Codex 侧参数 |
| Tool schema | `Type.Object(...)` from `@mariozechner/pi-ai` | 改为 Codex SDK 可用的工具定义方式 |
| Tool interface | `AgentTool` from `@mariozechner/pi-agent-core` | 建立本项目自己的 `EggTool`/`CodexTool` 适配层 |
| SubAgent | `asTool(): AgentTool` | 改为返回本项目工具描述，避免暴露第三方 runtime 类型 |
| MainAgent | 当前主要处理 Linear AgentSession | 改为平台无关的任务分发器，按 task type/capability 路由到子 agent |
| Linear coupling | `MainAgent` / `IssueTriage` 直接依赖 `LinearApiClient` | `LinearApiClient` 位于 `src/infra/linear/`，由 bootstrap 注入给 `linear` 子 agent 的 reader/writer 接口；adapter/bridge/main agent 不读写 Linear API |
| Public entry | 旧实现中 Webhook 可绕过主 agent | 所有外部入口统一调用 `MainAgent.dispatch()` |
| Session state | Linear session 历史由 `MainAgent` 临时拉取 | 统一维护 `ExternalSessionRef -> agentSessionId`，main 与 sub-agent 的 Codex thread 分开管理 |
| Prompt ownership | 单个 `prompts/triage.md` | 拆成根目录 `prompts/triage.stable.md` 和 `prompts/triage.mutable.md` |
| Triage | `IssueTriage.runTriage()` 内创建 pi Agent | 改为通过 `CodexRunner` 执行分诊 thread |
| AgentSession | `MainAgent` 内直接跑 `Agent` + `createReadTool()` | 由主 agent 路由到合适子 agent；本地读取能力通过 Codex SDK sandbox 或自定义工具重新确认 |
| Dependencies | `@mariozechner/pi-*` | 移除，新增 `@openai/codex-sdk` |

## 目标架构

```
External triggers
  |
  +--> Linear Adapter
  |     - verify webhook
  |     - create Linear event envelope
  |     - no Linear API business read/write
  |         |
  |         v
  |     LinearAgentBridge
  |     - translate Linear event -> AgentTask
  |     - resolve Linear ExternalSessionRef
  |     - call only MainAgent.dispatch()
  |
  +--> Direct Chat Adapter
        - receive user chat message
        - return assistant chat response
            |
            v
        DirectChatBridge
        - translate chat message -> AgentTask
        - translate AgentResult -> chat response

Both bridges
  - resolve ExternalSessionRef
  - maintain external session <-> agent session mapping
  - call only MainAgent.dispatch()
        |
        v
Agent Runtime
  - MainAgent
      - public agent entry
      - route AgentTask by type/capability
      - orchestrate N sub-agents
  - AgentRegistry
      - linear
      - future sub-agents
  - AgentSessionStore
  - RunCoordinator
  - CodexRunner
  - EggTool registry
```

核心新增边界：

- `src/integration/linear-agent/bridge.ts`：Linear 与 agent 之间的入口编排，只负责 Linear event envelope 到 `AgentTask`、`ExternalSessionRef` 的转换，不读写 Linear API。
- `src/integration/direct-chat/bridge.ts`：直接聊天入口与主 agent 之间的编排入口，负责聊天消息到 task、结果到聊天回复的转换。
- `src/agent/session/session-store.ts`：维护外部 session、内部 agent session、agent run 和 Codex thread 的映射关系。
- `src/agent/main/index.ts`：主 agent，负责接收 `AgentTask`、选择子 agent、编排执行和返回 `AgentResult`。
- `src/agent/sub/*`：子 agent 目录，每个子 agent 只负责一类明确能力边界；当前第一类是 `linear`。
- `prompts/`：统一保存 agent prompt；稳定规则和可迭代知识分文件管理。
- `src/agent/runtime/codex-runner.ts`：封装 `@openai/codex-sdk`，屏蔽 thread/run/resume、模型、sandbox、取消和错误映射。
- 应用托管的 `CodexRunner` 使用独立 `CODEX_HOME`：启动时从用户 Codex home 复制并过滤 config，只保留 `CODEX_ALLOWED_PLUGINS` 白名单中的插件配置，默认不保留任何 Codex 插件。Linear 读写只允许通过 `linear` 子 agent 的内部 EggTool 和注入的 reader/writer。
- `src/agent/runtime/run-coordinator.ts`：管理多 issue / 多 session 并发、同 session 串行化、全局并发上限、取消和运行状态。
- `src/agent/tool/types.ts`：定义项目内工具接口，不再让业务层依赖 pi 的 `AgentTool`。
- `src/agent/tool/schema.ts`：如 Codex SDK 工具定义不直接兼容 JSON Schema，则集中做 schema 适配。

## 主 Agent / 子 Agent 架构

V2 保持一个主 agent 和 N 个子 agent 的结构。主 agent 是唯一对外 agent 入口；外部系统不能直接调用子 agent。主 agent 不直接处理业务细节，它负责把平台无关的 `AgentTask` 分发给合适的子 agent，并在需要时编排多个子 agent。

### 主 Agent 负责

- 接收 `LinearAgentBridge`、`DirectChatBridge` 或其他未来集成传入的 `AgentTask`。
- 根据 `task.type`、`task.intent`、`task.capabilities` 路由到子 agent。
- 管理子 agent 调用顺序、失败处理和最终 `AgentResult` 聚合。
- 对不确定任务可以先做轻量分类；明确任务直接走确定性路由。
- 不依赖 Linear SDK，也不关心结果最终写回哪个外部系统。

### 子 Agent 负责

| 子 agent | 当前状态 | 职责 |
| --- | --- | --- |
| `linear` | V2 首个核心子 agent | 所有 Linear API 读写、Linear issue 分诊、Linear AgentSession activity/comment/update 写回 |
| `code-analysis` | 预留 | 代码阅读、变更分析、技术回复草稿 |
| `trace-analysis` | 预留 | Langfuse trace 深挖、质量/异常归因 |
| 其他 | 预留 | 后续按任务类型扩展 |

### 路由规则

- `AgentTask.type = "linear.issue.triage"` -> `linear` 子 agent。
- `AgentTask.type = "linear.session.prompt"` -> 主 agent 先让 `linear` 子 agent 读取 Linear session/issue 上下文；如果需要代码/trace/其他能力，再编排其他子 agent；最终 Linear 写回仍由 `linear` 子 agent 完成。
- `AgentTask.type = "direct-chat.message"` -> 主 agent 先判断意图，再分发给一个或多个子 agent。
- bridge 只负责把外部事件转成 task，不决定具体子 agent。
- 子 agent 返回结构化 `AgentResult`，主 agent 保留最终裁决权；需要写 Linear 时，主 agent 再调用 `linear` 子 agent 的写回 capability。

### Prompt 资产

所有 prompt 统一放在根目录 `prompts/`。稳定规则和可迭代知识必须拆开，避免 agent 自迭代时误改运行协议或边界规则。

建议结构：

```text
prompts/
  main-agent.md
  triage.stable.md
  triage.mutable.md
```

`linear` 子 agent 的分诊 prompt 从单个 `prompts/triage.md` 拆成两部分：`prompts/triage.stable.md` 保存稳定规则和运行协议，不允许 agent 自行修改；`prompts/triage.mutable.md` 保存团队职责、owner 映射、路由知识等需要被 agent 迭代的信息。主 agent 分发 `linear.issue.triage` task 时，只告诉 `linear` 子 agent 执行任务；`linear` 自己通过注入的 reader/writer 读取 issue/team/member/label/state/comment 上下文，自己加载 stable + mutable prompt，并把 `src/agent/sub/linear` 作为 Codex thread 的受限工作目录。当前实现已经接入独立子 agent Codex thread、内部工具循环，以及位于 `src/infra/linear/` 的 `@linear/sdk` reader/writer。

自迭代规则：

- `linear` 只能在明确的 prompt 迭代任务中维护和修改 `prompts/triage.mutable.md`。
- `prompts/triage.stable.md` 是稳定规则文件，不允许 agent 修改；如需调整必须由人工 code review 进入正常代码变更流程。
- prompt 迭代必须配套更新评估样例或评估说明，避免只凭单次反馈改 prompt。
- 运行分诊时默认只读 prompt；只有明确的“优化/迭代 linear triage prompt”任务才允许修改 `triage.mutable.md`。
- 子 agent 不能把 Linear API token、OAuth token 等外部凭证写入 prompt。
- prompt 版本变化应通过普通 git diff 暴露，方便人工 review 后再发布。

## 对外入口与 Session 模型

V2 当前支持两类触发方式，但对外都只进入主 agent：

| 触发方式 | Adapter / Bridge | MainAgent task | Session key |
| --- | --- | --- | --- |
| Linear 创建 issue / AgentSession | `LinearAdapter` + `LinearAgentBridge` | `linear.issue.triage` / `linear.session.prompt` | `linear:issue:<issueId>` 或 `linear:session:<agentSessionId>` |
| 用户直接聊天 | `DirectChatAdapter` + `DirectChatBridge` | `direct-chat.message` | `direct-chat:<channel>:<conversationId>` |

统一 session 输入：

```typescript
export interface ExternalSessionRef {
  source: "linear" | "direct-chat";
  scope: "issue" | "agent-session" | "conversation";
  externalSessionId: string;
  externalTurnId?: string;
}
```

主 agent 接口只接受通用 task 和 session：

```typescript
mainAgent.dispatch(task, {
  externalSession,
  agentSessionId,
  codexThreadId, // only for main-agent direct-chat thread
});
```

Session 规则：

- 不同 `ExternalSessionRef` 必须映射到不同 `agentSessionId`，避免 Linear 和直接聊天串上下文。
- direct-chat 的同一 `ExternalSessionRef` 继续使用同一个 main `codexThreadId`，从而保留主 agent 聊天记录和上下文。
- sub-agent 与 main-agent 不共享 Codex thread；进入 `SubAgent.invoke()` 前必须剥离 main `codexThreadId`，sub-agent 需要 Codex runtime 时自己重新 start thread。
- 同一 session 内的 turns 必须串行执行；新消息到来时排队，或在明确规则下取消旧 turn。
- `externalTurnId` 用于幂等，避免 Linear webhook 重放或聊天客户端重试导致重复回复。
- 子 agent 不感知外部 session 来源，只接收主 agent 提供的 `AgentTask` 和必要上下文。

### 新增子 Agent 扩展规范

后续新增子 agent 时，必须只扩展 agent 层，不改 Linear adapter 的业务逻辑。新增流程：

1. 在 `src/agent/sub/<agent-name>/` 新建子 agent。
2. 实现统一合同：

```typescript
export interface SubAgent {
  name: string;
  description: string;
  capabilities: string[];
  canHandle(task: AgentTask): boolean;
  asTool(): EggTool;
  invoke(task: AgentTask, context: SubAgentDispatchContext): Promise<AgentResult>;
}
```

3. 在 `AgentRegistry` 注册子 agent，并补充 capability 描述。
4. 在 `MainAgent` 的确定性路由表或意图判断 prompt 中加入新 capability。
5. 为子 agent 在根目录 `prompts/` 中创建对应 prompt 文件；稳定规则和可迭代知识分开。
6. 如果子 agent 需要外部系统数据，只通过 task context 或注入的 reader/writer 接口传入，不直接 import 外部 SDK；Linear SDK 访问统一封装在 `src/infra/linear/LinearApiClient`。
7. 子 agent 输出必须是结构化 `AgentResult`；外部系统写回由对应 owning sub-agent 或 adapter 完成，其中 Linear 写回只由 `linear` 子 agent 完成。
8. 每个子 agent 至少补充：
   - `canHandle()` 路由测试。
   - `invoke()` 核心行为测试。
   - 与主 agent dispatch 的集成测试。

## 外部系统 / Agent 解耦原则

Linear、直接聊天和 agent runtime 在架构上不互相依赖，只通过对应 bridge 和 `AgentSessionStore` 关联。

### Linear Adapter 负责

- 接收和校验 Linear webhook。
- 解析 Linear webhook payload 中已有的 event id、issue id、agent session id、activity id 等最小字段。
- 把 Linear event envelope 交给 `LinearAgentBridge`。
- 不通过 `LinearApiClient` 读取 issue/team/label/state/session。
- 不执行 issue update、comment、AgentSession thought/response/error。

### Linear 子 Agent 负责

- 通过注入的 `LinearIssueReader` / `LinearIssueWriter` 读取 Linear issue、team、member、label、workflow state、comments，并写回 issue update/comment。
- 对 Linear issue 做分诊判断，执行 assignee、priority、labels、state、comment 等写回。
- 对 Linear AgentSession 发送 thought、response、error activity。
- 当前已迁移旧分诊链路工具：`fetch_trace`、`submit_triage_result`，并补充多个 Linear issue 读取工具：`fetch_linear_issue_overview`、`fetch_linear_issue_comments`、`fetch_linear_issue_team_members`、`fetch_linear_issue_labels`、`fetch_linear_issue_workflow_states`；真实 Linear API reader/writer 通过 `LinearSubAgentOptions.tools` 注入并由 `@linear/sdk` 实现，AgentSession activity 写回后续再补。
- `linear` 子 agent 不直接 import `@linear/sdk`；SDK 只在 `src/infra/linear/` 内部使用。

### Linear Infra 负责

- `src/infra/linear/linear-api-client.ts` 是 Linear SDK adapter，负责 token 读取/刷新、issue/team/member/label/workflow state/comment 读取，以及 issue update/comment create。
- token store 默认仍为 `.data/oauth-token.json`，可通过 `LINEAR_TOKEN_STORE_PATH` 或 `TOKEN_STORE_PATH` 覆盖。

### Direct Chat Adapter 负责

- 接收用户直接发给主 agent 的聊天消息。
- 解析或创建直接聊天的 conversation/session id。
- 把聊天消息转换为 `AgentTaskInput`，交给 bridge。
- 接收 `ChatWriteCommand`，把主 agent 的最终回复返回给用户。

### Agent Runtime 负责

- 接收与平台无关的 `AgentTask`。
- 通过主 agent 路由到 N 个子 agent 中的一个或多个。
- 维护 Codex thread/run、tool 调用、取消、错误和最终 `AgentResult`。
- 主 agent 和通用 runtime 不 import `@linear/sdk`，不直接调用 `LinearApiClient`。
- 工具只能读取 task context 或返回结构化结果；Linear 读写工具只能注册在 `linear` 子 agent 的工具集中。
- Codex runtime 不能暴露 Codex Apps 的 Linear 工具给 main/sub-agent；否则会绕过 `submit_triage_result`、reader/writer 注入和 trace 记录。

### AgentSessionStore 负责

| 外部对象 | Agent 对象 | 用途 |
| --- | --- | --- |
| `linear.issueId` | `agentSessionId` / `agentRunId` / sub-agent Codex thread | 自动分诊去重、结果回写到正确 issue |
| `linear.agentSessionId` | `agentSessionId` / sub-agent Codex thread | Linear 多轮对话上下文恢复、同 session 串行化 |
| `linear.agentActivityId` | `agentTurnId` | Linear prompted 事件去重、避免重复回复 |
| `directChat.conversationId` | `agentSessionId` / main `codexThreadId` | 直接聊天上下文恢复、同 conversation 串行化 |
| `directChat.messageId` | `agentTurnId` | 聊天客户端重试去重、避免重复回复 |

V2 首版可以用 `.data/agent-session-store.json` 做轻量持久化；如果后续并发和恢复需求变复杂，再升级为 SQLite 或其他持久化存储。

## 多 Session / 并发设计

Linear 可能同时推送多个新 issue，也可能在多个 AgentSession 中同时 @mention Egg；用户也可能直接和主 agent 开多个聊天窗口。Codex 迁移后不能把 Codex client、thread、tool context 或 `AbortController` 当成单例复用到所有任务，否则会出现工具写错 issue、session 回复串线、取消误杀其他任务等问题。

### 运行粒度

| 场景 | run key | Codex thread | 并发策略 |
| --- | --- | --- | --- |
| Issue 自动分诊 | `triage:${issueId}` | Linear 子 agent 新建独立 thread | 不同 issue 可并发；同一 issue 去重 |
| Webhook gap 补漏 | `triage:${issueId}` | 与普通分诊一致 | 进入同一队列，避免补漏瞬间打满 |
| Linear AgentSession | `session:${agentSessionId}` | Linear 子 agent 使用自己的 thread | 不同 session 可并发；同一 session 串行处理 prompted |
| 直接聊天 | `chat:${channel}:${conversationId}` | main agent 绑定一个可恢复 thread | 不同 conversation 可并发；同一 conversation 串行处理 message |

### RunCoordinator 职责

- 维护 `activeRuns: Map<string, ActiveRun>`，记录 `runKey`、`agentRunId`、拥有方、`codexThreadId`、`AbortController`、开始时间、来源和状态。
- 对同一 `runKey` 做幂等保护：同一 issue 已在运行时跳过或复用正在运行的 promise，不再启动第二个 Codex thread。
- 对不同 `runKey` 做全局并发限制，默认建议从 `CODEX_MAX_CONCURRENT_RUNS=2` 或 `3` 开始，避免多个 Linear webhook 同时触发时耗尽本地 Codex/app-server/API 资源。
- 对同一 session run key 做串行队列：新 turn 到来时排在当前 run 后；如果外部系统发来 stop/cancel，取消当前 run 并清空未开始的队列。
- 任何工具执行都必须拿到当前 run 的 task context。Linear 读写只能发生在 `linear` 子 agent 的工具集中；bridge、adapter、主 agent 不能写 Linear。
- 每个 run 完成后必须在 `finally` 中释放 active 状态，防止失败后永久占用并发槽。

### 状态持久化

active run 可以只保存在内存中；外部 session 到 Codex thread 的映射如果要持久化，必须带拥有方，例如 main 与 `linear` 分开。这样服务重启后不会把 Linear subagent resume 到 main agent 的 thread。

## 分阶段计划

### Phase 0：SDK spike

1. 安装并锁定 `@openai/codex-sdk`。
2. 创建一个只在本地运行的 spike 脚本，验证：
   - 如何创建 thread、调用 `run()`、继续同一 thread、恢复历史 thread。
   - 多个 thread 同时 `run()` 时 SDK 是否线程安全，Codex app-server/CLI 是否有并发限制。
   - 如何传入模型、sandbox、cwd、环境变量和 abort signal。
   - 如何定义 function tool，如何接收工具参数，如何返回 tool result。
   - run result 中如何拿最终回复、错误、工具调用、token/trace 信息。
   - 是否能传图片输入；如果不能，分诊截图链路要降级为 URL 文本或改用文件输入能力。
3. 产出 SDK API 结论后再进入正式实现，避免按猜测重写 runtime。

### Phase 1：抽离项目内 runtime/tool 类型

1. 新增项目自有工具接口，例如：

```typescript
export interface EggTool<TParams = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: unknown;
  execute(params: TParams, context: ToolExecutionContext): Promise<TResult>;
}
```

2. 把 `fetch_trace` 和 `submit_triage_result` 从 pi `AgentTool` 改成 `EggTool`。
3. 调整 `SubAgent.asTool()` 和 `AgentRegistry.asTools()`，让它们返回项目内工具类型。
4. 新增 `AgentTask`、`AgentResult`、`ExternalSessionRef` 等中间类型，先不让 Codex 实现细节泄漏到入口层。
5. 明确 `MainAgent.dispatch(task)` 和 `SubAgent.canHandle(task)` / `SubAgent.invoke(task)` 合同。
6. 明确子 agent 的 `capabilities` 元数据和注册流程，后续新增子 agent 不需要改 bridge。
7. 新增 `ExternalSessionRef`、`AgentSessionState`、`AgentTurnState`，统一 Linear 和直接聊天的 session/turn 建模。
8. 明确 `SubAgentWorkspace` 合同，至少包含 `workspacePath`、`stablePromptPath`、`mutablePromptPath` 和读写权限模式。
9. 临时保留 pi adapter，确保这一阶段仍可运行。

### Phase 1.5：拆出 Linear-Agent Bridge

1. 新增 `src/integration/linear-agent/`。
2. 将 webhook 与 AgentSession 入口改为调用 bridge，bridge 统一调用 `MainAgent.dispatch(task)`，不直接调用某个子 agent。
3. 将 Linear 读写从 bridge/adapter 移入 `src/infra/linear/LinearApiClient`，并只通过 `linear` 子 agent 的 reader/writer 接口使用：bridge 只生成 `linear.*` task，`linear` 子 agent 负责触发读取和写回。
4. 新增 `AgentSessionStore`，维护 `issueId` / `agentSessionId` / `agentActivityId` / `conversationId` / `messageId` 与 `agentRunId` / owner-scoped `codexThreadId` 的映射。
5. 此阶段完成后，除 `src/infra/linear/**` 外，不应 import `@linear/sdk`；`src/agent/**` 不直接调用 `LinearApiClient`。
6. 此阶段完成后，Linear 分诊必须表现为 `linear.issue.triage` task -> 主 agent -> `linear` 子 agent。

### Phase 1.6：接入直接聊天入口

1. 新增 `src/integration/direct-chat/`。
2. 直接聊天入口只调用 `MainAgent.dispatch(task)`，不允许直接调用子 agent。
3. 为每个直接聊天 conversation 创建或恢复 `ExternalSessionRef(source="direct-chat")`。
4. 同一个 conversation 的消息按 turn 串行处理，不同 conversation 可并发。
5. 直接聊天回复通过 `ChatWriteCommand` 返回，不复用 Linear write command。

### Phase 2：CodexRunner 接入分诊

1. 新增 `CodexRunner.runTriage()`，内部使用 Codex SDK 执行 thread。
2. 将当前 `prompts/triage.md` 拆分迁移到 `prompts/triage.stable.md` 和 `prompts/triage.mutable.md`。
3. `LinearTriageSubAgent.invoke(task)` 从根目录 `prompts/` 加载 stable + mutable prompt 并拼接，只负责构造 prompt、图片/文件输入和工具列表，不再直接创建第三方 Agent。
4. `CodexRunner` 执行 `linear` 子 agent 时将 `src/agent/sub/linear` 作为受限工作区；普通分诊 run 使用只读模式，prompt 自迭代 run 才允许写入 `prompts/triage.mutable.md`。
5. `submit_triage_result` 继续作为最终提交工具，由 `linear` 子 agent 通过注入的 writer 写回 Linear，并返回结构化 `TriageResult`。
6. 对工具调用错误保持 `throw`，由 `CodexRunner` 做日志和错误映射。
7. 分诊入口通过 `RunCoordinator.enqueue("triage:${issueId}", ...)` 启动，保证同一 issue 不重复分诊，多个 issue 受全局并发上限控制。
8. `linear` 子 agent 完成写回后返回 `AgentResult` 给主 agent，bridge 只负责把最终状态暴露给入口层。
9. 增加 unit test 覆盖 `TriageResult` 参数解析、prompt 从子 workspace 加载、`linear` 子 agent 的 Linear 读写、同 issue 去重和多 issue 并发排队；真实 LLM 集成测试仍需手动确认后再跑。

### Phase 3：CodexRunner 接入 MainAgent

1. `MainAgent.handlePrompt()` 改为 `MainAgent.dispatch(task)`，处理平台无关的 `AgentTask`；Linear AgentSession 由 bridge 转换为 task。
2. `activeSessions` 的取消逻辑映射到 Codex SDK 支持的 abort/cancel 机制。
3. Linear activity 写回由 `linear` 子 agent 负责：
   - 收到 session 后 10 秒内先发 thought。
   - 完成后发 response。
   - 异常时发 error。
4. 重新确认 read 工具能力：
   - 优先用 Codex SDK sandbox/cwd 读取项目文件。
   - 如果必须保留 read tool，则用本项目工具接口实现只读目录访问，不再依赖 `pi-coding-agent`。
5. 同一个 Linear AgentSession 的 `created` / `prompted` 通过 session store 找到同一个 owner-scoped sub-agent Codex thread，并使用同一个 session queue，避免用户连续追问时并行 run 互相覆盖最终回复；该 thread 不得与 main agent thread 共用。
6. 同一个直接聊天 conversation 的多轮消息也通过 session store 找到同一个 Codex thread，并按 turn 串行处理。
7. 不同 Linear AgentSession / 直接聊天 conversation 允许并发，但同样受 `RunCoordinator` 的全局并发上限控制。
8. `MainAgent` 可以直接确定性路由 `linear.issue.triage`，只在 `linear.session.prompt`、`direct-chat.message` 等开放任务里使用 LLM 做任务意图判断。

### Phase 4：配置和依赖清理

1. 已移除 `@mariozechner/pi-agent-core`、`@mariozechner/pi-ai`、`@mariozechner/pi-coding-agent`。
2. 已移除 Moonshot/Kimi 配置：
   - `LLM_PROVIDER`
   - `MOONSHOT_*`
   - Claude provider env
   - OpenAI-compatible `baseUrl` 默认值
3. 已新增 Codex 配置：
   - `CODEX_MODEL`
   - `CODEX_SOURCE_HOME`
   - `CODEX_RUNTIME_HOME`
   - `CODEX_ALLOWED_PLUGINS`
   - `CODEX_WORKING_DIRECTORY`
   - `CODEX_SANDBOX_MODE`
   - `CODEX_REASONING_EFFORT`
   - `CODEX_NETWORK_ACCESS`
   - `CODEX_MAX_CONCURRENT_RUNS`
   - `AGENT_SESSIONS_ROOT`
   - `AGENT_SESSION_STORE_PATH`
   - `SESSION_TRACE_STORE_PATH`
4. 已更新 `README.md`、`README.zh-CN.md`、`AGENTS.md`、`docs/design/architecture.md`、`docs/design/data-flow.md`、`docs/design/tools-spec.md`。
5. 已在 `history.md` 记录 V2 runtime 迁移。

### Phase 5：验证

1. 静态检查：
   - `npm run typecheck`
2. 单元测试：
   - 新增的 runtime/tool adapter 单测
3. 手动确认后再跑真实 Codex/Linear 集成测试。
4. 手动验收：
   - 新建 Linear issue 事件进入 main agent 后可分发分诊。
   - 已分配 issue 跳过分诊。
   - priority/label 已存在时不覆盖。
   - `fetch_trace` 可被调用并返回摘要。
   - `linear` 子 agent 可读取 Linear issue/session 上下文。
   - `submit_triage_result` 在 `linear` 子 agent 内可更新 assignee/priority/labels/state 并评论。
   - `linear` 从 `prompts/triage.stable.md` 和 `prompts/triage.mutable.md` 加载并拼接分诊 prompt。
   - 普通分诊 run 不能写 prompt；明确的 prompt 迭代 run 只能修改 `triage.mutable.md` 和 evals，不能修改 `triage.stable.md`。
   - Linear AgentSession 可收到 thought/response/error。
   - 多个 issue 同时进入时，分诊结果写回各自 issue，不串线。
   - 同一 AgentSession 连续 prompted 时，回复按顺序进入同一 session，不并行覆盖。
   - 直接聊天的不同 conversation 保持独立上下文，同一 conversation 多轮回复按顺序处理。
   - `stopped` 只取消对应 session，不影响其他正在运行的 issue/session。
   - 除 `src/infra/linear/**` 外，不依赖 Linear SDK；bridge/adapter 不调用 `LinearApiClient`。
   - 重启后同一个 Linear AgentSession 或直接聊天 conversation 可通过 session store 恢复到原 Codex thread。
   - 主 agent 能把 `linear.issue.triage` 稳定分发给 `linear` 子 agent，且后续可注册更多子 agent。
   - 新增一个 mock 子 agent 时，只需注册 capability 和路由规则，不需要修改 Linear adapter。

## 验收标准

- 代码中不再 import `@mariozechner/pi-*`。
- `package.json` 与 lockfile 不再包含 pi 依赖。
- 默认运行路径不再依赖 Kimi/Moonshot。
- Linear OAuth、Webhook、issue update、comment、AgentSession activity 写回保持可用。
- 对外只暴露主 agent，Linear 和直接聊天都不能绕过主 agent 调用子 agent。
- 分诊输出仍通过结构化工具提交，不退回到自由文本解析。
- 主 agent 只负责路由和编排，Linear 读写和分诊判断由 `linear` 子 agent 完成。
- `linear` 的 triage prompt 是根目录 `prompts/` 中的文件资产，其中只有 `triage.mutable.md` 可在受控任务中自迭代。
- 新子 agent 可以通过统一 `SubAgent` 合同和 capability 注册扩展，不反向依赖 Linear。
- 多个 Linear issue / AgentSession / 直接聊天 session 同时进入时，Codex run 彼此隔离，受全局并发上限控制。
- 同一 issue 不会重复启动两个分诊 run；同一 AgentSession 或直接聊天 conversation 的多轮消息按顺序处理或被显式取消。
- Linear 入口与 agent runtime 解耦：adapter/bridge 只处理事件入口和 session 映射；所有 Linear API 读写只在 `linear` 子 agent 内发生。
- `npm run typecheck` 通过。
- 真实 LLM 集成测试在获得确认后通过，或记录明确的外部环境失败。

## 风险和待确认

- Codex TypeScript SDK 的 function tool API、图片输入、取消机制和返回事件结构需要以 spike 结果为准。
- Codex SDK 可能依赖本地 Codex app-server/CLI 状态；部署机需要明确安装、认证和运行方式。
- Codex 适合长任务，Linear 自动分诊需要低延迟；需要评估一次分诊的耗时和费用。
- 多 issue 并发会放大 Codex app-server/API 限流、费用和本机资源压力，必须先用小并发上限上线。
- 如果 Codex SDK 的本地 sandbox 默认会读写工作区，分诊路径应尽量使用只读或受限权限；只有 `linear` 子 agent 的 Linear 工具允许写 Linear。
- 现有 `docs/design/tools-spec.md` 已明显落后于当前 tool-calling 实现，正式迁移时必须同步修正。

## 参考

- OpenAI Codex SDK: https://developers.openai.com/codex/sdk
- OpenAI Agents SDK overview: https://developers.openai.com/api/docs/guides/agents
