import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type TraceMessageRole = "user" | "assistant" | "system";
export type ToolCallStatus = "started" | "completed" | "failed";

export interface TraceMessageRecord {
  id: string;
  role: TraceMessageRole;
  body: string;
  createdAt: string;
  turnId?: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  status: ToolCallStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
  turnId?: string;
}

export interface SessionTraceRecord {
  agentSessionId: string;
  messages: TraceMessageRecord[];
  toolCalls: ToolCallRecord[];
  createdAt: string;
  updatedAt: string;
}

export class SessionTraceStore {
  private loaded = false;
  private readonly traces = new Map<string, SessionTraceRecord>();

  constructor(private readonly sessionsRoot: string) {}

  async ensureSession(agentSessionId: string): Promise<SessionTraceRecord> {
    await this.load();

    const existing = this.traces.get(agentSessionId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const trace: SessionTraceRecord = {
      agentSessionId,
      messages: [],
      toolCalls: [],
      createdAt: now,
      updatedAt: now,
    };
    this.traces.set(agentSessionId, trace);
    await this.writeTrace(trace);
    return trace;
  }

  async appendMessage(input: {
    agentSessionId: string;
    role: TraceMessageRole;
    body: string;
    turnId?: string;
  }): Promise<TraceMessageRecord> {
    const trace = await this.ensureSession(input.agentSessionId);
    const message: TraceMessageRecord = {
      id: randomUUID(),
      role: input.role,
      body: input.body,
      turnId: input.turnId,
      createdAt: new Date().toISOString(),
    };
    trace.messages.push(message);
    trace.updatedAt = message.createdAt;
    await this.writeTrace(trace);
    return message;
  }

  async recordToolCall(input: {
    agentSessionId: string;
    name: string;
    status: ToolCallStatus;
    toolInput?: unknown;
    output?: unknown;
    error?: string;
    turnId?: string;
  }): Promise<ToolCallRecord> {
    const trace = await this.ensureSession(input.agentSessionId);
    const now = new Date().toISOString();
    const toolCall: ToolCallRecord = {
      id: randomUUID(),
      name: input.name,
      status: input.status,
      input: input.toolInput,
      output: input.output,
      error: input.error,
      turnId: input.turnId,
      startedAt: now,
      completedAt: input.status === "started" ? undefined : now,
    };
    trace.toolCalls.push(toolCall);
    trace.updatedAt = now;
    await this.writeTrace(trace);
    return toolCall;
  }

  async list(): Promise<SessionTraceRecord[]> {
    await this.load();
    return [...this.traces.values()].map((trace) => this.clone(trace));
  }

  async get(agentSessionId: string): Promise<SessionTraceRecord | undefined> {
    await this.load();
    const trace = this.traces.get(agentSessionId);
    return trace ? this.clone(trace) : undefined;
  }

  async delete(agentSessionId: string): Promise<boolean> {
    await this.load();
    const deleted = this.traces.delete(agentSessionId);
    await rm(this.traceFile(agentSessionId), { force: true });
    return deleted;
  }

  private clone(trace: SessionTraceRecord): SessionTraceRecord {
    return {
      ...trace,
      messages: [...trace.messages],
      toolCalls: [...trace.toolCalls],
    };
  }

  private sessionDir(agentSessionId: string): string {
    return join(this.sessionsRoot, agentSessionId);
  }

  private traceFile(agentSessionId: string): string {
    return join(this.sessionDir(agentSessionId), "trace.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    let entries: string[];
    try {
      entries = await readdir(this.sessionsRoot);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
      throw err;
    }

    for (const entry of entries) {
      try {
        const raw = await readFile(this.traceFile(entry), "utf8");
        const trace = JSON.parse(raw) as SessionTraceRecord;
        this.traces.set(trace.agentSessionId, trace);
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") continue;
        throw err;
      }
    }
  }

  private async writeTrace(trace: SessionTraceRecord): Promise<void> {
    await mkdir(this.sessionDir(trace.agentSessionId), { recursive: true });
    await writeFile(
      this.traceFile(trace.agentSessionId),
      `${JSON.stringify(trace, null, 2)}\n`,
      "utf8",
    );
  }
}
