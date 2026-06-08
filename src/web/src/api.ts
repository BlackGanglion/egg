export interface DirectChatSession {
  channel: string;
  conversationId: string;
  agentSessionId: string;
  codexThreadId?: string;
}

export interface AgentResult {
  status: "completed" | "failed" | "skipped" | "needs_input";
  message: string;
  data?: {
    agentSessionId?: string;
    codexThreadId?: string;
    conversationId?: string;
    channel?: string;
    [key: string]: unknown;
  };
}

export interface AdminSession {
  externalSession: {
    source: string;
    scope: string;
    externalSessionId: string;
    externalTurnId?: string;
  };
  agentSessionId: string;
  codexThreadId?: string;
  turns: Array<{
    agentTurnId: string;
    externalTurnId?: string;
    createdAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  toolCallCount: number;
  agentCallCount: number;
  lastMessageAt?: string;
}

export interface TraceMessage {
  id: string;
  role: "user" | "assistant" | "system";
  body: string;
  createdAt: string;
  turnId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  status: "started" | "completed" | "failed";
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
  turnId?: string;
}

export interface AgentCall {
  id: string;
  parentAgent: string;
  childAgent: string;
  mode: "main-dispatch" | "tool-decision";
  status: "started" | "completed" | "failed" | "skipped" | "needs_input";
  taskType: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
  turnId?: string;
}

export interface SessionTrace {
  agentSessionId: string;
  messages: TraceMessage[];
  toolCalls: ToolCall[];
  agentCalls: AgentCall[];
  createdAt: string;
  updatedAt: string;
}

export interface DirectChatSessionDetail {
  session: DirectChatSession | null;
  trace: SessionTrace | null;
}

export async function createDirectChatSession(): Promise<DirectChatSession> {
  const res = await fetch("/api/direct-chat/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "web" }),
  });
  return assertJson<DirectChatSession>(res);
}

export async function getLatestDirectChatSession(
  channel = "web",
): Promise<DirectChatSessionDetail> {
  const params = new URLSearchParams({ channel });
  const res = await fetch(`/api/direct-chat/sessions/latest?${params.toString()}`);
  return assertJson<DirectChatSessionDetail>(res);
}

export async function listDirectChatSessions(
  channel = "web",
): Promise<DirectChatSessionDetail[]> {
  const params = new URLSearchParams({ channel });
  const res = await fetch(`/api/direct-chat/sessions?${params.toString()}`);
  const data = await assertJson<{ sessions: DirectChatSessionDetail[] }>(res);
  return data.sessions;
}

export async function listSessions(): Promise<AdminSession[]> {
  const res = await fetch("/api/admin/sessions");
  const data = await assertJson<{ sessions: AdminSession[] }>(res);
  return data.sessions;
}

export async function getSessionDetail(agentSessionId: string): Promise<{
  session: AdminSession;
  trace: SessionTrace | null;
}> {
  const res = await fetch(`/api/admin/sessions/${encodeURIComponent(agentSessionId)}`);
  return assertJson(res);
}

export async function deleteSession(agentSessionId: string): Promise<void> {
  const res = await fetch(`/api/admin/sessions/${encodeURIComponent(agentSessionId)}`, {
    method: "DELETE",
  });
  await assertJson(res);
}

async function assertJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => undefined);
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}
