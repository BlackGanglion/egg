# Egg

LLM 驱动的工作自动化 Agent，采用主 agent + 子 agent 架构，并使用 Codex runtime。

## 命令

```bash
npm run dev        # tsx --watch bootstrap.ts
npm run dev:api    # tsx --watch bootstrap.ts
npm run dev:web    # Vite 前端 dev server
npm run dev:all    # 同时启动后端和前端 dev server
npm run build:web  # 构建 React 前端到 src/web/dist
npm start          # tsx bootstrap.ts
npm run typecheck  # 后端 + 前端 TypeScript 检查
npm test           # 当前暂无测试
```

## 架构

- `MainAgent` 是唯一 agent 入口。
- Direct chat 是主 agent 的默认对话链路，不是子 agent。
- 子 agent 表示领域能力，后续应作为主 agent 可调用的 tool，例如 Linear。
- Codex thread 托管对话上下文；Egg 只保存 `agentSessionId -> codexThreadId` 和后台 trace 投影。

## 当前目录

```text
bootstrap.ts
prompts/
└── main-agent.md              # MainAgent prompt
src/
├── agent/
│   ├── main/                 # MainAgent
│   ├── registry.ts           # AgentRegistry
│   ├── runtime/              # CodexRunner, RunCoordinator
│   ├── session/              # AgentSessionStore, SessionTraceStore
│   ├── sub/linear/           # Linear 子 agent 骨架和 workspace
│   └── tool/                 # 项目工具合同
├── integration/
│   ├── direct-chat/          # Direct chat bridge
│   └── linear-agent/         # Linear envelope bridge 骨架
├── routes/                   # Hono API 和前端构建产物托管
├── utils/                    # config, logger
└── web/
    └── src/                  # React + Vite 前端
```

## 关键模式

- `CodexRunner` 是 Codex SDK 的唯一封装点。
- MainAgent prompt 存放在 `prompts/main-agent.md`，不要直接写在代码里。
- `SessionTraceStore` 只用于后台展示，不作为上下文源，也不喂回 Codex。
- session 按文件夹存储：`.data/sessions/<agentSessionId>/session.json` 和 `trace.json`。
- Direct chat 前端通过 `/api/direct-chat/messages/stream` 消费 SSE 事件。
- `@assistant-ui/react` 作为开源 chat UI 候选依赖，当前先使用本地 SSE adapter，后续再接专用 runtime adapter。
- 工具错误直接 `throw`，由调用链统一映射为失败结果。

## 代码规范

- 仅添加必要 log。
- TypeScript strict 模式，ES2022。
- 中文用于面向用户的文案。
- 不要自动提交代码，每次需要提交时向用户确认。
- 遇到较大变化时，自动写入 `history.md`。
- 项目架构变化时，同步更新 `docs/design/` 下的设计文档。

## 测试

- `npm run typecheck` 可自动运行。
- 当前没有真实 LLM 集成测试；新增真实 Codex/Linear 调用测试前需要用户确认。

## 环境变量

当前新架构不再使用 `LLM_PROVIDER`、`MOONSHOT_API_KEY`、`CLAUDE_API_KEY`。

常用：
- `PORT`
- `AGENT_SESSIONS_ROOT`
- `AGENT_SESSION_STORE_PATH`
- `SESSION_TRACE_STORE_PATH`
- `CODEX_MODEL`
- `CODEX_SOURCE_HOME`
- `CODEX_RUNTIME_HOME`
- `CODEX_ALLOWED_PLUGINS`
- `CODEX_WORKING_DIRECTORY`
- `CODEX_SANDBOX_MODE`
- `CODEX_REASONING_EFFORT`
- `CODEX_NETWORK_ACCESS`
- `CODEX_MAX_CONCURRENT_RUNS`
