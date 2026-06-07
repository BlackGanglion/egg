import type { MainAgent, MainAgentStreamHandler } from "../../agent/main";
import type { AgentResult, AgentTask, ExternalSessionRef } from "../../agent/types";
import type { RunCoordinator } from "../../agent/runtime/run-coordinator";
import type { AgentSessionStore } from "../../agent/session/session-store";

export interface DirectChatMessageEnvelope {
  channel: string;
  conversationId: string;
  messageId: string;
  body: string;
}

export class DirectChatBridge {
  constructor(
    private readonly mainAgent: MainAgent,
    private readonly sessionStore: AgentSessionStore,
    private readonly runCoordinator: RunCoordinator,
  ) {}

  async handleMessage(envelope: DirectChatMessageEnvelope): Promise<AgentResult> {
    return this.dispatchMessage(envelope, (task, context) =>
      this.mainAgent.dispatch(task, context),
    );
  }

  async handleMessageStream(
    envelope: DirectChatMessageEnvelope,
    onEvent: MainAgentStreamHandler,
  ): Promise<AgentResult> {
    return this.dispatchMessage(envelope, (task, context) =>
      this.mainAgent.dispatchStream(task, context, onEvent),
    );
  }

  cancelConversation(channel: string, conversationId: string): boolean {
    return this.runCoordinator.cancel(`chat:${channel}:${conversationId}`);
  }

  private async dispatchMessage(
    envelope: DirectChatMessageEnvelope,
    dispatch: (
      task: AgentTask,
      context: {
        externalSession: ExternalSessionRef;
        agentSessionId: string;
        codexThreadId?: string;
        signal: AbortSignal;
      },
    ) => Promise<AgentResult>,
  ): Promise<AgentResult> {
    const externalSession: ExternalSessionRef = {
      source: "direct-chat",
      scope: "conversation",
      externalSessionId: `${envelope.channel}:${envelope.conversationId}`,
      externalTurnId: envelope.messageId,
    };
    await this.sessionStore.getOrCreate(externalSession);
    await this.sessionStore.recordTurn(externalSession, envelope.messageId);

    const task: AgentTask = {
      id: envelope.messageId,
      type: "direct-chat.message",
      input: {
        channel: envelope.channel,
        conversationId: envelope.conversationId,
        body: envelope.body,
      },
      externalSession,
    };

    return this.runCoordinator.enqueue(
      `chat:${envelope.channel}:${envelope.conversationId}`,
      async (run) => {
        const currentSession = await this.sessionStore.getOrCreate(externalSession);
        return dispatch(task, {
          externalSession,
          agentSessionId: currentSession.agentSessionId,
          codexThreadId: currentSession.codexThreadId,
          signal: run.signal,
        });
      },
    );
  }
}
