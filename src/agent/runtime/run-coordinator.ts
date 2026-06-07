import { randomUUID } from "node:crypto";

export interface RunCoordinatorOptions {
  maxConcurrentRuns?: number;
}

export interface RunExecutionContext {
  runKey: string;
  agentRunId: string;
  signal: AbortSignal;
}

interface ActiveRun {
  controller: AbortController;
  startedAt: string;
}

export class RunCoordinator {
  private activeCount = 0;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly waiters: Array<() => void> = [];
  private readonly maxConcurrentRuns: number;

  constructor(options: RunCoordinatorOptions = {}) {
    this.maxConcurrentRuns = Math.max(1, options.maxConcurrentRuns ?? 2);
  }

  enqueue<T>(
    runKey: string,
    run: (context: RunExecutionContext) => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(runKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.withSlot(runKey, run));

    this.queues.set(
      runKey,
      next.finally(() => {
        if (this.queues.get(runKey) === next) this.queues.delete(runKey);
      }),
    );

    return next;
  }

  cancel(runKey: string): boolean {
    const active = this.activeRuns.get(runKey);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  getActiveRunKeys(): string[] {
    return [...this.activeRuns.keys()];
  }

  private async withSlot<T>(
    runKey: string,
    run: (context: RunExecutionContext) => Promise<T>,
  ): Promise<T> {
    await this.acquireSlot();

    const controller = new AbortController();
    const context: RunExecutionContext = {
      runKey,
      agentRunId: randomUUID(),
      signal: controller.signal,
    };
    this.activeRuns.set(runKey, {
      controller,
      startedAt: new Date().toISOString(),
    });

    try {
      return await run(context);
    } finally {
      this.activeRuns.delete(runKey);
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeCount < this.maxConcurrentRuns) {
      this.activeCount++;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.activeCount++;
  }

  private releaseSlot(): void {
    this.activeCount--;
    const next = this.waiters.shift();
    next?.();
  }
}
