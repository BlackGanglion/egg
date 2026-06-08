[中文](./README.zh-CN.md) | English

# egg

LLM-driven work automation agent, rebuilt around a main-agent + sub-agent architecture and the Codex runtime.

## Current State

- Direct chat entrypoint backed by `MainAgent` and `CodexRunner`
- Codex thread owns conversation context; Egg stores only session mapping and admin trace projection
- React/Vite frontend for direct chat and admin
- Admin UI for inspecting sessions, trace messages, tool calls, session source, and deleting sessions
- Linear sub-agent boundary is scaffolded; Linear OAuth/Webhook/API write-back still needs to be rebuilt on the new architecture

## Commands

```bash
npm run dev        # tsx --watch bootstrap.ts
npm run dev:api    # tsx --watch bootstrap.ts
npm run dev:web    # Vite frontend dev server
npm run dev:all    # backend + frontend dev servers
npm run build:web  # build React app into src/web/dist
npm start          # tsx bootstrap.ts
npm run typecheck  # backend + frontend TypeScript checks
npm test           # no tests configured yet
```

## Environment

All configuration is via environment variables (`.env` is supported).

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port. Default: `3000` |
| `AGENT_SESSIONS_ROOT` | No | Root folder for per-session storage. Default: `.data/sessions` |
| `AGENT_SESSION_STORE_PATH` | No | Override session metadata storage root |
| `SESSION_TRACE_STORE_PATH` | No | Override admin trace storage root |
| `CODEX_MODEL` | No | Codex model override |
| `CODEX_SOURCE_HOME` | No | Source Codex home used for auth/config/plugin cache. Default: current `CODEX_HOME` or `~/.codex` |
| `CODEX_RUNTIME_HOME` | No | Isolated Codex home generated for Egg runtime. Default: `.data/codex-home` |
| `CODEX_ALLOWED_PLUGINS` | No | Comma-separated Codex plugin allowlist for the Egg runtime. Default: empty, all Codex plugins removed |
| `CODEX_WORKING_DIRECTORY` | No | Working directory passed to Codex. Default: process cwd |
| `CODEX_SANDBOX_MODE` | No | `read-only`, `workspace-write`, or `danger-full-access`. Default: `read-only` |
| `CODEX_REASONING_EFFORT` | No | `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `CODEX_NETWORK_ACCESS` | No | Enable Codex network access. Default: `false` |
| `CODEX_MAX_CONCURRENT_RUNS` | No | Global concurrent Codex run limit. Default: `2` |

Codex authentication is handled by the Codex runtime/CLI environment, not by the old Moonshot/Claude variables.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/chat` | Direct chat UI |
| `GET` | `/admin` | Session/admin trace UI |
| `POST` | `/api/direct-chat/sessions` | Create a direct chat session |
| `POST` | `/api/direct-chat/messages` | Send a direct chat message |
| `POST` | `/api/direct-chat/messages/stream` | Send a direct chat message with SSE streaming |
| `GET` | `/api/admin/sessions` | List sessions |
| `GET` | `/api/admin/sessions/:agentSessionId` | Inspect a session and trace |
| `DELETE` | `/api/admin/sessions/:agentSessionId` | Delete a session |

## Project Structure

```text
bootstrap.ts
prompts/
  main-agent.md                  # MainAgent prompt
src/
  agent/
    main/                       # MainAgent
    runtime/                    # CodexRunner, RunCoordinator
    session/                    # AgentSessionStore, SessionTraceStore
    sub/linear/                 # Linear sub-agent scaffold and workspace
    tool/                       # Project tool contracts
  integration/
    direct-chat/                # Direct chat bridge
    linear-agent/               # Linear envelope bridge scaffold
  routes/                       # Hono API routes and built frontend serving
  utils/                        # Config, logger
  web/
    src/                        # React/Vite frontend
```

## Development Notes

- Direct chat is not a sub-agent; it is the main agent's default conversation path.
- MainAgent prompt is stored in `prompts/main-agent.md`, not inline code.
- Sub-agents represent domain capabilities and should be exposed to the main agent as tools.
- Egg does not replay local chat records into Codex. Context recovery uses `codexThreadId`.
- Admin trace files are projection data only: `.data/sessions/<agentSessionId>/trace.json`.
- Chat streaming uses Server-Sent Events from `/api/direct-chat/messages/stream`.
- `@assistant-ui/react` is installed as the candidate open-source chat UI layer; the current UI consumes Egg's custom SSE protocol directly until a dedicated runtime adapter is added.
