import type { Tool as PiAiTool } from "@mariozechner/pi-ai";
import type { TriageTool } from "./types";
import { fetchTraceTool } from "./fetch-trace";

const tools: TriageTool[] = [fetchTraceTool];

/** Get pi-ai Tool definitions for passing to Context.tools */
export function getToolDefinitions(): PiAiTool[] {
  return tools.map((t) => t.definition);
}

/** Look up a tool's execute function by name */
export function getToolExecutor(
  name: string,
): TriageTool["execute"] | undefined {
  return tools.find((t) => t.definition.name === name)?.execute;
}
