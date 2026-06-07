import type { Hono } from "hono";
import type { AgentSessionStore } from "../agent/session/session-store";
import type { SessionTraceStore } from "../agent/session/session-trace-store";

export function registerAdminRoutes(
  app: Hono,
  sessionStore: AgentSessionStore,
  sessionTraceStore: SessionTraceStore,
): void {
  app.get("/api/admin/sessions", async (c) => {
    const sessions = await sessionStore.list();
    const traces = await sessionTraceStore.list();
    const traceBySessionId = new Map(
      traces.map((trace) => [trace.agentSessionId, trace]),
    );

    return c.json({
      sessions: sessions.map((session) => {
        const trace = traceBySessionId.get(session.agentSessionId);
        return {
          ...session,
          messageCount: trace?.messages.length ?? 0,
          toolCallCount: trace?.toolCalls.length ?? 0,
          lastMessageAt: trace?.updatedAt,
        };
      }),
    });
  });

  app.get("/api/admin/sessions/:agentSessionId", async (c) => {
    const agentSessionId = c.req.param("agentSessionId");
    const session = await sessionStore.findByAgentSessionId(agentSessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    return c.json({
      session,
      trace: (await sessionTraceStore.get(agentSessionId)) ?? null,
    });
  });

  app.delete("/api/admin/sessions/:agentSessionId", async (c) => {
    const agentSessionId = c.req.param("agentSessionId");
    const deletedTrace = await sessionTraceStore.delete(agentSessionId);
    const deletedSession = await sessionStore.deleteByAgentSessionId(agentSessionId);

    if (!deletedSession && !deletedTrace) {
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json({
      deleted: true,
      agentSessionId,
      deletedSession,
      deletedTrace,
    });
  });
}
