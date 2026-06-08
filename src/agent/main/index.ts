import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AgentDispatchContext,
  AgentResult,
  AgentResultStatus,
  AgentTask,
  SubAgentDispatchContext,
} from "../types";
import type { AgentRegistry } from "../registry";
import type {
  AgentCallRecord,
  AgentCallMode,
  AgentCallStatus,
  SessionTraceStore,
} from "../session/session-trace-store";
import type { AgentSessionStore } from "../session/session-store";
import type { CodexRunner, CodexStreamEvent } from "../runtime/codex-runner";
import type { EggTool, EggToolResult } from "../tool/types";

const MAIN_AGENT_PROMPT_PATH = resolve(process.cwd(), "prompts/main-agent.md");

interface DirectChatInput {
  channel?: unknown;
  conversationId?: unknown;
  body?: unknown;
}

interface DirectChatToolDecision {
  action: "answer" | "tool";
  toolName?: string;
  toolInput?: Record<string, unknown>;
  reason?: string;
}

interface DirectChatToolRun {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  result: EggToolResult;
}

interface StreamAgentCall {
  id: string;
  parentAgent: string;
  childAgent: string;
  mode: AgentCallMode;
  status: AgentCallStatus;
  taskType: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  turnId?: string;
}

export interface MainAgentDependencies {
  sessionTraceStore?: SessionTraceStore;
  codexRunner?: CodexRunner;
  sessionStore?: AgentSessionStore;
}

export type MainAgentStreamEvent =
  | {
      type: "codex";
      event: CodexStreamEvent;
    }
  | {
      type: "agent_call.started" | "agent_call.completed" | "agent_call.failed";
      call: StreamAgentCall;
    }
  | {
      type: "done";
      result: AgentResult;
    }
  | {
      type: "error";
      message: string;
    };

export type MainAgentStreamHandler = (
  event: MainAgentStreamEvent,
) => void | Promise<void>;

export class MainAgent {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly dependencies: MainAgentDependencies = {},
  ) {}

  async dispatch(
    task: AgentTask,
    context: AgentDispatchContext = {},
  ): Promise<AgentResult> {
    if (task.type === "direct-chat.message") {
      return this.handleDirectChat(task, context);
    }

    const candidates = this.registry.findForTask(task);
    if (candidates.length === 0) {
      return {
        status: "failed",
        message: `Main agent cannot handle task type: ${task.type}`,
        data: { taskId: task.id, requestedCapabilities: task.capabilities ?? [] },
      };
    }

    const agent = candidates[0]!;
    const agentCall = await this.startSubAgentCall({
      childAgent: agent.name,
      mode: "main-dispatch",
      task,
      context,
      callInput: task.input,
    });

    try {
      const result = await agent.invoke(task, toSubAgentContext(agent.name, context));
      await this.finishSubAgentCall(agentCall, context, result.status, result);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.finishSubAgentCall(agentCall, context, "failed", undefined, message);
      return {
        status: "failed",
        message: `Sub-agent ${agent.name} failed: ${message}`,
        data: { taskId: task.id, agent: agent.name },
      };
    }
  }

  async dispatchStream(
    task: AgentTask,
    context: AgentDispatchContext = {},
    onEvent: MainAgentStreamHandler,
  ): Promise<AgentResult> {
    if (task.type === "direct-chat.message") {
      return this.handleDirectChat(task, context, onEvent);
    }

    const result = await this.dispatch(task, context);
    return result;
  }

  private async handleDirectChat(
    task: AgentTask,
    context: AgentDispatchContext,
    onEvent?: MainAgentStreamHandler,
  ): Promise<AgentResult> {
    const { sessionTraceStore, codexRunner, sessionStore } = this.dependencies;
    if (!sessionTraceStore || !codexRunner || !sessionStore) {
      return {
        status: "failed",
        message: "Direct chat runtime is not configured on MainAgent",
      };
    }

    if (!context.agentSessionId) {
      return {
        status: "failed",
        message: "Missing agentSessionId for direct chat task",
      };
    }

    const input = task.input as DirectChatInput;
    const body = typeof input.body === "string" ? input.body.trim() : "";
    const channel = typeof input.channel === "string" ? input.channel : "web";
    const conversationId =
      typeof input.conversationId === "string" ? input.conversationId : "unknown";

    if (!body) {
      return {
        status: "failed",
        message: "Direct chat message body is empty",
      };
    }

    await sessionTraceStore.appendMessage({
      agentSessionId: context.agentSessionId,
      role: "user",
      body,
      turnId: task.id,
    });

    let finalPrompt = "";

    try {
      const tools = this.registry.asTools();
      const toolDecision = await this.decideDirectChatTool(
        task,
        context,
        { body, channel, conversationId },
        tools,
      );
      const toolRun =
        toolDecision.action === "tool"
          ? await this.executeDirectChatToolDecision(
              task,
              context,
              toolDecision,
              tools,
              onEvent,
            )
          : undefined;
      finalPrompt = await buildDirectChatPrompt({
        body,
        channel,
        conversationId,
        tools,
        toolRun,
      });
      const runRequest = {
        prompt: finalPrompt,
        threadId: context.codexThreadId,
        signal: context.signal,
        metadata: {
          agentSessionId: context.agentSessionId,
          externalSession: context.externalSession,
        },
      };
      const runResult = onEvent
        ? await codexRunner.runStreamed(runRequest, async (event) => {
            await onEvent({ type: "codex", event });
          })
        : await codexRunner.run(runRequest);

      if (runResult.threadId !== context.codexThreadId) {
        await sessionStore.bindCodexThread(
          context.agentSessionId,
          runResult.threadId,
        );
      }

      await sessionTraceStore.recordToolCall({
        agentSessionId: context.agentSessionId,
        name: "codex_run",
        status: "completed",
        toolInput: {
          codexThreadId: context.codexThreadId,
          promptLength: finalPrompt.length,
        },
        output: {
          codexThreadId: runResult.threadId,
          itemCount: runResult.items.length,
          usage: runResult.usage,
        },
        turnId: task.id,
      });

      for (const toolCall of runResult.toolCalls) {
        await sessionTraceStore.recordToolCall({
          agentSessionId: context.agentSessionId,
          name: toolCall.name,
          status: toolCall.status,
          toolInput: toolCall.input,
          output: toolCall.output,
          error: toolCall.error,
          turnId: task.id,
        });
      }

      const reply = runResult.text.trim() || "Codex returned an empty response.";

      await sessionTraceStore.appendMessage({
        agentSessionId: context.agentSessionId,
        role: "assistant",
        body: reply,
        turnId: task.id,
      });

      return {
        status: "completed",
        message: reply,
        data: {
          agentSessionId: context.agentSessionId,
          codexThreadId: runResult.threadId,
          conversationId,
          channel,
          toolRun,
        },
        commands: [
          {
            target: "direct-chat",
            conversationId,
            body: reply,
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await onEvent?.({ type: "error", message });
      await sessionTraceStore.recordToolCall({
        agentSessionId: context.agentSessionId,
        name: "codex_run",
        status: "failed",
        toolInput: {
          codexThreadId: context.codexThreadId,
          promptLength: finalPrompt.length,
        },
        error: message,
        turnId: task.id,
      });

      return {
        status: "failed",
        message: `Codex run failed: ${message}`,
        data: {
          agentSessionId: context.agentSessionId,
          codexThreadId: context.codexThreadId,
          conversationId,
          channel,
        },
      };
    }
  }

  private async decideDirectChatTool(
    task: AgentTask,
    context: AgentDispatchContext,
    input: {
      body: string;
      channel: string;
      conversationId: string;
    },
    tools: EggTool[],
  ): Promise<DirectChatToolDecision> {
    const { sessionTraceStore, codexRunner } = this.dependencies;
    if (!sessionTraceStore || !codexRunner || !context.agentSessionId) {
      return { action: "answer" };
    }

    if (tools.length === 0) return { action: "answer" };

    const prompt = await buildToolDecisionPrompt({
      ...input,
      tools,
    });

    try {
      const runResult = await codexRunner.run({
        prompt,
        signal: context.signal,
        metadata: {
          agentSessionId: context.agentSessionId,
          externalSession: context.externalSession,
          purpose: "main-agent-tool-decision",
        },
      });
      const decision = parseToolDecision(runResult.text, tools);

      await sessionTraceStore.recordToolCall({
        agentSessionId: context.agentSessionId,
        name: "main_agent_tool_decision",
        status: "completed",
        toolInput: {
          taskId: task.id,
          tools: tools.map((tool) => tool.name),
        },
        output: {
          decision,
          decisionThreadId: runResult.threadId,
          usage: runResult.usage,
        },
        turnId: task.id,
      });

      return decision;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await sessionTraceStore.recordToolCall({
        agentSessionId: context.agentSessionId,
        name: "main_agent_tool_decision",
        status: "failed",
        toolInput: {
          taskId: task.id,
          tools: tools.map((tool) => tool.name),
        },
        error: message,
        turnId: task.id,
      });
      return { action: "answer", reason: `tool decision failed: ${message}` };
    }
  }

  private async executeDirectChatToolDecision(
    task: AgentTask,
    context: AgentDispatchContext,
    decision: DirectChatToolDecision,
    tools: EggTool[],
    onEvent?: MainAgentStreamHandler,
  ): Promise<DirectChatToolRun | undefined> {
    if (!decision.toolName) return undefined;
    const tool = tools.find((candidate) => candidate.name === decision.toolName);
    if (!tool) return undefined;

    const { sessionTraceStore } = this.dependencies;
    const id = randomUUID();
    const toolInput = decision.toolInput ?? {};
    const agentCall = await this.startSubAgentCall({
      childAgent: tool.name,
      mode: "tool-decision",
      task,
      context,
      callInput: toolInput,
    });
    const started = {
      id,
      name: tool.name,
      status: "started" as const,
      input: toolInput,
    };
    const streamCall: StreamAgentCall = {
      id: agentCall?.id ?? id,
      parentAgent: "main",
      childAgent: tool.name,
      mode: "tool-decision",
      status: "started",
      taskType: task.type,
      input: toolInput,
      turnId: task.id,
    };
    await onEvent?.({ type: "agent_call.started", call: streamCall });
    await onEvent?.({ type: "codex", event: { type: "tool_call", toolCall: started } });

    try {
      const result = await tool.execute(toolInput, {
        task,
        dispatchContext: toSubAgentContext(tool.name, context),
        signal: context.signal,
        metadata: {
          agentSessionId: context.agentSessionId,
          externalSession: context.externalSession,
        },
      });
      const agentStatus = statusFromToolResult(result);
      await this.finishSubAgentCall(agentCall, context, agentStatus, result);
      await onEvent?.({
        type: "agent_call.completed",
        call: {
          ...streamCall,
          status: agentStatus,
          output: result,
        },
      });
      const completed = {
        ...started,
        status: "completed" as const,
        output: result,
      };
      await onEvent?.({
        type: "codex",
        event: { type: "tool_call", toolCall: completed },
      });

      if (sessionTraceStore && context.agentSessionId) {
        await sessionTraceStore.recordToolCall({
          agentSessionId: context.agentSessionId,
          name: tool.name,
          status: "completed",
          toolInput,
          output: result,
          turnId: task.id,
        });
      }

      return {
        id,
        toolName: tool.name,
        toolInput,
        result,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.finishSubAgentCall(agentCall, context, "failed", undefined, message);
      await onEvent?.({
        type: "agent_call.failed",
        call: {
          ...streamCall,
          status: "failed",
          error: message,
        },
      });
      const failed = {
        ...started,
        status: "failed" as const,
        error: message,
      };
      await onEvent?.({ type: "codex", event: { type: "tool_call", toolCall: failed } });

      if (sessionTraceStore && context.agentSessionId) {
        await sessionTraceStore.recordToolCall({
          agentSessionId: context.agentSessionId,
          name: tool.name,
          status: "failed",
          toolInput,
          error: message,
          turnId: task.id,
        });
      }

      return undefined;
    }
  }

  private async startSubAgentCall(input: {
    childAgent: string;
    mode: AgentCallMode;
    task: AgentTask;
    context: AgentDispatchContext;
    callInput?: unknown;
  }): Promise<AgentCallRecord | undefined> {
    const { sessionTraceStore } = this.dependencies;
    if (!sessionTraceStore || !input.context.agentSessionId) return undefined;

    return sessionTraceStore.startAgentCall({
      agentSessionId: input.context.agentSessionId,
      parentAgent: "main",
      childAgent: input.childAgent,
      mode: input.mode,
      taskType: input.task.type,
      callInput: input.callInput,
      turnId: input.task.id,
    });
  }

  private async finishSubAgentCall(
    agentCall: AgentCallRecord | undefined,
    context: AgentDispatchContext,
    status: AgentResultStatus,
    output?: unknown,
    error?: string,
  ): Promise<void> {
    const { sessionTraceStore } = this.dependencies;
    if (!sessionTraceStore || !context.agentSessionId || !agentCall) return;

    await sessionTraceStore.finishAgentCall({
      agentSessionId: context.agentSessionId,
      id: agentCall.id,
      status,
      output,
      error,
    });
  }
}

function toSubAgentContext(
  subAgentName: string,
  context: AgentDispatchContext,
): SubAgentDispatchContext {
  return {
    externalSession: context.externalSession,
    agentSessionId: context.agentSessionId,
    signal: context.signal,
    metadata: context.metadata,
    subAgentName,
  };
}

async function buildDirectChatPrompt(input: {
  body: string;
  channel: string;
  conversationId: string;
  tools: EggTool[];
  toolRun?: DirectChatToolRun;
}): Promise<string> {
  const mainAgentPrompt = (await readFile(MAIN_AGENT_PROMPT_PATH, "utf8")).trim();

  const parts = [
    mainAgentPrompt,
    "",
    "## Runtime Context",
    `来源: ${input.channel}`,
    `conversationId: ${input.conversationId}`,
    "",
    "## Available Sub-Agent Tools",
    formatToolCatalog(input.tools),
  ];

  if (input.toolRun) {
    parts.push(
      "",
      "## Sub-Agent Tool Result",
      JSON.stringify(
        {
          toolName: input.toolRun.toolName,
          input: input.toolRun.toolInput,
          result: input.toolRun.result,
        },
        null,
        2,
      ),
    );
  }

  parts.push(
    "",
    "## 用户消息",
    input.body,
  );

  return parts.join("\n");
}

async function buildToolDecisionPrompt(input: {
  body: string;
  channel: string;
  conversationId: string;
  tools: EggTool[];
}): Promise<string> {
  const mainAgentPrompt = (await readFile(MAIN_AGENT_PROMPT_PATH, "utf8")).trim();

  return [
    mainAgentPrompt,
    "",
    "## Runtime Context",
    `来源: ${input.channel}`,
    `conversationId: ${input.conversationId}`,
    "",
    "## Available Sub-Agent Tools",
    formatToolCatalog(input.tools),
    "",
    "## Runtime Mode",
    "tool-decision",
    "",
    "## 用户消息",
    input.body,
  ].join("\n");
}

function formatToolCatalog(tools: EggTool[]): string {
  if (tools.length === 0) return "[]";
  return JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    null,
    2,
  );
}

function parseToolDecision(text: string, tools: EggTool[]): DirectChatToolDecision {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { action: "answer", reason: "decision output is not an object" };
  }

  const action = "action" in parsed ? parsed.action : undefined;
  if (action !== "tool") {
    return {
      action: "answer",
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  }

  const toolName = "toolName" in parsed ? parsed.toolName : undefined;
  if (typeof toolName !== "string" || !tools.some((tool) => tool.name === toolName)) {
    return { action: "answer", reason: "selected tool is unavailable" };
  }

  const toolInput = "toolInput" in parsed ? parsed.toolInput : undefined;
  return {
    action: "tool",
    toolName,
    toolInput:
      toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
        ? (toolInput as Record<string, unknown>)
        : {},
    reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const source = fenced?.[1]?.trim() ?? trimmed;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end < start) return null;

  try {
    return JSON.parse(source.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function statusFromToolResult(result: EggToolResult): AgentResultStatus {
  if (!result.details || typeof result.details !== "object") return "completed";
  if (!("status" in result.details)) return "completed";

  const status = result.details.status;
  if (
    status === "completed" ||
    status === "failed" ||
    status === "skipped" ||
    status === "needs_input"
  ) {
    return status;
  }

  return "completed";
}
