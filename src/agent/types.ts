import type { EggTool } from "./tool/types";

export type AgentTaskType =
  | "linear.issue.triage"
  | "linear.session.prompt"
  | "direct-chat.message"
  | (string & {});

export type ExternalSessionSource = "linear" | "direct-chat" | (string & {});

export type ExternalSessionScope =
  | "issue"
  | "agent-session"
  | "conversation"
  | (string & {});

export interface ExternalSessionRef {
  source: ExternalSessionSource;
  scope: ExternalSessionScope;
  externalSessionId: string;
  externalTurnId?: string;
}

export interface AgentTask<TInput extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  type: AgentTaskType;
  input: TInput;
  intent?: string;
  capabilities?: string[];
  externalSession?: ExternalSessionRef;
  metadata?: Record<string, unknown>;
}

export type AgentResultStatus = "completed" | "failed" | "skipped" | "needs_input";

export interface AgentResult<TData = unknown> {
  status: AgentResultStatus;
  message: string;
  data?: TData;
  commands?: AgentWriteCommand[];
}

export type AgentWriteCommand = LinearWriteCommand | ChatWriteCommand;

export interface LinearWriteCommand {
  target: "linear";
  kind: "activity" | "issue-update" | "comment";
  issueId?: string;
  agentSessionId?: string;
  body?: string;
  payload?: Record<string, unknown>;
}

export interface ChatWriteCommand {
  target: "direct-chat";
  conversationId: string;
  body: string;
  payload?: Record<string, unknown>;
}

export interface AgentDispatchContext {
  externalSession?: ExternalSessionRef;
  agentSessionId?: string;
  codexThreadId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface SubAgentDispatchContext
  extends Omit<AgentDispatchContext, "codexThreadId"> {
  subAgentName?: string;
}

export type WorkspaceAccess = "read-only" | "workspace-write" | "danger-full-access";

export interface SubAgentWorkspace {
  workspacePath: string;
  promptPath?: string;
  stablePromptPath?: string;
  mutablePromptPath?: string;
  evalsPath?: string;
  notesPath?: string;
  access: WorkspaceAccess;
}

export interface SubAgent {
  name: string;
  description: string;
  capabilities: string[];
  workspace?: SubAgentWorkspace;
  canHandle(task: AgentTask): boolean;
  asTool(): EggTool;
  invoke(task: AgentTask, context: SubAgentDispatchContext): Promise<AgentResult>;
}
