import type { LinearApiClient } from "../../../infra/linear/client";
import { parseIssueIdentifier } from "../../../infra/linear/identifier";
import type { Logger } from "../../../utils/logger";
import type { SubAgent } from "../../types";

const POLL_INTERVAL_MS = 60_000;
const POLL_LOOKBACK_MS = 60_000;
const POLL_OVERLAP_MS = 5_000;
const POLL_PAGE_SIZE = 50;

export class LinearIssuePoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastCheckedAt: Date;

  constructor(
    private readonly linearClient: LinearApiClient,
    private readonly triageAgent: SubAgent,
    private readonly logger: Logger,
    private readonly triageMinIssueNumber: number,
  ) {
    this.lastCheckedAt = new Date(Date.now() - POLL_LOOKBACK_MS);
  }

  start() {
    if (this.timer) return;

    this.logger.info(
      `[issue-poller] enabled interval=${POLL_INTERVAL_MS}ms lookback=${POLL_LOOKBACK_MS}ms`,
    );
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async poll() {
    if (this.running) {
      this.logger.warn("[issue-poller] previous poll still running, skip tick");
      return;
    }

    this.running = true;
    const until = new Date();
    const since = new Date(this.lastCheckedAt.getTime() - POLL_OVERLAP_MS);
    let shouldAdvanceCursor = false;

    try {
      const issues = await this.linearClient.listIssuesCreatedBetween(
        since,
        until,
        POLL_PAGE_SIZE,
      );

      if (issues.length > 0) {
        this.logger.info(
          `[issue-poller] found ${issues.length} issue(s) created between ${since.toISOString()} and ${until.toISOString()}`,
        );
      }

      shouldAdvanceCursor = true;

      for (const issue of issues) {
        if (this.shouldSkip(issue.identifier)) continue;

        const result = await this.triageAgent.invoke({ issueId: issue.id });
        if (result.success) continue;

        shouldAdvanceCursor = false;
        if (isAlreadyRunning(result.details)) {
          this.logger.info(
            `[issue-poller] triage already running for ${issue.identifier}`,
          );
          continue;
        }

        this.logger.error(
          `[issue-poller] triage failed for ${issue.identifier}: ${result.message}`,
        );
      }
    } catch (err: unknown) {
      shouldAdvanceCursor = false;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[issue-poller] poll failed: ${msg}`);
    } finally {
      if (shouldAdvanceCursor) {
        this.lastCheckedAt = until;
      }
      this.running = false;
    }
  }

  private shouldSkip(identifier: string): boolean {
    const parsed = parseIssueIdentifier(identifier);
    if (
      this.triageMinIssueNumber > 0 &&
      parsed &&
      parsed.number < this.triageMinIssueNumber
    ) {
      return true;
    }

    return false;
  }
}

function isAlreadyRunning(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    "alreadyRunning" in details &&
    details.alreadyRunning === true
  );
}
