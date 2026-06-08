import type { AgentTask, SubAgentDispatchContext } from "../types";

export interface ToolExecutionContext {
  task: AgentTask;
  dispatchContext?: SubAgentDispatchContext;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface EggToolResult {
  content: ToolTextContent[];
  details?: unknown;
}

export interface EggTool<TParams = unknown, TResult = EggToolResult> {
  name: string;
  description: string;
  parameters: unknown;
  execute(params: TParams, context: ToolExecutionContext): Promise<TResult>;
}
