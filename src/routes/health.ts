import type { Hono } from "hono";
import type { AgentRegistry } from "../agent/registry";
import type { RunCoordinator } from "../agent/runtime/run-coordinator";

export function registerHealthRoutes(
  app: Hono,
  registry: AgentRegistry,
  runCoordinator: RunCoordinator,
): void {
  app.get("/health", (c) => c.json({ ok: true, architecture: "v2" }));

  app.get("/status", (c) =>
    c.json({
      ok: true,
      architecture: "v2",
      agents: registry.describeCapabilities(),
      activeRuns: runCoordinator.getActiveRunKeys(),
    }),
  );
}
