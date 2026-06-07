import { useEffect, useMemo, useState } from "react";
import { Activity, MessageSquare, RefreshCw, ServerCog } from "lucide-react";
import { AdminView } from "./views/admin-view";
import { ChatView } from "./views/chat-view";

type View = "chat" | "admin";

export function App() {
  const [view, setView] = useState<View>(() =>
    window.location.pathname.startsWith("/admin") ? "admin" : "chat",
  );

  const title = useMemo(() => (view === "admin" ? "Admin" : "Direct Chat"), [view]);

  useEffect(() => {
    function syncPath() {
      setView(window.location.pathname.startsWith("/admin") ? "admin" : "chat");
    }

    window.addEventListener("popstate", syncPath);
    return () => window.removeEventListener("popstate", syncPath);
  }, []);

  function navigate(next: View) {
    setView(next);
    window.history.pushState(null, "", next === "admin" ? "/admin" : "/chat");
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <ServerCog size={18} />
          <span>Egg</span>
          <span className="title-separator">/</span>
          <span className="muted">{title}</span>
        </div>
        <nav className="nav-tabs" aria-label="Main">
          <button
            className={view === "chat" ? "active" : ""}
            onClick={() => navigate("chat")}
            type="button"
          >
            <MessageSquare size={16} />
            Chat
          </button>
          <button
            className={view === "admin" ? "active" : ""}
            onClick={() => navigate("admin")}
            type="button"
          >
            <Activity size={16} />
            Admin
          </button>
        </nav>
        <button
          className="icon-button"
          onClick={() => window.location.reload()}
          title="Reload"
          type="button"
        >
          <RefreshCw size={16} />
        </button>
      </header>
      <main className="app-main">{view === "admin" ? <AdminView /> : <ChatView />}</main>
    </div>
  );
}
