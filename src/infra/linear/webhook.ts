import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type {
  EntityWebhookPayloadWithIssueData,
  AgentSessionEventWebhookPayload,
} from "@linear/sdk";
import type { Logger } from "../../utils/logger";

export interface WebhookCallbacks {
  onIssueCreated?: (payload: EntityWebhookPayloadWithIssueData) => void;
  onAgentSessionEvent?: (payload: AgentSessionEventWebhookPayload) => void;
}

/**
 * Create a Linear webhook handler (Fetch API compatible).
 * Returns a function that takes a Fetch Request and returns a Response.
 */
export function createWebhookHandler(
  webhookSecret: string,
  callbacks: WebhookCallbacks,
  logger: Logger,
) {
  const client = new LinearWebhookClient(webhookSecret);
  const handler = client.createHandler();

  handler.on("Issue", (payload) => {
    if (payload.action === "create") {
      logger.info(
        `Issue created: id=${payload.data.id} title=${payload.data.title}`,
      );
      callbacks.onIssueCreated?.(payload);
    }
  });

  handler.on("AgentSessionEvent", (payload) => {
    logger.info(
      `AgentSessionEvent: action=${payload.action} sessionId=${payload.agentSession.id}`,
    );
    callbacks.onAgentSessionEvent?.(payload);
  });

  return handler;
}
