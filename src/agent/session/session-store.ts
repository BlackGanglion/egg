import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExternalSessionRef } from "../types";

export interface AgentTurnRecord {
  agentTurnId: string;
  externalTurnId?: string;
  createdAt: string;
}

export interface AgentSessionRecord {
  externalSession: ExternalSessionRef;
  agentSessionId: string;
  codexThreadId?: string;
  turns: AgentTurnRecord[];
  createdAt: string;
  updatedAt: string;
}

export class AgentSessionStore {
  private loaded = false;
  private readonly records = new Map<string, AgentSessionRecord>();

  constructor(private readonly sessionsRoot: string) {}

  async getOrCreate(externalSession: ExternalSessionRef): Promise<AgentSessionRecord> {
    await this.load();

    const key = this.keyOf(externalSession);
    const existing = this.records.get(key);
    if (existing) return existing;

    const now = new Date().toISOString();
    const record: AgentSessionRecord = {
      externalSession,
      agentSessionId: randomUUID(),
      turns: [],
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(key, record);
    await this.writeRecord(record);
    return record;
  }

  async bindCodexThread(agentSessionId: string, codexThreadId: string): Promise<void> {
    await this.load();

    const record = this.findRecord(agentSessionId);
    if (!record) throw new Error(`Agent session not found: ${agentSessionId}`);

    record.codexThreadId = codexThreadId;
    record.updatedAt = new Date().toISOString();
    await this.writeRecord(record);
  }

  async list(): Promise<AgentSessionRecord[]> {
    await this.load();
    return [...this.records.values()].map((record) => this.clone(record));
  }

  async findByAgentSessionId(agentSessionId: string): Promise<AgentSessionRecord | undefined> {
    await this.load();
    const record = this.findRecord(agentSessionId);
    return record ? this.clone(record) : undefined;
  }

  async deleteByAgentSessionId(agentSessionId: string): Promise<boolean> {
    await this.load();

    for (const [key, record] of this.records.entries()) {
      if (record.agentSessionId !== agentSessionId) continue;
      this.records.delete(key);
      await rm(this.sessionDir(agentSessionId), { recursive: true, force: true });
      return true;
    }

    return false;
  }

  async recordTurn(
    externalSession: ExternalSessionRef,
    externalTurnId?: string,
  ): Promise<AgentTurnRecord> {
    const session = await this.getOrCreate(externalSession);
    const existing = externalTurnId
      ? session.turns.find((turn) => turn.externalTurnId === externalTurnId)
      : undefined;
    if (existing) return existing;

    const turn: AgentTurnRecord = {
      agentTurnId: randomUUID(),
      externalTurnId,
      createdAt: new Date().toISOString(),
    };
    session.turns.push(turn);
    session.updatedAt = turn.createdAt;
    await this.writeRecord(session);
    return turn;
  }

  private findRecord(agentSessionId: string): AgentSessionRecord | undefined {
    return [...this.records.values()].find((record) => record.agentSessionId === agentSessionId);
  }

  private clone(record: AgentSessionRecord): AgentSessionRecord {
    return {
      ...record,
      externalSession: { ...record.externalSession },
      turns: [...record.turns],
    };
  }

  private keyOf(ref: ExternalSessionRef): string {
    return `${ref.source}:${ref.scope}:${ref.externalSessionId}`;
  }

  private sessionDir(agentSessionId: string): string {
    return join(this.sessionsRoot, agentSessionId);
  }

  private sessionFile(agentSessionId: string): string {
    return join(this.sessionDir(agentSessionId), "session.json");
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
        const raw = await readFile(this.sessionFile(entry), "utf8");
        const record = JSON.parse(raw) as AgentSessionRecord;
        this.records.set(this.keyOf(record.externalSession), record);
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") continue;
        throw err;
      }
    }
  }

  private async writeRecord(record: AgentSessionRecord): Promise<void> {
    await mkdir(this.sessionDir(record.agentSessionId), { recursive: true });
    await writeFile(
      this.sessionFile(record.agentSessionId),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }
}
