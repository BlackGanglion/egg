import { resolve } from "node:path";
import type { AgentDispatchContext, AgentResult, AgentTask, SubAgent } from "../../types";

export interface LinearSubAgentOptions {
  workspacePath?: string;
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

  constructor(options: LinearSubAgentOptions = {}) {
    const workspacePath =
      options.workspacePath ?? resolve(process.cwd(), "src/agent/sub/linear/workspace");
    this.workspace = {
      workspacePath,
      promptPath: resolve(workspacePath, "prompts/triage.md"),
      evalsPath: resolve(workspacePath, "evals"),
      notesPath: resolve(workspacePath, "notes"),
      access: "read-only" as const,
    };
  }

  canHandle(task: AgentTask): boolean {
    return this.capabilities.includes(task.type);
  }

  async invoke(task: AgentTask, context: AgentDispatchContext): Promise<AgentResult> {
    return {
      status: "skipped",
      message: `Linear sub-agent scaffold received ${task.type}; implementation is pending CodexRunner wiring.`,
      data: {
        taskId: task.id,
        agentSessionId: context.agentSessionId,
        codexThreadId: context.codexThreadId,
        workspace: this.workspace,
      },
    };
  }
}
