import type { AgentTask, SubAgent } from "./types";
import type { EggTool } from "./tool/types";

export class AgentRegistry {
  private readonly agents = new Map<string, SubAgent>();

  register(agent: SubAgent): void {
    this.agents.set(agent.name, agent);
  }

  get(name: string): SubAgent | undefined {
    return this.agents.get(name);
  }

  all(): SubAgent[] {
    return [...this.agents.values()];
  }

  findForTask(task: AgentTask): SubAgent[] {
    return this.all().filter((agent) => agent.canHandle(task));
  }

  asTools(): EggTool[] {
    return this.all().map((agent) => agent.asTool());
  }

  getTool(name: string): EggTool | undefined {
    return this.asTools().find((tool) => tool.name === name);
  }

  describeCapabilities(): Array<{ name: string; capabilities: string[] }> {
    return this.all().map((agent) => ({
      name: agent.name,
      capabilities: agent.capabilities,
    }));
  }
}
