import {
  Codex,
  type ApprovalMode,
  type CodexOptions,
  type ModelReasoningEffort,
  type SandboxMode,
  type ThreadEvent,
  type ThreadItem,
  type Usage,
  type WebSearchMode,
} from "@openai/codex-sdk";
import type { EggTool } from "../tool/types";
import type { WorkspaceAccess } from "../types";

export type CodexToolEventStatus = "started" | "completed" | "failed";

export interface CodexRunRequest {
  prompt: string;
  threadId?: string;
  cwd?: string;
  workspaceAccess?: WorkspaceAccess;
  tools?: EggTool[];
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface CodexToolEvent {
  id: string;
  name: string;
  status: CodexToolEventStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export type CodexStreamEvent =
  | {
      type: "thread.started";
      threadId: string;
    }
  | {
      type: "turn.started";
    }
  | {
      type: "item.started" | "item.updated" | "item.completed";
      item: ThreadItem;
    }
  | {
      type: "message.delta";
      itemId: string;
      delta: string;
      text: string;
    }
  | {
      type: "tool_call";
      toolCall: CodexToolEvent;
    }
  | {
      type: "turn.completed";
      usage: Usage;
    }
  | {
      type: "turn.failed" | "error";
      message: string;
    };

export interface CodexRunResult {
  threadId: string;
  text: string;
  items: ThreadItem[];
  usage: Usage | null;
  toolCalls: CodexToolEvent[];
}

export interface CodexRunnerOptions {
  codexOptions?: CodexOptions;
  model?: string;
  workingDirectory?: string;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalMode;
  modelReasoningEffort?: ModelReasoningEffort;
  networkAccessEnabled?: boolean;
  webSearchMode?: WebSearchMode;
  webSearchEnabled?: boolean;
}

export type CodexStreamHandler = (
  event: CodexStreamEvent,
) => void | Promise<void>;

export class CodexRunner {
  private readonly codex: Codex;

  constructor(private readonly options: CodexRunnerOptions = {}) {
    this.codex = new Codex(options.codexOptions);
  }

  async run(request: CodexRunRequest): Promise<CodexRunResult> {
    const threadOptions = this.threadOptions(request);

    const thread = request.threadId
      ? this.codex.resumeThread(request.threadId, threadOptions)
      : this.codex.startThread(threadOptions);
    const turn = await thread.run(request.prompt, { signal: request.signal });
    const threadId = thread.id ?? request.threadId;

    if (!threadId) {
      throw new Error("Codex thread id is missing after run");
    }

    return {
      threadId,
      text: turn.finalResponse,
      items: turn.items,
      usage: turn.usage,
      toolCalls: extractToolCalls(turn.items),
    };
  }

  async runStreamed(
    request: CodexRunRequest,
    onEvent: CodexStreamHandler,
  ): Promise<CodexRunResult> {
    const threadOptions = this.threadOptions(request);
    const thread = request.threadId
      ? this.codex.resumeThread(request.threadId, threadOptions)
      : this.codex.startThread(threadOptions);
    const turn = await thread.runStreamed(request.prompt, { signal: request.signal });
    const items: ThreadItem[] = [];
    const textByMessageId = new Map<string, string>();
    let finalResponse = "";
    let usage: Usage | null = null;
    let threadId = request.threadId;

    for await (const event of turn.events) {
      const normalized = normalizeThreadEvent(event);
      await onEvent(normalized);

      if (event.type === "thread.started") {
        threadId = event.thread_id;
      }

      if (event.type === "item.started" || event.type === "item.updated") {
        if (event.item.type === "agent_message") {
          const previous = textByMessageId.get(event.item.id) ?? "";
          const current = event.item.text;
          textByMessageId.set(event.item.id, current);
          if (current.length > previous.length) {
            await onEvent({
              type: "message.delta",
              itemId: event.item.id,
              delta: current.slice(previous.length),
              text: current,
            });
          }
        }
      }

      if (event.type === "item.completed") {
        items.push(event.item);
        if (event.item.type === "agent_message") {
          const previous = textByMessageId.get(event.item.id) ?? "";
          const current = event.item.text;
          textByMessageId.set(event.item.id, current);
          if (current.length > previous.length) {
            await onEvent({
              type: "message.delta",
              itemId: event.item.id,
              delta: current.slice(previous.length),
              text: current,
            });
          }
          finalResponse = current;
        }

        for (const toolCall of extractToolCalls([event.item])) {
          await onEvent({
            type: "tool_call",
            toolCall,
          });
        }
      }

      if (event.type === "turn.completed") {
        usage = event.usage;
      }

      if (event.type === "turn.failed") {
        throw new Error(event.error.message);
      }

      if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    const finalThreadId = thread.id ?? threadId;
    if (!finalThreadId) {
      throw new Error("Codex thread id is missing after streamed run");
    }

    return {
      threadId: finalThreadId,
      text: finalResponse,
      items,
      usage,
      toolCalls: extractToolCalls(items),
    };
  }

  private threadOptions(request: CodexRunRequest) {
    return {
      model: this.options.model,
      workingDirectory:
        request.cwd ?? this.options.workingDirectory ?? process.cwd(),
      sandboxMode: request.workspaceAccess ?? this.options.sandboxMode ?? "read-only",
      skipGitRepoCheck: true,
      approvalPolicy: this.options.approvalPolicy ?? "never",
      modelReasoningEffort: this.options.modelReasoningEffort,
      networkAccessEnabled: this.options.networkAccessEnabled ?? false,
      webSearchMode: this.options.webSearchMode,
      webSearchEnabled: this.options.webSearchEnabled,
    };
  }
}

function extractToolCalls(items: ThreadItem[]): CodexToolEvent[] {
  return items.flatMap((item): CodexToolEvent[] => {
    switch (item.type) {
      case "command_execution":
        return [
          {
            id: item.id,
            name: "command_execution",
            status: mapRuntimeStatus(item.status),
            input: { command: item.command },
            output: {
              aggregatedOutput: item.aggregated_output,
              exitCode: item.exit_code,
            },
          },
        ];
      case "mcp_tool_call":
        return [
          {
            id: item.id,
            name: `${item.server}.${item.tool}`,
            status: mapRuntimeStatus(item.status),
            input: item.arguments,
            output: item.result,
            error: item.error?.message,
          },
        ];
      case "web_search":
        return [
          {
            id: item.id,
            name: "web_search",
            status: "completed",
            input: { query: item.query },
          },
        ];
      case "file_change":
        return [
          {
            id: item.id,
            name: "file_change",
            status: item.status,
            output: { changes: item.changes },
          },
        ];
      case "error":
        return [
          {
            id: item.id,
            name: "codex_error",
            status: "failed",
            error: item.message,
          },
        ];
      default:
        return [];
    }
  });
}

function normalizeThreadEvent(event: ThreadEvent): CodexStreamEvent {
  switch (event.type) {
    case "thread.started":
      return {
        type: "thread.started",
        threadId: event.thread_id,
      };
    case "turn.started":
      return { type: "turn.started" };
    case "item.started":
    case "item.updated":
    case "item.completed":
      return {
        type: event.type,
        item: event.item,
      };
    case "turn.completed":
      return {
        type: "turn.completed",
        usage: event.usage,
      };
    case "turn.failed":
      return {
        type: "turn.failed",
        message: event.error.message,
      };
    case "error":
      return {
        type: "error",
        message: event.message,
      };
  }
}

function mapRuntimeStatus(
  status: "in_progress" | "completed" | "failed",
): CodexToolEventStatus {
  if (status === "in_progress") return "started";
  return status;
}
