import type { ExternalSessionRef } from "../../agent/types";

export type LinearAgentSessionAction = "created" | "prompted" | "stopped";

export interface LinearIssueCreatedEnvelope {
  deliveryId?: string;
  issueId: string;
  identifier?: string;
  assigneeId?: string | null;
}

export interface LinearAgentSessionEnvelope {
  deliveryId?: string;
  action: LinearAgentSessionAction;
  agentSessionId: string;
  issueId?: string;
  agentActivityId?: string;
  promptContext?: string;
  userMessage?: string;
}

export function linearIssueSessionRef(issueId: string, turnId?: string): ExternalSessionRef {
  return {
    source: "linear",
    scope: "issue",
    externalSessionId: issueId,
    externalTurnId: turnId,
  };
}

export function linearAgentSessionRef(
  agentSessionId: string,
  turnId?: string,
): ExternalSessionRef {
  return {
    source: "linear",
    scope: "agent-session",
    externalSessionId: agentSessionId,
    externalTurnId: turnId,
  };
}
