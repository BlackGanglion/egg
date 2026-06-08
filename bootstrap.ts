import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./src/utils/config";
import { createLogger } from "./src/utils/logger";
import { AgentRegistry } from "./src/agent/registry";
import { MainAgent } from "./src/agent/main";
import { AgentSessionStore } from "./src/agent/session/session-store";
import { SessionTraceStore } from "./src/agent/session/session-trace-store";
import { CodexRunner } from "./src/agent/runtime/codex-runner";
import { prepareCodexRuntimeHome } from "./src/agent/runtime/codex-home";
import { RunCoordinator } from "./src/agent/runtime/run-coordinator";
import { LinearSubAgent } from "./src/agent/sub/linear";
import { LinearApiClient } from "./src/infra/linear/linear-api-client";
import { LinearAgentBridge } from "./src/integration/linear-agent/bridge";
import type {
  LinearAgentSessionEnvelope,
  LinearIssueCreatedEnvelope,
} from "./src/integration/linear-agent/types";
import { DirectChatBridge } from "./src/integration/direct-chat/bridge";
import { registerHealthRoutes } from "./src/routes/health";
import { registerDirectChatRoutes } from "./src/routes/direct-chat";
import { registerAdminRoutes } from "./src/routes/admin";
import { registerUiRoutes } from "./src/routes/ui";
import type { AgentTask } from "./src/agent/types";

const config = loadConfig();
const logger = createLogger();

const registry = new AgentRegistry();
const sessionStore = new AgentSessionStore(config.agentSessionStorePath);
const sessionTraceStore = new SessionTraceStore(config.sessionTraceStorePath);
const codexRuntimeHome = await prepareCodexRuntimeHome({
  runtimeHome: config.codexRuntimeHome,
  sourceHome: config.codexSourceHome,
  allowedPlugins: config.codexAllowedPlugins,
});
const codexRunner = new CodexRunner({
  codexOptions: {
    env: codexRuntimeHome.env,
  },
  model: config.codexModel,
  workingDirectory: config.codexWorkingDirectory,
  sandboxMode: config.codexSandboxMode,
  modelReasoningEffort: config.codexReasoningEffort,
  networkAccessEnabled: config.codexNetworkAccessEnabled,
});
const linearApiClient = new LinearApiClient({
  accessToken: config.linearAccessToken,
  clientId: config.linearClientId,
  clientSecret: config.linearClientSecret,
  tokenStorePath: config.linearTokenStorePath,
});
registry.register(
  new LinearSubAgent({
    codexRunner,
    sessionTraceStore,
    tools: {
      issueReader: linearApiClient,
      issueWriter: linearApiClient,
    },
  }),
);

const mainAgent = new MainAgent(registry, {
  sessionTraceStore,
  codexRunner,
  sessionStore,
});
const runCoordinator = new RunCoordinator({
  maxConcurrentRuns: config.codexMaxConcurrentRuns,
});
const linearBridge = new LinearAgentBridge(mainAgent, sessionStore, runCoordinator);
const directChatBridge = new DirectChatBridge(mainAgent, sessionStore, runCoordinator);

const app = new Hono();

registerUiRoutes(app);
registerHealthRoutes(app, registry, runCoordinator);
registerDirectChatRoutes(app, directChatBridge, sessionStore, sessionTraceStore);
registerAdminRoutes(app, sessionStore, sessionTraceStore);

app.post("/agent/tasks", async (c) => {
  const task = await c.req.json<AgentTask>();
  const result = await mainAgent.dispatch(task, {
    externalSession: task.externalSession,
  });
  return c.json(result);
});

app.post("/integrations/linear/issues", async (c) => {
  const envelope = await c.req.json<LinearIssueCreatedEnvelope>();
  const result = await linearBridge.handleIssueCreated(envelope);
  return c.json(result);
});

app.post("/integrations/linear/sessions", async (c) => {
  const envelope = await c.req.json<LinearAgentSessionEnvelope>();
  const result = await linearBridge.handleAgentSessionEvent(envelope);
  return c.json(result);
});

serve({ fetch: app.fetch, port: config.port }, () => {
  logger.info(
    `Codex runtime home: ${codexRuntimeHome.homePath}; allowed plugins: ${codexRuntimeHome.allowedPlugins.join(", ") || "(none)"}`,
  );
  logger.info(`egg v2 scaffold listening on http://localhost:${config.port}`);
});
