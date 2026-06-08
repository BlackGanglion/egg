import { FormEvent, useEffect, useRef, useState } from "react";
import { Bot, CircleStop, Plus, Send, User } from "lucide-react";
import { createDirectChatSession, listDirectChatSessions } from "../api";
import type {
  AgentResult,
  AgentCall,
  DirectChatSession,
  DirectChatSessionDetail,
  SessionTrace,
  ToolCall,
} from "../api";
import { readSseStream } from "../sse";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  body: string;
};

type RunEvent = {
  id: string;
  runtimeId?: string;
  label: string;
  status?: string;
  detail?: string;
};

type CodexItemPreview = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  query?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  changes?: Array<{
    path?: string;
    kind?: string;
  }>;
  items?: Array<{
    text?: string;
    completed?: boolean;
  }>;
};

type CodexToolCallPreview = {
  id?: string;
  name?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
};

type AgentCallPreview = Partial<AgentCall>;

export function ChatView() {
  const [session, setSession] = useState<DirectChatSession | null>(null);
  const [history, setHistory] = useState<DirectChatSessionDetail[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("idle");
  const controllerRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadHistory();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  async function loadHistory(selectedAgentSessionId?: string) {
    setStatus("loading");
    try {
      const details = await listDirectChatSessions();
      setHistory(details);

      const selected =
        details.find(
          (detail) =>
            detail.session?.agentSessionId === selectedAgentSessionId,
        ) ?? details[0];

      if (!selected?.session) {
        setSession(null);
        setMessages([]);
        setEvents([]);
        setStatus("no-session");
        return;
      }

      applySessionDetail(selected);
      setStatus("ready");
    } catch (err: unknown) {
      setSession(null);
      setMessages([]);
      setEvents([]);
      setStatus("error");
      console.error(err);
    }
  }

  async function newSession() {
    controllerRef.current?.abort();
    setStatus("creating");
    try {
      const next = await createDirectChatSession();
      const detail: DirectChatSessionDetail = {
        session: next,
        trace: emptyTrace(next.agentSessionId),
      };
      setHistory((prev) => [
        detail,
        ...prev.filter(
          (item) => item.session?.agentSessionId !== next.agentSessionId,
        ),
      ]);
      applySessionDetail(detail);
      setStatus("ready");
    } catch (err: unknown) {
      setStatus("error");
      console.error(err);
    }
  }

  function switchSession(detail: DirectChatSessionDetail) {
    if (!detail.session || status === "running") return;
    if (detail.session.agentSessionId === session?.agentSessionId) return;
    applySessionDetail(detail);
    setStatus("ready");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !session) return;

    const activeSession = session;
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setDraft("");
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", body },
      { id: assistantId, role: "assistant", body: "" },
    ]);
    touchHistoryMessages(activeSession.agentSessionId, [
      { id: userId, role: "user", body },
      { id: assistantId, role: "assistant", body: "" },
    ]);
    setEvents([]);
    setStatus("running");

    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      const res = await fetch("/api/direct-chat/messages/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          channel: session.channel,
          conversationId: session.conversationId,
          messageId: crypto.randomUUID(),
          body,
        }),
      });

      await readSseStream(res, ({ event, data }) => {
        if (event === "message.delta") {
          const payload = data as {
            event?: { itemId?: string; delta?: string; text?: string };
          };
          const delta = payload.event?.delta ?? "";
          if (delta) {
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? { ...message, body: message.body + delta }
                  : message,
              ),
            );
            appendHistoryMessageDelta(
                activeSession.agentSessionId,
                assistantId,
                delta,
              );
            upsertRunEvent({
              id: crypto.randomUUID(),
              runtimeId: payload.event?.itemId,
              label: "assistant message",
              status: "streaming",
              detail: payload.event?.text,
            });
          }
          return;
        }

        if (event === "tool_call") {
          const payload = data as {
            event?: { toolCall?: CodexToolCallPreview };
          };
          upsertRunEvent(eventFromToolCall(payload.event?.toolCall));
          return;
        }

        if (
          event === "agent_call.started" ||
          event === "agent_call.completed" ||
          event === "agent_call.failed"
        ) {
          const payload = data as { call?: AgentCallPreview };
          upsertRunEvent(eventFromAgentCall(event, payload.call));
          return;
        }

        if (event === "turn.completed") {
          upsertRunEvent({
            id: crypto.randomUUID(),
            runtimeId: "turn.completed",
            label: "turn completed",
            status: "completed",
          });
          return;
        }

        if (
          event === "item.started" ||
          event === "item.updated" ||
          event === "item.completed"
        ) {
          const payload = data as {
            event?: { item?: CodexItemPreview };
          };
          upsertRunEvent(eventFromCodexItem(event, payload.event?.item));
          return;
        }

        if (event === "done") {
          const payload = data as { result?: AgentResult };
          const result = payload.result;
          setSession((prev) =>
            prev
              ? { ...prev, codexThreadId: result?.data?.codexThreadId ?? prev.codexThreadId }
              : prev,
          );
          if (result?.message) {
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId && !message.body
                  ? { ...message, body: result.message }
                  : message,
              ),
            );
            replaceEmptyHistoryMessage(
              activeSession.agentSessionId,
              assistantId,
              result.message,
            );
          }
          setStatus("ready");
          void loadHistory(activeSession.agentSessionId);
          return;
        }

        if (event === "error") {
          const payload = data as { message?: string };
          throw new Error(payload.message ?? "Stream failed");
        }

        if (event !== "session" && event !== "turn.started") {
          upsertRunEvent({ id: crypto.randomUUID(), label: event });
        }
      });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setMessages((prev) =>
          prev.map((item) =>
            item.id === assistantId && !item.body ? { ...item, body: "Cancelled" } : item,
          ),
        );
        setStatus("cancelled");
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setMessages((prev) =>
        prev.map((item) => (item.id === assistantId ? { ...item, body: message } : item)),
      );
      replaceEmptyHistoryMessage(activeSession.agentSessionId, assistantId, message);
      setStatus("error");
    } finally {
      controllerRef.current = null;
    }
  }

  function stop() {
    controllerRef.current?.abort();
  }

  function upsertRunEvent(next: RunEvent) {
    setEvents((prev) => {
      if (!next.runtimeId) return [...prev, next];

      const index = prev.findIndex((event) => event.runtimeId === next.runtimeId);
      if (index < 0) return [...prev, next];

      const copy = [...prev];
      copy[index] = {
        ...copy[index],
        ...next,
        id: copy[index]!.id,
      };
      return copy;
    });
  }

  const isRunning = status === "running";
  const canSend = Boolean(session) && !isRunning && Boolean(draft.trim());
  const progressText = isRunning ? formatProgress(events) : "";

  return (
    <section className="chat-layout">
      <aside className="sidebar-panel">
        <div className="panel-title">
          <span>Session</span>
          <button className="primary-button" onClick={newSession} type="button">
            <Plus size={16} />
            New
          </button>
        </div>
        <dl className="meta-list">
          <dt>conversation</dt>
          <dd>{session?.conversationId ?? "-"}</dd>
          <dt>agent session</dt>
          <dd>{session?.agentSessionId ?? "-"}</dd>
          <dt>codex thread</dt>
          <dd>{session?.codexThreadId ?? "-"}</dd>
          <dt>status</dt>
          <dd>{status}</dd>
        </dl>
        <div className="history-section">
          <div className="section-label">History</div>
          <div className="history-list">
            {history.length ? (
              history.map((detail) => {
                const item = detail.session;
                if (!item) return null;
                const isActive = item.agentSessionId === session?.agentSessionId;
                return (
                  <button
                    className={`history-item${isActive ? " active" : ""}`}
                    disabled={status === "running"}
                    key={item.agentSessionId}
                    onClick={() => switchSession(detail)}
                    type="button"
                  >
                    <span className="history-item-title">
                      {historyTitle(detail)}
                    </span>
                    <span className="history-item-meta">
                      <span>{formatHistoryTime(detail)}</span>
                      <span>{detail.trace?.messages.length ?? 0} msgs</span>
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="empty-inline">No direct chat history</div>
            )}
          </div>
        </div>
        <div className="event-list">
          {events.length ? (
            events.map((event) => (
              <div className="event-row" key={event.id}>
                <div className="event-row-heading">
                  <span>{event.label}</span>
                  {event.status ? <b>{event.status}</b> : null}
                </div>
                {event.detail ? (
                  <pre className="event-detail">{event.detail}</pre>
                ) : null}
              </div>
            ))
          ) : (
            <div className="empty-inline">No runtime events</div>
          )}
        </div>
      </aside>
      <section className="chat-panel">
        <div className="panel-title">
          <span>Direct Chat</span>
          <span className="muted">{chatStatusLabel(status)}</span>
        </div>
        <div className="message-list">
          {messages.length ? (
            messages.map((message) => (
              <article className={`chat-message ${message.role}`} key={message.id}>
                <div className="avatar">
                  {message.role === "user" ? <User size={16} /> : <Bot size={16} />}
                </div>
                <div
                  className={`message-body${
                    message.role === "assistant" && !message.body && progressText
                      ? " progress"
                      : ""
                  }`}
                >
                  {message.body ||
                    (message.role === "assistant" ? progressText || "..." : "...")}
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state">
              {session ? "No messages" : "No session selected"}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <form className="composer" onSubmit={submit}>
          <textarea
            disabled={isRunning || !session}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={session ? "Message" : "Create a session first"}
            value={draft}
          />
          {isRunning ? (
            <button className="secondary-button" onClick={stop} type="button">
              <CircleStop size={16} />
              Stop
            </button>
          ) : (
            <button className="primary-button" disabled={!canSend} type="submit">
              <Send size={16} />
              Send
            </button>
          )}
        </form>
      </section>
    </section>
  );

  function applySessionDetail(detail: DirectChatSessionDetail) {
    setSession(detail.session);
    setMessages(traceToMessages(detail.trace));
    setEvents(traceToEvents(detail.trace));
    setDraft("");
  }

  function touchHistoryMessages(
    agentSessionId: string,
    nextMessages: ChatMessage[],
  ) {
    const now = new Date().toISOString();
    setHistory((prev) =>
      prev.map((detail) => {
        if (detail.session?.agentSessionId !== agentSessionId) return detail;
        const trace = detail.trace ?? emptyTrace(agentSessionId, now);
        return {
          ...detail,
          trace: {
            ...trace,
            messages: [
              ...trace.messages,
              ...nextMessages.map((message) => ({
                ...message,
                createdAt: now,
              })),
            ],
            updatedAt: now,
          },
        };
      }),
    );
  }

  function appendHistoryMessageDelta(
    agentSessionId: string,
    messageId: string,
    delta: string,
  ) {
    updateHistoryMessage(agentSessionId, messageId, (body) => body + delta);
  }

  function replaceEmptyHistoryMessage(
    agentSessionId: string,
    messageId: string,
    body: string,
  ) {
    updateHistoryMessage(agentSessionId, messageId, (current) => current || body);
  }

  function updateHistoryMessage(
    agentSessionId: string,
    messageId: string,
    updateBody: (body: string) => string,
  ) {
    const now = new Date().toISOString();
    setHistory((prev) =>
      prev.map((detail) => {
        if (!detail.trace || detail.session?.agentSessionId !== agentSessionId) {
          return detail;
        }
        return {
          ...detail,
          trace: {
            ...detail.trace,
            messages: detail.trace.messages.map((message) =>
              message.id === messageId
                ? { ...message, body: updateBody(message.body) }
                : message,
            ),
            updatedAt: now,
          },
        };
      }),
    );
  }
}

function chatStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Streaming";
    case "ready":
      return "Ready";
    case "loading":
      return "Loading";
    case "creating":
      return "Creating";
    case "cancelled":
      return "Cancelled";
    case "error":
      return "Error";
    case "no-session":
      return "No session";
    default:
      return "Idle";
  }
}

function traceToMessages(trace: SessionTrace | null): ChatMessage[] {
  return (trace?.messages ?? []).flatMap((message): ChatMessage[] => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    return [{
      id: message.id,
      role: message.role,
      body: message.body,
    }];
  });
}

function traceToEvents(trace: SessionTrace | null): RunEvent[] {
  return [
    ...(trace?.agentCalls ?? []).map((agentCall) => ({
      id: agentCall.id,
      runtimeId: agentCall.id,
      label: `${agentCall.parentAgent} -> ${agentCall.childAgent}`,
      status: agentCall.status,
      detail: formatStoredAgentCall(agentCall),
      time: agentCall.completedAt ?? agentCall.startedAt,
    })),
    ...(trace?.toolCalls ?? []).map((toolCall) => ({
      id: toolCall.id,
      runtimeId: toolCall.id,
      label: toolCall.name,
      status: toolCall.status,
      detail: formatStoredToolCall(toolCall),
      time: toolCall.completedAt ?? toolCall.startedAt,
    })),
  ]
    .sort((a, b) => a.time.localeCompare(b.time))
    .map(({ time: _time, ...event }) => event);
}

function emptyTrace(agentSessionId: string, timestamp = new Date().toISOString()): SessionTrace {
  return {
    agentSessionId,
    messages: [],
    toolCalls: [],
    agentCalls: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function historyTitle(detail: DirectChatSessionDetail): string {
  const lastMessage = detail.trace?.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .at(-1);
  const title = lastMessage?.body.trim() || detail.session?.conversationId || "Untitled";
  return title.length > 48 ? `${title.slice(0, 48)}...` : title;
}

function formatHistoryTime(detail: DirectChatSessionDetail): string {
  const value = detail.trace?.updatedAt;
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function eventFromCodexItem(
  eventName: string,
  item: CodexItemPreview | undefined,
): RunEvent {
  return {
    id: crypto.randomUUID(),
    runtimeId: item?.id,
    label: describeCodexItem(item),
    status: item?.status ?? eventName.slice("item.".length),
    detail: detailFromCodexItem(item),
  };
}

function eventFromToolCall(toolCall: CodexToolCallPreview | undefined): RunEvent {
  return {
    id: crypto.randomUUID(),
    runtimeId: toolCall?.id,
    label: toolCall?.name ?? "tool call",
    status: toolCall?.status,
    detail: detailFromToolCall(toolCall),
  };
}

function eventFromAgentCall(
  eventName: string,
  call: AgentCallPreview | undefined,
): RunEvent {
  return {
    id: crypto.randomUUID(),
    runtimeId: call?.id,
    label:
      call?.parentAgent && call.childAgent
        ? `${call.parentAgent} -> ${call.childAgent}`
        : "agent call",
    status: call?.status ?? eventName.slice("agent_call.".length),
    detail: detailFromAgentCall(call),
  };
}

function describeCodexItem(item: CodexItemPreview | undefined): string {
  if (!item?.type) return "item";

  if (item.type === "command_execution") {
    return item.command ? `command: ${truncate(item.command, 56)}` : "command";
  }

  if (item.type === "web_search") {
    return item.query ? `web_search: ${truncate(item.query, 56)}` : "web_search";
  }

  if (item.type === "mcp_tool_call") {
    return item.server && item.tool ? `${item.server}.${item.tool}` : "mcp tool";
  }

  if (item.type === "agent_message") return "assistant message";
  if (item.type === "reasoning") return "reasoning summary";
  if (item.type === "todo_list") return "todo list";
  if (item.type === "file_change") return "file change";
  if (item.type === "error") return "error";

  return item.type;
}

function detailFromCodexItem(item: CodexItemPreview | undefined): string | undefined {
  if (!item?.type) return undefined;

  if (item.type === "agent_message" || item.type === "reasoning") {
    return truncateBlock(item.text);
  }

  if (item.type === "command_execution") {
    return compactLines([
      item.command ? `command: ${item.command}` : undefined,
      item.aggregated_output
        ? `output:\n${truncateBlock(item.aggregated_output)}`
        : undefined,
      typeof item.exit_code === "number" ? `exit: ${item.exit_code}` : undefined,
    ]);
  }

  if (item.type === "web_search") {
    return item.query ? `query: ${item.query}` : undefined;
  }

  if (item.type === "mcp_tool_call") {
    return compactLines([
      item.arguments === undefined
        ? undefined
        : `arguments:\n${formatUnknown(item.arguments)}`,
      item.result === undefined ? undefined : `result:\n${formatUnknown(item.result)}`,
      item.error === undefined ? undefined : `error:\n${formatUnknown(item.error)}`,
    ]);
  }

  if (item.type === "todo_list") {
    const lines = item.items?.map((todo) =>
      `${todo.completed ? "[x]" : "[ ]"} ${todo.text ?? ""}`,
    );
    return lines?.length ? lines.join("\n") : undefined;
  }

  if (item.type === "file_change") {
    const lines = item.changes?.map((change) =>
      `${change.kind ?? "change"} ${change.path ?? ""}`.trim(),
    );
    return lines?.length ? lines.join("\n") : undefined;
  }

  if (item.type === "error") {
    return formatUnknown(item.error ?? item);
  }

  return formatUnknown(item);
}

function detailFromToolCall(toolCall: CodexToolCallPreview | undefined): string | undefined {
  if (!toolCall) return undefined;

  return compactLines([
    toolCall.input === undefined ? undefined : `input:\n${formatUnknown(toolCall.input)}`,
    toolCall.output === undefined ? undefined : `output:\n${formatUnknown(toolCall.output)}`,
    toolCall.error ? `error:\n${toolCall.error}` : undefined,
  ]);
}

function detailFromAgentCall(call: AgentCallPreview | undefined): string | undefined {
  if (!call) return undefined;

  return compactLines([
    call.mode ? `mode: ${call.mode}` : undefined,
    call.taskType ? `task: ${call.taskType}` : undefined,
    call.input === undefined ? undefined : `input:\n${formatUnknown(call.input)}`,
    call.output === undefined ? undefined : `output:\n${formatUnknown(call.output)}`,
    call.error ? `error:\n${call.error}` : undefined,
  ]);
}

function formatStoredToolCall(toolCall: ToolCall): string | undefined {
  return compactLines([
    toolCall.input === undefined ? undefined : `input:\n${formatUnknown(toolCall.input)}`,
    toolCall.output === undefined ? undefined : `output:\n${formatUnknown(toolCall.output)}`,
    toolCall.error ? `error:\n${toolCall.error}` : undefined,
  ]);
}

function formatStoredAgentCall(agentCall: AgentCall): string | undefined {
  return compactLines([
    `mode: ${agentCall.mode}`,
    `task: ${agentCall.taskType}`,
    agentCall.input === undefined ? undefined : `input:\n${formatUnknown(agentCall.input)}`,
    agentCall.output === undefined ? undefined : `output:\n${formatUnknown(agentCall.output)}`,
    agentCall.error ? `error:\n${agentCall.error}` : undefined,
  ]);
}

function formatProgress(events: RunEvent[]): string {
  const recent = events
    .filter((event) => event.label !== "turn completed")
    .slice(-5)
    .map((event) =>
      compactLines([
        event.status ? `${event.label} ${event.status}` : event.label,
        firstDetailLine(event.detail),
      ])!,
    );

  return recent.length ? recent.join("\n") : "processing";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function truncateBlock(value: string | undefined, maxLength = 1600): string | undefined {
  if (!value) return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function compactLines(lines: Array<string | undefined>): string | undefined {
  const compacted = lines.filter((line): line is string => Boolean(line?.trim()));
  return compacted.length ? compacted.join("\n") : undefined;
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return truncateBlock(value) ?? "";
  if (value === undefined) return "";

  try {
    return truncateBlock(JSON.stringify(value, null, 2)) ?? "";
  } catch {
    return truncateBlock(String(value)) ?? "";
  }
}

function firstDetailLine(detail: string | undefined): string | undefined {
  const firstLine = detail?.split("\n").find((line) => line.trim());
  return firstLine ? `  ${truncate(firstLine, 72)}` : undefined;
}
