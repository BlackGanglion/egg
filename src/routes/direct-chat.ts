import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { DirectChatBridge } from "../integration/direct-chat/bridge";
import type { AgentSessionStore } from "../agent/session/session-store";
import type { SessionTraceStore } from "../agent/session/session-trace-store";
import type { ExternalSessionRef } from "../agent/types";

interface CreateSessionBody {
  channel?: string;
}

interface SendMessageBody {
  channel?: string;
  conversationId?: string;
  messageId?: string;
  body?: string;
}

export function registerDirectChatRoutes(
  app: Hono,
  directChatBridge: DirectChatBridge,
  sessionStore: AgentSessionStore,
  sessionTraceStore: SessionTraceStore,
): void {
  app.get("/api/direct-chat/sessions", async (c) => {
    const channel = c.req.query("channel")?.trim() || "web";
    const details = await listDirectChatSessionDetails(
      sessionStore,
      sessionTraceStore,
      channel,
    );

    return c.json({
      sessions: details,
    });
  });

  app.get("/api/direct-chat/sessions/latest", async (c) => {
    const channel = c.req.query("channel")?.trim() || "web";
    const [latest] = await listDirectChatSessionDetails(
      sessionStore,
      sessionTraceStore,
      channel,
    );

    return c.json(latest ?? { session: null, trace: null });
  });

  app.post("/api/direct-chat/sessions", async (c) => {
    const body = await c.req
      .json<CreateSessionBody>()
      .catch((): CreateSessionBody => ({}));
    const channel = body.channel?.trim() || "web";
    const conversationId = randomUUID();
    const externalSession = directChatSessionRef(channel, conversationId);
    const session = await sessionStore.getOrCreate(externalSession);
    await sessionTraceStore.ensureSession(session.agentSessionId);

    return c.json({
      channel,
      conversationId,
      externalSession,
      agentSessionId: session.agentSessionId,
      codexThreadId: session.codexThreadId,
    });
  });

  app.post("/api/direct-chat/messages", async (c) => {
    const body = await c.req.json<SendMessageBody>();
    const channel = body.channel?.trim() || "web";
    const conversationId = body.conversationId?.trim() || randomUUID();
    const messageId = body.messageId?.trim() || randomUUID();
    const messageBody = body.body?.trim() || "";

    if (!messageBody) {
      return c.json({ error: "Message body is required" }, 400);
    }

    const result = await directChatBridge.handleMessage({
      channel,
      conversationId,
      messageId,
      body: messageBody,
    });

    return c.json({
      channel,
      conversationId,
      messageId,
      result,
    });
  });

  app.post("/api/direct-chat/messages/stream", async (c) => {
    const body = await c.req.json<SendMessageBody>();
    const channel = body.channel?.trim() || "web";
    const conversationId = body.conversationId?.trim() || randomUUID();
    const messageId = body.messageId?.trim() || randomUUID();
    const messageBody = body.body?.trim() || "";

    if (!messageBody) {
      return c.json({ error: "Message body is required" }, 400);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown): void => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        };

        try {
          send("session", { channel, conversationId, messageId });
          const result = await directChatBridge.handleMessageStream(
            {
              channel,
              conversationId,
              messageId,
              body: messageBody,
            },
            async (event) => {
              send(event.type === "codex" ? event.event.type : event.type, event);
            },
          );
          send("done", {
            channel,
            conversationId,
            messageId,
            result,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          send("error", { message });
        } finally {
          controller.close();
        }
      },
      cancel() {
        directChatBridge.cancelConversation(channel, conversationId);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  });
}

function directChatSessionRef(channel: string, conversationId: string): ExternalSessionRef {
  return {
    source: "direct-chat",
    scope: "conversation",
    externalSessionId: `${channel}:${conversationId}`,
  };
}

function toDirectChatSession(
  session: Awaited<ReturnType<AgentSessionStore["list"]>>[number],
  channel: string,
) {
  return {
    channel,
    conversationId: session.externalSession.externalSessionId.slice(channel.length + 1),
    externalSession: session.externalSession,
    agentSessionId: session.agentSessionId,
    codexThreadId: session.codexThreadId,
  };
}

async function listDirectChatSessionDetails(
  sessionStore: AgentSessionStore,
  sessionTraceStore: SessionTraceStore,
  channel: string,
) {
  const sessions = await sessionStore.list();
  const traces = await sessionTraceStore.list();
  const traceBySessionId = new Map(
    traces.map((trace) => [trace.agentSessionId, trace]),
  );

  return sessions
    .filter(
      (session) =>
        session.externalSession.source === "direct-chat" &&
        session.externalSession.scope === "conversation" &&
        session.externalSession.externalSessionId.startsWith(`${channel}:`),
    )
    .sort((a, b) => {
      const aTrace = traceBySessionId.get(a.agentSessionId);
      const bTrace = traceBySessionId.get(b.agentSessionId);
      const aTime = aTrace?.updatedAt ?? a.updatedAt;
      const bTime = bTrace?.updatedAt ?? b.updatedAt;
      return bTime.localeCompare(aTime);
    })
    .map((session) => ({
      session: toDirectChatSession(session, channel),
      trace: traceBySessionId.get(session.agentSessionId) ?? null,
    }));
}
