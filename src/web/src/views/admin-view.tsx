import { useEffect, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import {
  deleteSession,
  getSessionDetail,
  listSessions,
} from "../api";
import type { AdminSession, SessionTrace } from "../api";

export function AdminView() {
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [activeId, setActiveId] = useState("");
  const [activeSession, setActiveSession] = useState<AdminSession | null>(null);
  const [trace, setTrace] = useState<SessionTrace | null>(null);
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(preferredId = activeId) {
    setStatus("loading");
    const items = await listSessions();
    setSessions(items);
    const nextId =
      (preferredId && items.some((item) => item.agentSessionId === preferredId)
        ? preferredId
        : items[0]?.agentSessionId) || "";
    if (nextId) await loadDetail(nextId);
    else {
      setActiveSession(null);
      setTrace(null);
      setStatus("ready");
    }
  }

  async function loadDetail(agentSessionId: string) {
    setActiveId(agentSessionId);
    setStatus("loading");
    const detail = await getSessionDetail(agentSessionId);
    setActiveSession(detail.session);
    setTrace(detail.trace);
    setStatus("ready");
  }

  async function remove(agentSessionId: string) {
    if (!window.confirm("Delete this session?")) return;
    await deleteSession(agentSessionId);
    const deletingActive = activeId === agentSessionId;
    if (deletingActive) {
      setActiveId("");
      setActiveSession(null);
      setTrace(null);
    }
    await refresh(deletingActive ? "" : activeId);
  }

  return (
    <section className="admin-layout">
      <aside className="session-list-panel">
        <div className="panel-title">
          <span>Sessions</span>
          <button className="secondary-button" onClick={() => void refresh()} type="button">
            <RefreshCw size={16} />
            Refresh
          </button>
        </div>
        <div className="session-list">
          {sessions.length ? (
            sessions.map((session) => (
              <div
                className={`session-list-item ${
                  session.agentSessionId === activeId ? "active" : ""
                }`}
                key={session.agentSessionId}
              >
                <button onClick={() => loadDetail(session.agentSessionId)} type="button">
                  <strong>{session.agentSessionId}</strong>
                  <span>{session.externalSession.source} / {session.externalSession.scope}</span>
                  <span>{session.externalSession.externalSessionId}</span>
                  <small>{session.messageCount} messages · {session.toolCallCount} tools</small>
                </button>
                <button
                  className="danger-icon"
                  onClick={() => remove(session.agentSessionId)}
                  title="Delete"
                  type="button"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          ) : (
            <div className="empty-state">No sessions</div>
          )}
        </div>
      </aside>
      <section className="detail-panel">
        <div className="panel-title">
          <span>Session Trace</span>
          <span className="muted">{status}</span>
        </div>
        {activeSession ? (
          <div className="detail-grid">
            <section className="trace-messages">
              {(trace?.messages ?? []).map((message) => (
                <article className={`trace-message ${message.role}`} key={message.id}>
                  <header>
                    <b>{message.role}</b>
                    <span>{formatTime(message.createdAt)}</span>
                  </header>
                  <p>{message.body}</p>
                </article>
              ))}
            </section>
            <aside className="trace-side">
              <dl className="meta-list">
                <dt>source</dt>
                <dd>{activeSession.externalSession.source}</dd>
                <dt>scope</dt>
                <dd>{activeSession.externalSession.scope}</dd>
                <dt>external</dt>
                <dd>{activeSession.externalSession.externalSessionId}</dd>
                <dt>codex</dt>
                <dd>{activeSession.codexThreadId ?? "-"}</dd>
                <dt>turns</dt>
                <dd>{activeSession.turns.length}</dd>
              </dl>
              <div className="tool-list">
                {(trace?.toolCalls ?? []).map((tool) => (
                  <details className="tool-card" key={tool.id}>
                    <summary>
                      <b>{tool.name}</b>
                      <span>{tool.status}</span>
                    </summary>
                    <pre>{JSON.stringify({ input: tool.input, output: tool.output, error: tool.error }, null, 2)}</pre>
                  </details>
                ))}
              </div>
            </aside>
          </div>
        ) : (
          <div className="empty-state">No session selected</div>
        )}
      </section>
    </section>
  );
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}
