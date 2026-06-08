# 优化记录

## 2026-06-07

- **V2 agent 架构骨架初始化** — 将旧 `src/` 实现移动到根目录 `legacy/`，重新创建 `src/agent`、`src/integration`、`src/routes` 和 `src/utils` 的 V2 骨架；新增 `AgentTask` / `AgentResult` / `SubAgent` 合同、`MainAgent.dispatch()`、`AgentRegistry`、`AgentSessionStore`、`RunCoordinator`、`CodexRunner` 适配层占位、Linear/direct-chat bridge，以及 `linear` 子 agent workspace
- **Linear 读写归属修正** — 更新 `docs/design/codex-sdk-migration-plan.md`，明确 Linear adapter/bridge 只处理 webhook envelope、session 映射和主 agent 入口，所有 Linear API 读取与写回都收敛到 `linear` 子 agent；`linear.issue.triage` 由主 agent 分发给 `linear` 子 agent 执行
- **Direct chat Codex runtime 接入** — 引入 `@openai/codex-sdk`，将 `CodexRunner` 从占位改为 SDK thread/run 适配层；普通 Direct chat 由主 agent 直接按 `agentSessionId` 复用 `codexThreadId`，并将 Codex run、命令执行、MCP 调用、web search、file change 等事件写入 session trace
- **主 agent / 子 agent 边界修正** — 移除 `DirectChatSubAgent`，明确 direct chat 是主 agent 的默认对话链路；子 agent 只表示领域能力，后续由主 agent 作为 tool 调用，例如 Linear
- **Codex 托管上下文边界修正** — 将 `ChatContextStore` 改为 `SessionTraceStore`，明确 Egg 只保存后台展示用 trace 投影；会话上下文由 Codex thread 托管，Egg 不再把本地聊天记录作为上下文源，新落盘文件为 `trace.json`，不保留旧 `context.json` 兼容
- **session 文件夹化存储与后台查看** — `AgentSessionStore` 和 `SessionTraceStore` 改为 `.data/sessions/<agentSessionId>/session.json` / `trace.json` 独立落盘；新增 Direct chat 页面和管理后台，可新建 session、发送消息、查看来源/trace/工具调用并删除 session
- **legacy 代码清理** — 删除根目录 `legacy/`、旧批量 triage 脚本和依赖 legacy 的旧测试；移除不再使用的 `@mariozechner/pi-*` runtime 依赖和 `npm run triage` 脚本
- **package 依赖精简** — `package.json` 只保留当前新架构实际使用的依赖：Hono、Codex SDK、Linear SDK、dotenv、React/Vite 前端、tsx、TypeScript 和 Node 类型；移除 legacy runtime 依赖、无测试支撑的 `vitest` 和未配置脚本的 `prettier`
- **Direct chat 流式协议** — 新增 `/api/direct-chat/messages/stream` SSE 入口，基于 Codex SDK `runStreamed()` 输出 `thread.started`、`message.delta`、`tool_call`、`turn.completed`、`done` 等事件，并保留原非流式 JSON 接口
- **前后端分离改造** — 新增 React + Vite 前端工作区 `src/web/`，将 Direct chat 和 Admin 后台改为独立前端页面；Direct chat 直接消费 SSE 流式协议，Admin 支持查看 session 来源、trace、工具调用并删除 session；引入 `@assistant-ui/react` 作为后续 chat UI/runtime adapter 候选
- **MainAgent prompt 外置** — 新增 `prompts/main-agent.md`，`MainAgent` 运行时读取该文件并拼接来源、conversationId 和用户消息，代码中不再内联主 agent 行为 prompt
- **Chat 默认恢复最近 session** — Chat 页面加载时不再自动创建 session，改为读取最近一个 direct-chat session 并恢复 trace 消息；没有历史 session 时保持空态，需手动点击 New 创建
- **Direct chat 历史切换** — 新增 direct-chat session 列表接口，Chat 左侧展示 direct chat 历史，默认选中最近 session，支持点击切换并恢复对应 trace 消息和工具事件
- **Codex 中间事件展示增强** — Chat 页面解析 Codex `item.*` 事件，展示 web search query、command 输出、MCP tool 参数/结果、todo list、file change、reasoning summary 和 assistant message 更新，并按 runtime item id 合并刷新事件状态
- **Linear 子 agent tool 化** — `SubAgent` 增加 `asTool()` 合同，`AgentRegistry` 支持导出子 agent 工具；`linear` 子 agent 暴露为 `linear` EggTool，后续由 MainAgent 决策链路选择是否调用，不做 Direct Chat 关键词/正则分流
- **Main/Sub Codex thread 隔离** — Direct Chat 接入 MainAgent 的模型决策 tool 链路；决策 run 使用临时 thread，最终回复使用 main thread，子 agent tool 执行只接收不含 `codexThreadId` 的 `SubAgentDispatchContext`，后续子 agent 需要 Codex 时必须独立 start thread
- **主子 agent 调用链记录** — `SessionTraceStore` 新增 `agentCalls` 投影，记录 `main -> linear` 等主子调用的 mode、状态、输入输出和错误；Admin 后台列表展示 agent call 数量，详情页单独展示 Agent Calls 与 Tool Calls
- **MainAgent 唯一出入口修正** — 明确 Linear webhook / AgentSession 只由 bridge 转成 `AgentTask` 并进入 `MainAgent.dispatch()`，bridge 不直接选择或调用子 agent；主子调用 trace mode 改为 `main-dispatch`，强调由 main agent 统一分发
- **Linear 旧分诊工具迁移** — 在 `linear` 子 agent 内部挂载旧链路已有的 `fetch_trace` 和 `submit_triage_result` EggTool，并补充多个 Linear issue 读取工具：`fetch_linear_issue_overview`、`fetch_linear_issue_comments`、`fetch_linear_issue_team_members`、`fetch_linear_issue_labels`、`fetch_linear_issue_workflow_states`；暂不新增 AgentSession activity tool，Linear 读写通过 `LinearSubAgentOptions.tools.issueReader/issueWriter` 注入
- **Linear 子 agent Codex 执行链路接入** — `LinearSubAgent.invoke()` 现在读取根目录 linear triage prompt，独立启动子 agent Codex thread，通过结构化 `tool_call` JSON 循环执行内部 EggTool，并把 `linear.codex_run`、内部工具调用和 Codex runtime 工具事件写入 session trace
- **Linear prompt stable/mutable 拆分** — `prompts/triage.md` 已拆成 `prompts/triage.stable.md` 与 `prompts/triage.mutable.md` 两部分并由 `linear` 子 agent 拼接读取；稳定规则不可由 agent 修改，团队职责等可迭代知识放在 mutable 文件中
- **Linear SDK reader/writer 接入** — 恢复真实 Linear API 访问，`src/infra/linear/linear-api-client.ts` 使用 `@linear/sdk` 读取 issue/team/member/label/workflow state/comment 上下文，并通过 SDK 执行 issue update 和 comment create；token store 默认仍为 `.data/oauth-token.json`，也支持 `LINEAR_ACCESS_TOKEN` 或 OAuth token store 自动刷新
- **主子 agent 结果流式返回** — Direct Chat SSE 新增 `agent_call.started` / `agent_call.completed` / `agent_call.failed` 事件，MainAgent 收到子 agent tool 结果后会立即把结果写入 SSE，并在最终 `done.result.data.toolRun` 中保留本次子 agent 调用结果；Chat 前端同步展示实时和历史 Agent Call
- **Codex runtime home 白名单隔离** — 应用托管的 `CodexRunner` 改用独立 `CODEX_HOME`：启动时生成 `.data/codex-home/config.toml`，只保留 `CODEX_ALLOWED_PLUGINS` 白名单中的插件配置，默认不保留任何 Codex 插件；这样避免 main/sub-agent 直接调用 Linear/GitHub/Figma/Gmail/Browser 等外部插件绕过内部工具链
- **submit_triage_result 稳定注册** — 移除注册前的 `triageContextFromTask` gate，`submit_triage_result` 现在稳定挂载在 linear 子 agent 内部；执行时按 task 中的 `issueId` 或 `identifier` 通过 Linear reader 拉完整上下文后再写回，避免 identifier-only 分诊任务无法提交结果

## 2026-06-03

- **linear prompt 工作区自迭代方案** — 在 `docs/design/codex-sdk-migration-plan.md` 中补充子 agent prompt 规范，明确 `linear` 子 agent 的分诊 prompt 统一位于根目录 `prompts/`，普通分诊只读，明确的 prompt 迭代任务才允许修改可迭代 prompt 和 evals

## 2026-06-02

- **V2 Codex SDK 迁移计划** — 新增 `docs/design/codex-sdk-migration-plan.md`，明确将 agent runtime 从 pi/Moonshot/Kimi 迁移到 Codex TypeScript SDK，同时保留 Linear OAuth、Webhook、Issue 分诊写回和 AgentSession activity 链路，并补充对外只暴露主 agent、Linear/直接聊天双入口、通用 session store、并发隔离、Linear-Agent bridge、主 agent 分发、N 个子 agent 与子 agent 扩展规范

## 2026-04-04

- **主子 Agent 架构重构** — 旧版从单一用途的 Linear 分诊工具重构为可扩展的主子 agent 架构。引入 `SubAgent` 接口（`invoke()` + `asTool()`）和 `AgentRegistry`；V2 已修正为外部入口只能进入 MainAgent，再由 MainAgent 分发或作为 tool 调用子 agent
- **目录结构重组** — `src/` 拆为四层：`agent/`（主 agent、子 agent、tool）、`infra/`（Linear SDK/OAuth/Webhook）、`utils/`（config、logger）、`routes/`（Hono 路由）；入口从 `index.ts` 改为 `bootstrap.ts`
- **项目更名** — `linear-agent` → `egg`，定位从 Linear 分诊工具升级为通用工作自动化 Agent
- **类型清理** — `PluginLogger` 重命名为 `Logger` 并合并到 `utils/logger.ts`，去除 OpenClaw 历史引用

## 2026-04-03

- **引入 pi-agent-core** — 用 `@mariozechner/pi-agent-core` 的 `Agent` 类替代手写 tool-calling 循环，自动处理消息状态、工具执行、错误处理
- **submit_triage_result 直接写入 Linear** — `submitTriageTool` 改为工厂函数 `createSubmitTriageTool`，在工具 `execute` 中直接调用 `updateIssue` 和 `createComment`，不再需要外部 `applyResult` 流程
- **清理冗余类型和日志** — 删除 `TriageTool` 类型别名和 `types.ts`，工具直接使用 `AgentTool`；移除 5 条非必要日志（already triaged、calling tool、not eligible、updated、done），仅保留主链路结果和异常日志
- **集成测试** — 新增 `test/triage.test.ts`，mock Linear API + 真实 LLM 调用，覆盖 Contact Us、Sentry Error、非分类 issue、部分字段已设置四种场景
- **Langfuse Trace 查询工具** — 新增 `fetch_trace` tool，当 issue 描述中包含 `lab.gooo.ai` trace 链接时，LLM 可调用该工具获取 observations 数据，提取 tool 调用次数及异常信息，辅助更精准地判断问题类型和分配负责人
- **结构化结果提交** — 新增 `submit_triage_result` tool，LLM 通过 tool call 提交结构化的 triage 结果，替代 `response_format: json_object`，解决 tool calling 与 JSON 模式冲突问题
- **中文化工具描述** — 所有工具的 description 和参数说明统一使用中文，与 triage prompt 语言一致

## 2026-04-02

- **Webhook 缺口检测与自动补漏** — 通过内存跟踪每个团队前缀的 issue 编号序列，当检测到编号跳跃时自动通过 API 拉取遗漏的 issue 并补跑 triage，所有缺口事件以 `[webhook-gap]` 前缀记录日志
- **日志时区修正** — 日志时间戳和日志文件名统一使用 Asia/Shanghai 时区（UTC+8），避免服务器时区不一致导致的困惑
- **网络重试机制** — 为 `triageIssue` 增加指数退避重试（最多 3 次），应对 LLM 调用等环节的瞬时网络故障
- **多模态 Triage 支持** — 自动提取 issue 描述中的图片，下载后以 base64 编码发送给 LLM，使 triage 判断能参考截图等视觉信息

## 2026-04-01

- **Webhook 诊断日志** — 为 webhook 端点增加详细的请求诊断日志，辅助排查图片相关问题
- **LLM Triage 资格预判** — 新增 LLM 判断 issue 是否适合自动 triage 的能力，不适合的 issue 跳过处理；triage 完成后自动将 issue 从 triage 状态迁移到 backlog
- **文档更新** — 重写设计文档适配独立架构，README 补充管理员前置条件说明
- **LLM 输出格式优化** — 通过 `response_format: json_object` 强制 LLM 返回 JSON，简化 `parseResult` 解析逻辑
