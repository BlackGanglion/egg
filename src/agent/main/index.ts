import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentDispatchContext, AgentResult, AgentTask } from "../types";
import type { AgentRegistry } from "../registry";
import type { SessionTraceStore } from "../session/session-trace-store";
import type { AgentSessionStore } from "../session/session-store";
import type { CodexRunner, CodexStreamEvent } from "../runtime/codex-runner";

const MAIN_AGENT_PROMPT_PATH = resolve(process.cwd(), "prompts/main-agent.md");

interface DirectChatInput {
  channel?: unknown;
  conversationId?: unknown;
  body?: unknown;
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
    try {
      return await agent.invoke(task, context);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
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

    const prompt = await buildDirectChatPrompt({ body, channel, conversationId });

    try {
      const runRequest = {
        prompt,
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
          promptLength: prompt.length,
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
          promptLength: prompt.length,
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
}

async function buildDirectChatPrompt(input: {
  body: string;
  channel: string;
  conversationId: string;
}): Promise<string> {
  const mainAgentPrompt = (await readFile(MAIN_AGENT_PROMPT_PATH, "utf8")).trim();

  return [
    mainAgentPrompt,
    "",
    "## Runtime Context",
    `来源: ${input.channel}`,
    `conversationId: ${input.conversationId}`,
    "",
    "## 用户消息",
    input.body,
  ].join("\n");
}
