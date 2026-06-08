import type { MainAgent } from "../../agent/main";
import type { AgentResult, AgentTask } from "../../agent/types";
import type { RunCoordinator } from "../../agent/runtime/run-coordinator";
import type { AgentSessionStore } from "../../agent/session/session-store";
import {
  linearAgentSessionRef,
  linearIssueSessionRef,
  type LinearAgentSessionEnvelope,
  type LinearIssueCreatedEnvelope,
} from "./types";

export class LinearAgentBridge {
  constructor(
    private readonly mainAgent: MainAgent,
    private readonly sessionStore: AgentSessionStore,
    private readonly runCoordinator: RunCoordinator,
  ) {}

  async handleIssueCreated(envelope: LinearIssueCreatedEnvelope): Promise<AgentResult> {
    const externalSession = linearIssueSessionRef(envelope.issueId, envelope.deliveryId);
    const session = await this.sessionStore.getOrCreate(externalSession);
    await this.sessionStore.recordTurn(externalSession, envelope.deliveryId);

    const task: AgentTask = {
      id: envelope.deliveryId ?? `linear-issue-${envelope.issueId}`,
      type: "linear.issue.triage",
      input: {
        issueId: envelope.issueId,
        identifier: envelope.identifier,
        assigneeId: envelope.assigneeId,
      },
      externalSession,
    };

    return this.runCoordinator.enqueue(`triage:${envelope.issueId}`, (run) =>
      this.mainAgent.dispatch(task, {
        externalSession,
        agentSessionId: session.agentSessionId,
        signal: run.signal,
      }),
    );
  }

  async handleAgentSessionEvent(envelope: LinearAgentSessionEnvelope): Promise<AgentResult> {
    const runKey = `session:${envelope.agentSessionId}`;

    if (envelope.action === "stopped") {
      const canceled = this.runCoordinator.cancel(runKey);
      return {
        status: canceled ? "completed" : "skipped",
        message: canceled
          ? `Canceled active Linear session run ${envelope.agentSessionId}`
          : `No active Linear session run ${envelope.agentSessionId}`,
      };
    }

    const externalSession = linearAgentSessionRef(
      envelope.agentSessionId,
      envelope.agentActivityId ?? envelope.deliveryId,
    );
    const session = await this.sessionStore.getOrCreate(externalSession);
    await this.sessionStore.recordTurn(
      externalSession,
      envelope.agentActivityId ?? envelope.deliveryId,
    );

    const task: AgentTask = {
      id: envelope.agentActivityId ?? envelope.deliveryId ?? `linear-session-${envelope.agentSessionId}`,
      type: "linear.session.prompt",
      input: {
        action: envelope.action,
        agentSessionId: envelope.agentSessionId,
        issueId: envelope.issueId,
        promptContext: envelope.promptContext,
        userMessage: envelope.userMessage,
      },
      externalSession,
    };

    return this.runCoordinator.enqueue(runKey, (run) =>
      this.mainAgent.dispatch(task, {
        externalSession,
        agentSessionId: session.agentSessionId,
        signal: run.signal,
      }),
    );
  }
}
