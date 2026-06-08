import type { AgentTask } from "../../../types";
import type { EggTool } from "../../../tool/types";
import { createLinearIssueReadTools } from "./fetch-linear-issue-context";
import { createFetchTraceTool } from "./fetch-trace";
import { createSubmitTriageResultTool } from "./submit-triage-result";
import type { LinearToolDependencies } from "./types";
export type {
  LinearIssueContext,
  LinearIssueContextLookup,
  LinearIssueContextOverview,
  LinearIssueDetailSection,
  LinearIssueContextPage,
  LinearIssueContextPageLookup,
  LinearIssueContextSection,
  LinearIssueReader,
  LinearIssueWriter,
  LinearIssueUpdate,
  LinearToolDependencies,
  LinearTriageContext,
  LinearWorkflowState,
} from "./types";
export type { TriageResult } from "./submit-triage-result";

export function createLinearTools(
  dependencies: LinearToolDependencies,
  task: AgentTask,
): EggTool[] {
  return [
    ...createLinearIssueReadTools({
      task,
      reader: dependencies.issueReader,
    }),
    createFetchTraceTool(),
    createSubmitTriageResultTool({
      task,
      reader: dependencies.issueReader,
      writer: dependencies.issueWriter,
    }),
  ];
}
