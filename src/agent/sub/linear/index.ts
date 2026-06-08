import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import lodash from "lodash";
import type {
  AgentResult,
  AgentResultStatus,
  AgentTask,
  SubAgent,
  SubAgentDispatchContext,
} from "../../types";
import type { CodexRunner } from "../../runtime/codex-runner";
import type { SessionTraceStore } from "../../session/session-trace-store";
import { defineToolParameters } from "../../tool/schema";
import type { EggTool, EggToolResult, ToolExecutionContext } from "../../tool/types";
import {
  createLinearTools,
  type LinearToolDependencies,
} from "./tools";

const DEFAULT_MAX_TOOL_ITERATIONS = 8;
const { isPlainObject, isString } = lodash;
const LINEAR_STABLE_PROMPT_FILENAME = "triage.stable.md";
const LINEAR_MUTABLE_PROMPT_FILENAME = "triage.mutable.md";

export interface LinearSubAgentOptions {
  workspacePath?: string;
  tools?: LinearToolDependencies;
  codexRunner?: CodexRunner;
  sessionTraceStore?: SessionTraceStore;
  maxToolIterations?: number;
}

interface LinearToolParams {
  taskType?: string;
  instructions?: string;
  issueId?: string;
  identifier?: string;
  linearAgentSessionId?: string;
  activityId?: string;
  input?: Record<string, unknown>;
}

interface LinearCodexDecision {
  type: "tool_call" | "final";
  toolName?: string;
  toolInput?: Record<string, unknown>;
  reason?: string;
  status?: AgentResultStatus;
  message?: string;
}

interface LinearInternalToolRun {
  toolName: string;
  toolInput: Record<string, unknown>;
  status: "completed" | "failed";
  result?: EggToolResult;
  error?: string;
}

interface LinearPromptBundle {
  stablePrompt: string;
  mutablePrompt: string;
  combinedPrompt: string;
  stablePromptPath: string;
  mutablePromptPath: string;
}

export class LinearSubAgent implements SubAgent {
  readonly name = "linear";
  readonly description = "Linear owning sub-agent for issue triage, session activity, and Linear write-back.";
  readonly capabilities = [
    "linear.issue.triage",
    "linear.session.prompt",
    "linear.activity.write",
    "linear.issue.write",
  ];
  readonly workspace;
  private readonly toolDependencies: LinearToolDependencies;
  private readonly codexRunner?: CodexRunner;
  private readonly sessionTraceStore?: SessionTraceStore;
  private readonly maxToolIterations: number;

  constructor(options: LinearSubAgentOptions = {}) {
    const workspacePath =
      options.workspacePath ?? resolve(process.cwd(), "src/agent/sub/linear");
    const promptRootPath = resolve(process.cwd(), "prompts");
    const stablePromptPath = resolve(
      promptRootPath,
      LINEAR_STABLE_PROMPT_FILENAME,
    );
    const mutablePromptPath = resolve(
      promptRootPath,
      LINEAR_MUTABLE_PROMPT_FILENAME,
    );
    this.workspace = {
      workspacePath,
      promptPath: stablePromptPath,
      stablePromptPath,
      mutablePromptPath,
      evalsPath: resolve(workspacePath, "evals"),
      notesPath: resolve(workspacePath, "notes"),
      access: "read-only" as const,
    };
    this.toolDependencies = options.tools ?? {};
    this.codexRunner = options.codexRunner;
    this.sessionTraceStore = options.sessionTraceStore;
    this.maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  }

  canHandle(task: AgentTask): boolean {
    return this.capabilities.includes(task.type);
  }

  asTool(): EggTool<LinearToolParams> {
    return {
      name: "linear",
      description:
        "处理所有 Linear 相关任务，包括 issue 分诊、Linear Agent Session 对话、activity 写回和 issue 更新。",
      parameters: defineToolParameters({
        type: "object",
        properties: {
          taskType: {
            type: "string",
            enum: [
              "linear.issue.triage",
              "linear.session.prompt",
              "linear.activity.write",
              "linear.issue.write",
            ],
            description:
              "Linear 子 agent 要执行的任务类型；普通用户对话中的 Linear 请求默认使用 linear.session.prompt。",
          },
          instructions: {
            type: "string",
            description: "用户关于 Linear 的自然语言请求或操作说明。",
          },
          issueId: {
            type: "string",
            description: "Linear issue id 或 identifier。",
          },
          identifier: {
            type: "string",
            description: "Linear issue identifier，例如 ENG-123。",
          },
          linearAgentSessionId: {
            type: "string",
            description: "Linear Agent Session id。",
          },
          activityId: {
            type: "string",
            description: "Linear activity id，用于写回或去重。",
          },
          input: {
            type: "object",
            description: "调用方已经结构化出的 Linear 任务输入。",
          },
        },
        required: ["instructions"],
        additionalProperties: false,
      }),
      execute: async (
        params: LinearToolParams,
        context: ToolExecutionContext,
      ): Promise<EggToolResult> => {
        const task = this.toTask(params, context.task);
        const result = await this.invoke(
          task,
          this.toSubAgentContext(context),
        );

        return {
          content: [{ type: "text", text: result.message }],
          details: result,
        };
      },
    };
  }

  async invoke(task: AgentTask, context: SubAgentDispatchContext): Promise<AgentResult> {
    const internalTools = this.internalToolsForTask(task);
    const toolCatalog = describeTools(internalTools);

    if (!this.codexRunner) {
      return {
        status: "failed",
        message: "Linear 子 agent Codex runtime 未配置。",
        data: {
          taskId: task.id,
          taskType: task.type,
          agentSessionId: context.agentSessionId,
          workspace: this.workspace,
          tools: toolCatalog,
        },
      };
    }

    let promptBundle: LinearPromptBundle;
    try {
      promptBundle = await readLinearPromptBundle({
        stablePromptPath: this.workspace.stablePromptPath,
        mutablePromptPath: this.workspace.mutablePromptPath,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "failed",
        message: `Linear 子 agent prompt 读取失败：${message}`,
        data: {
          taskId: task.id,
          taskType: task.type,
          agentSessionId: context.agentSessionId,
          stablePromptPath: this.workspace.stablePromptPath,
          mutablePromptPath: this.workspace.mutablePromptPath,
          workspace: this.workspace,
          tools: toolCatalog,
        },
      };
    }

    let threadId: string | undefined;
    let prompt = buildLinearInitialPrompt({
      promptBundle,
      task,
      context,
      tools: internalTools,
    });
    const toolRuns: LinearInternalToolRun[] = [];

    for (let iteration = 0; iteration < this.maxToolIterations; iteration += 1) {
      let runResult: Awaited<ReturnType<CodexRunner["run"]>>;

      try {
        runResult = await this.codexRunner.run({
          prompt,
          threadId,
          cwd: this.workspace.workspacePath,
          workspaceAccess: this.workspace.access,
          tools: internalTools,
          signal: context.signal,
          metadata: {
            agentSessionId: context.agentSessionId,
            externalSession: context.externalSession,
            subAgent: this.name,
            taskType: task.type,
            iteration,
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await this.recordToolCall(task, context, {
          name: "linear.codex_run",
          status: "failed",
          toolInput: {
            threadId,
            promptLength: prompt.length,
            iteration,
          },
          error: message,
        });

        return {
          status: "failed",
          message: `Linear 子 agent Codex run 失败：${message}`,
          data: {
            taskId: task.id,
            taskType: task.type,
            agentSessionId: context.agentSessionId,
            subAgentCodexThreadId: threadId,
            workspace: this.workspace,
            promptFiles: describePromptFiles(promptBundle),
            tools: toolCatalog,
            toolRuns,
          },
        };
      }

      threadId = runResult.threadId;
      await this.recordToolCall(task, context, {
        name: "linear.codex_run",
        status: "completed",
        toolInput: {
          threadId,
          promptLength: prompt.length,
          iteration,
        },
        output: {
          threadId: runResult.threadId,
          itemCount: runResult.items.length,
          usage: runResult.usage,
        },
      });

      for (const toolCall of runResult.toolCalls) {
        await this.recordToolCall(task, context, {
          name: `${this.name}.${toolCall.name}`,
          status: toolCall.status,
          toolInput: toolCall.input,
          output: toolCall.output,
          error: toolCall.error,
        });
      }

      const decision = parseLinearCodexDecision(runResult.text, internalTools);
      if (decision.type === "final") {
        const message =
          decision.message?.trim() ||
          runResult.text.trim() ||
          "Linear 子 agent 已完成，但 Codex 未返回文本。";

        return {
          status: decision.status ?? "completed",
          message,
          data: {
            taskId: task.id,
            taskType: task.type,
            input: task.input,
            agentSessionId: context.agentSessionId,
            subAgentCodexThreadId: threadId,
            workspace: this.workspace,
            promptFiles: describePromptFiles(promptBundle),
            tools: toolCatalog,
            toolRuns,
            usage: runResult.usage,
          },
        };
      }

      if (!decision.toolName) {
        return {
          status: "failed",
          message: "Linear 子 agent 请求工具调用，但未提供 toolName。",
          data: {
            taskId: task.id,
            taskType: task.type,
            agentSessionId: context.agentSessionId,
            subAgentCodexThreadId: threadId,
            tools: toolCatalog,
            toolRuns,
          },
        };
      }

      const tool = internalTools.find((candidate) => candidate.name === decision.toolName);
      if (!tool) {
        return {
          status: "failed",
          message: `Linear 子 agent 请求了不可用工具：${decision.toolName}`,
          data: {
            taskId: task.id,
            taskType: task.type,
            agentSessionId: context.agentSessionId,
            subAgentCodexThreadId: threadId,
            tools: toolCatalog,
            toolRuns,
            requestedTool: decision.toolName,
          },
        };
      }

      const toolRun = await this.executeInternalTool(
        tool,
        decision.toolInput ?? {},
        task,
        context,
      );
      toolRuns.push(toolRun);
      prompt = buildLinearToolResultPrompt(toolRun);
    }

    return {
      status: "failed",
      message: `Linear 子 agent 已达到最大工具循环次数：${this.maxToolIterations}`,
      data: {
        taskId: task.id,
        taskType: task.type,
        input: task.input,
        agentSessionId: context.agentSessionId,
        subAgentCodexThreadId: threadId,
        workspace: this.workspace,
        promptFiles: describePromptFiles(promptBundle),
        tools: toolCatalog,
        toolRuns,
      },
    };
  }

  internalToolsForTask(task: AgentTask): EggTool[] {
    return createLinearTools(this.toolDependencies, task);
  }

  private toSubAgentContext(context: ToolExecutionContext): SubAgentDispatchContext {
    return {
      externalSession:
        context.dispatchContext?.externalSession ?? context.task.externalSession,
      agentSessionId: context.dispatchContext?.agentSessionId,
      signal: context.dispatchContext?.signal ?? context.signal,
      metadata: {
        ...context.metadata,
        ...context.dispatchContext?.metadata,
      },
      subAgentName: this.name,
    };
  }

  private toTask(params: LinearToolParams, sourceTask: AgentTask): AgentTask {
    const taskType = this.normalizeTaskType(params.taskType);
    return {
      id: params.activityId ?? `${sourceTask.id}:linear`,
      type: taskType,
      intent: sourceTask.intent,
      capabilities: [taskType],
      externalSession: sourceTask.externalSession,
      metadata: {
        ...sourceTask.metadata,
        delegatedFromTaskId: sourceTask.id,
        delegatedFromTaskType: sourceTask.type,
      },
      input: {
        ...(params.input ?? {}),
        instructions: params.instructions,
        issueId: params.issueId,
        identifier: params.identifier,
        agentSessionId: params.linearAgentSessionId,
      },
    };
  }

  private normalizeTaskType(taskType: string | undefined): string {
    if (taskType && this.capabilities.includes(taskType)) return taskType;
    return "linear.session.prompt";
  }

  private async executeInternalTool(
    tool: EggTool,
    toolInput: Record<string, unknown>,
    task: AgentTask,
    context: SubAgentDispatchContext,
  ): Promise<LinearInternalToolRun> {
    try {
      const result = await tool.execute(toolInput, {
        task,
        dispatchContext: context,
        signal: context.signal,
        metadata: {
          agentSessionId: context.agentSessionId,
          externalSession: context.externalSession,
          subAgent: this.name,
        },
      });

      await this.recordToolCall(task, context, {
        name: `${this.name}.${tool.name}`,
        status: "completed",
        toolInput,
        output: result,
      });

      return {
        toolName: tool.name,
        toolInput,
        status: "completed",
        result,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.recordToolCall(task, context, {
        name: `${this.name}.${tool.name}`,
        status: "failed",
        toolInput,
        error: message,
      });

      return {
        toolName: tool.name,
        toolInput,
        status: "failed",
        error: message,
      };
    }
  }

  private async recordToolCall(
    task: AgentTask,
    context: SubAgentDispatchContext,
    input: {
      name: string;
      status: "started" | "completed" | "failed";
      toolInput?: unknown;
      output?: unknown;
      error?: string;
    },
  ): Promise<void> {
    if (!this.sessionTraceStore || !context.agentSessionId) return;

    await this.sessionTraceStore.recordToolCall({
      agentSessionId: context.agentSessionId,
      name: input.name,
      status: input.status,
      toolInput: input.toolInput,
      output: input.output,
      error: input.error,
      turnId: task.id,
    });
  }
}

function describeTools(tools: EggTool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

async function readLinearPromptBundle(input: {
  stablePromptPath: string;
  mutablePromptPath: string;
}): Promise<LinearPromptBundle> {
  const [stablePrompt, mutablePrompt] = await Promise.all([
    readRequiredPromptFile(input.stablePromptPath, "stable prompt"),
    readRequiredPromptFile(input.mutablePromptPath, "mutable prompt"),
  ]);

  return {
    stablePrompt,
    mutablePrompt,
    combinedPrompt: [
      "## Stable Instructions",
      stablePrompt,
      "",
      "## Mutable Knowledge",
      mutablePrompt,
    ].join("\n"),
    stablePromptPath: input.stablePromptPath,
    mutablePromptPath: input.mutablePromptPath,
  };
}

async function readRequiredPromptFile(path: string, label: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} ${path} 读取失败：${message}`);
  }
}

function describePromptFiles(bundle: LinearPromptBundle) {
  return {
    stable: {
      path: bundle.stablePromptPath,
      mutableByAgent: false,
      length: bundle.stablePrompt.length,
    },
    mutable: {
      path: bundle.mutablePromptPath,
      mutableByAgent: true,
      length: bundle.mutablePrompt.length,
    },
  };
}

function buildLinearInitialPrompt(input: {
  promptBundle: LinearPromptBundle;
  task: AgentTask;
  context: SubAgentDispatchContext;
  tools: EggTool[];
}): string {
  return [
    input.promptBundle.combinedPrompt,
    "",
    "## Prompt File Policy",
    JSON.stringify(describePromptFiles(input.promptBundle), null, 2),
    "",
    "## Runtime Context",
    JSON.stringify(
      {
        agent: "linear",
        taskId: input.task.id,
        taskType: input.task.type,
        intent: input.task.intent,
        externalSession: input.context.externalSession,
        agentSessionId: input.context.agentSessionId,
        taskInput: input.task.input,
        taskMetadata: input.task.metadata,
      },
      null,
      2,
    ),
    "",
    "## Available Linear Tools",
    formatToolCatalog(input.tools),
    "",
    "## Runtime Tool Protocol",
    "需要调用工具时，只输出一个 JSON 对象，不要附加解释：",
    '{"type":"tool_call","toolName":"fetch_trace","toolInput":{"url":"...","mode":"tools"},"reason":"..."}',
    "工具执行结果会继续发送回这个 Linear 子 agent Codex thread。",
    "完成时，只输出一个 JSON 对象：",
    '{"type":"final","status":"completed","message":"..."}',
    "status 只能是 completed、failed、skipped、needs_input。",
  ].join("\n");
}

function buildLinearToolResultPrompt(toolRun: LinearInternalToolRun): string {
  return [
    "## Tool Result",
    JSON.stringify(
      {
        toolName: toolRun.toolName,
        input: toolRun.toolInput,
        status: toolRun.status,
        result: toolRun.result,
        error: toolRun.error,
      },
      null,
      2,
    ),
    "",
    "继续执行 Linear 任务。需要更多工具时输出 tool_call JSON；完成时输出 final JSON。",
  ].join("\n");
}

function formatToolCatalog(tools: EggTool[]): string {
  if (tools.length === 0) return "[]";
  return JSON.stringify(describeTools(tools), null, 2);
}

function parseLinearCodexDecision(
  text: string,
  tools: EggTool[],
): LinearCodexDecision {
  const parsed = parseJsonObject(text);
  if (!parsed) {
    return {
      type: "final",
      status: "completed",
      message: text.trim(),
    };
  }

  const typeValue = stringRecordValue(parsed, "type") ?? stringRecordValue(parsed, "action");
  const message =
    stringRecordValue(parsed, "message") ??
    stringRecordValue(parsed, "answer") ??
    stringRecordValue(parsed, "response");
  const status = parseAgentResultStatus(parsed["status"]);
  const reason = stringRecordValue(parsed, "reason");

  if (typeValue === "tool_call" || typeValue === "tool" || typeValue === "call_tool") {
    const toolName =
      stringRecordValue(parsed, "toolName") ??
      stringRecordValue(parsed, "tool") ??
      stringRecordValue(parsed, "name");
    const rawToolInput = parsed["toolInput"] ?? parsed["input"];
    const toolInput = isPlainObject(rawToolInput)
      ? (rawToolInput as Record<string, unknown>)
      : undefined;

    if (!toolName || !tools.some((tool) => tool.name === toolName)) {
      return {
        type: "final",
        status: "failed",
        message: toolName
          ? `Linear 子 agent 请求了不可用工具：${toolName}`
          : "Linear 子 agent 请求工具调用，但未提供 toolName。",
        reason,
      };
    }

    return {
      type: "tool_call",
      toolName,
      toolInput: toolInput ?? {},
      reason,
    };
  }

  return {
    type: "final",
    status: status ?? "completed",
    message: message ?? text.trim(),
    reason,
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

function parseAgentResultStatus(value: unknown): AgentResultStatus | undefined {
  if (
    value === "completed" ||
    value === "failed" ||
    value === "skipped" ||
    value === "needs_input"
  ) {
    return value;
  }

  return undefined;
}

function stringRecordValue(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return isString(value) && value ? value : undefined;
}
