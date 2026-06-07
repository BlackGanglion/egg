中文 | [English](./README.md)

# egg

LLM 驱动的工作自动化 Agent，基于主 agent + 子 agent 架构，并使用 Codex runtime。

## 当前状态

- Direct chat 入口已接入 `MainAgent` 和 `CodexRunner`
- 对话上下文由 Codex thread 托管；Egg 只保存 session 映射和后台 trace 投影
- React/Vite 前端已接入 Direct chat 和管理后台
- 管理后台可查看 session、trace 消息、工具调用和来源，并支持删除 session
- Linear 子 agent 边界已搭好；Linear OAuth/Webhook/API 写回仍需按新架构重建

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

## 环境变量

所有配置通过环境变量（支持 `.env` 文件）。

| 变量 | 必填 | 说明 |
|------|------|------|
| `PORT` | 否 | 服务端口，默认 `3000` |
| `AGENT_SESSIONS_ROOT` | 否 | 每个 session 独立存储的根目录，默认 `.data/sessions` |
| `AGENT_SESSION_STORE_PATH` | 否 | 覆盖 session metadata 存储根目录 |
| `SESSION_TRACE_STORE_PATH` | 否 | 覆盖后台 trace 存储根目录 |
| `CODEX_MODEL` | 否 | Codex 模型覆盖 |
| `CODEX_WORKING_DIRECTORY` | 否 | 传给 Codex 的工作目录，默认当前进程 cwd |
| `CODEX_SANDBOX_MODE` | 否 | `read-only`、`workspace-write` 或 `danger-full-access`，默认 `read-only` |
| `CODEX_REASONING_EFFORT` | 否 | `minimal`、`low`、`medium`、`high` 或 `xhigh` |
| `CODEX_NETWORK_ACCESS` | 否 | 是否允许 Codex 网络访问，默认 `false` |
| `CODEX_MAX_CONCURRENT_RUNS` | 否 | Codex run 全局并发上限，默认 `2` |

Codex 认证由 Codex runtime/CLI 环境负责，不再使用旧的 Moonshot/Claude 环境变量。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/chat` | Direct chat 页面 |
| `GET` | `/admin` | session/trace 管理后台 |
| `POST` | `/api/direct-chat/sessions` | 创建 direct chat session |
| `POST` | `/api/direct-chat/messages` | 发送 direct chat 消息 |
| `POST` | `/api/direct-chat/messages/stream` | 通过 SSE 流式发送 direct chat 消息 |
| `GET` | `/api/admin/sessions` | 查看 session 列表 |
| `GET` | `/api/admin/sessions/:agentSessionId` | 查看 session 和 trace 详情 |
| `DELETE` | `/api/admin/sessions/:agentSessionId` | 删除 session |

## 项目结构

```text
bootstrap.ts
prompts/
  main-agent.md                  # MainAgent prompt
src/
  agent/
    main/                       # MainAgent
    runtime/                    # CodexRunner, RunCoordinator
    session/                    # AgentSessionStore, SessionTraceStore
    sub/linear/                 # Linear 子 agent 骨架和 workspace
    tool/                       # 项目工具合同
  integration/
    direct-chat/                # Direct chat bridge
    linear-agent/               # Linear envelope bridge 骨架
  routes/                       # Hono API 路由和前端构建产物托管
  utils/                        # 配置、日志
  web/
    src/                        # React/Vite 前端
```

## 开发说明

- Direct chat 不是子 agent，而是主 agent 的默认对话路径。
- MainAgent prompt 存放在 `prompts/main-agent.md`，不直接写在代码里。
- 子 agent 表示领域能力，后续应作为 tool 暴露给主 agent。
- Egg 不把本地聊天记录回放给 Codex；上下文恢复依赖 `codexThreadId`。
- 后台 trace 只是展示投影：`.data/sessions/<agentSessionId>/trace.json`。
- Chat 流式协议通过 `/api/direct-chat/messages/stream` 输出 SSE。
- `@assistant-ui/react` 已作为开源 chat UI 候选依赖接入；当前 UI 先直接消费 Egg 自定义 SSE，后续再补专用 runtime adapter。
