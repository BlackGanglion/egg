import lodash from "lodash";
import type { AgentTask } from "../../../types";
import { defineToolParameters } from "../../../tool/schema";
import type { EggTool, EggToolResult } from "../../../tool/types";
import type {
  LinearIssueContextPage,
  LinearIssueContextOverview,
  LinearIssueDetailSection,
  LinearIssueReader,
  LinearTeamMember,
  LinearWorkflowState,
} from "./types";

const { isArray, isNumber, isPlainObject, isString } = lodash;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

interface FetchLinearIssueParams {
  issueId?: string;
  identifier?: string;
  cursor?: string;
  limit?: number;
}

type LinearIssueLookup = Pick<FetchLinearIssueParams, "issueId" | "identifier">;

export function createLinearIssueReadTools(options: {
  task: AgentTask;
  reader?: LinearIssueReader;
}): EggTool[] {
  return [
    createFetchLinearIssueOverviewTool(options),
    createFetchLinearIssuePageTool({
      ...options,
      name: "fetch_linear_issue_comments",
      section: "comments",
      description:
        "分页读取 Linear issue comments。返回 items 和 pageInfo.nextCursor；如果 hasMore 为 true，继续传入 nextCursor。",
    }),
    createFetchLinearIssuePageTool({
      ...options,
      name: "fetch_linear_issue_team_members",
      section: "teamMembers",
      description:
        "分页读取 Linear issue 所属 team 的可分配成员。返回 items 和 pageInfo.nextCursor。",
    }),
    createFetchLinearIssuePageTool({
      ...options,
      name: "fetch_linear_issue_labels",
      section: "availableLabels",
      description:
        "分页读取 Linear issue 所属 team 的可用 labels。返回 items 和 pageInfo.nextCursor。",
    }),
    createFetchLinearIssuePageTool({
      ...options,
      name: "fetch_linear_issue_workflow_states",
      section: "workflowStates",
      description:
        "分页读取 Linear issue 所属 team 的 workflow states。返回 items 和 pageInfo.nextCursor。",
    }),
  ];
}

function createFetchLinearIssueOverviewTool(options: {
  task: AgentTask;
  reader?: LinearIssueReader;
}): EggTool<FetchLinearIssueParams> {
  return {
    name: "fetch_linear_issue_overview",
    description:
      "读取 Linear issue overview，包括标题、描述、当前状态、负责人、已有 priority/labels，以及后续可调用的分段读取工具。",
    parameters: issueLookupParameters(),
    execute: async (params: FetchLinearIssueParams): Promise<EggToolResult> => {
      const taskContext = issueContextFromTask(options.task);
      const lookup = issueLookup(params, options.task, taskContext);

      if (taskContext && (!options.reader || (!lookup.issueId && !lookup.identifier))) {
        return overviewResult({
          source: "task",
          lookup,
          overview: overviewFromTaskContext(taskContext, lookup),
        });
      }

      assertLookup(lookup, "fetch_linear_issue_overview");
      if (!options.reader) {
        throw new Error("Linear issue reader is not configured");
      }

      const page = await options.reader.fetchIssueContextPage({
        ...lookup,
        section: "overview",
        limit: 1,
      });
      const overview = page?.items[0] as LinearIssueContextOverview | undefined;

      return overviewResult({
        source: "reader",
        lookup,
        overview: overview ?? null,
      });
    },
  };
}

function createFetchLinearIssuePageTool(options: {
  task: AgentTask;
  reader?: LinearIssueReader;
  name: string;
  section: LinearIssueDetailSection;
  description: string;
}): EggTool<FetchLinearIssueParams> {
  return {
    name: options.name,
    description: options.description,
    parameters: pagedIssueLookupParameters(),
    execute: async (params: FetchLinearIssueParams): Promise<EggToolResult> => {
      const taskContext = issueContextFromTask(options.task);
      const lookup = issueLookup(params, options.task, taskContext);
      const cursor = stringValue(params.cursor);
      const limit = limitValue(params.limit);

      if (taskContext && (!options.reader || (!lookup.issueId && !lookup.identifier))) {
        return pageResult({
          source: "task",
          lookup,
          page: pageFromTaskContext(taskContext, options.section, cursor, limit),
        });
      }

      assertLookup(lookup, options.name);
      if (!options.reader) {
        throw new Error("Linear issue reader is not configured");
      }

      const page = await options.reader.fetchIssueContextPage({
        ...lookup,
        section: options.section,
        cursor,
        limit,
      });

      return pageResult({
        source: "reader",
        lookup,
        page,
      });
    },
  };
}

function issueLookupParameters() {
  return defineToolParameters({
    type: "object",
    properties: {
      issueId: {
        type: "string",
        description: "Linear issue id。未传时会尝试使用当前 task.input.issueId。",
      },
      identifier: {
        type: "string",
        description: "Linear issue identifier，例如 YOU-19934。未传时会尝试使用当前 task.input.identifier。",
      },
    },
    additionalProperties: false,
  });
}

function pagedIssueLookupParameters() {
  return defineToolParameters({
    type: "object",
    properties: {
      issueId: {
        type: "string",
        description: "Linear issue id。未传时会尝试使用当前 task.input.issueId。",
      },
      identifier: {
        type: "string",
        description: "Linear issue identifier，例如 YOU-19934。未传时会尝试使用当前 task.input.identifier。",
      },
      cursor: {
        type: "string",
        description:
          "上一页返回的 pageInfo.nextCursor。不要自行构造，原样传回即可。",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_PAGE_LIMIT,
        description: `本页最多返回多少条，默认 ${DEFAULT_PAGE_LIMIT}，最大 ${MAX_PAGE_LIMIT}。`,
      },
    },
    additionalProperties: false,
  });
}

function overviewResult(input: {
  source: "task" | "reader";
  lookup: LinearIssueLookup;
  overview: LinearIssueContextOverview | null;
}): EggToolResult {
  return jsonResult({
    content: {
      source: input.source,
      lookup: input.lookup,
      overview: input.overview,
    },
    details: input,
  });
}

function pageResult(input: {
  source: "task" | "reader";
  lookup: LinearIssueLookup;
  page: LinearIssueContextPage | null;
}): EggToolResult {
  return jsonResult({
    content: {
      source: input.source,
      lookup: input.lookup,
      page: input.page,
      usage:
        input.page?.pageInfo.nextCursor
          ? "继续读取时，原样传入 pageInfo.nextCursor 作为 cursor。"
          : undefined,
    },
    details: input,
  });
}

function issueLookup(
  params: FetchLinearIssueParams,
  task: AgentTask,
  taskContext: Record<string, unknown> | undefined,
): LinearIssueLookup {
  const input = isPlainObject(task.input)
    ? (task.input as Record<string, unknown>)
    : {};

  return {
    issueId:
      stringValue(params.issueId) ??
      stringValue(input["issueId"]) ??
      stringValue(taskContext?.["issueId"]),
    identifier:
      stringValue(params.identifier) ??
      stringValue(input["identifier"]) ??
      stringValue(taskContext?.["identifier"]),
  };
}

function assertLookup(lookup: LinearIssueLookup, toolName: string): void {
  if (!lookup.issueId && !lookup.identifier) {
    throw new Error(`${toolName} requires issueId or identifier`);
  }
}

function overviewFromTaskContext(
  context: Record<string, unknown>,
  lookup: LinearIssueLookup,
): LinearIssueContextOverview {
  const existing = recordValue(context["existing"]);
  const priority = existing?.["priority"];
  return {
    issueId: stringValue(context["issueId"]) ?? lookup.issueId ?? "",
    identifier: stringValue(context["identifier"]) ?? lookup.identifier,
    title: stringValue(context["title"]) ?? "",
    description: stringValue(context["description"]) ?? "",
    url: stringValue(context["url"]),
    teamId: stringValue(context["teamId"]),
    teamKey: stringValue(context["teamKey"]),
    teamName: stringValue(context["teamName"]),
    assignee: teamMemberValue(context["assignee"]),
    currentState: workflowStateValue(context["currentState"]),
    workflowStates: workflowStatesFromTask(context),
    existing: {
      hasPriority: existing?.["hasPriority"] === true,
      priority: isNumber(priority) && Number.isFinite(priority) ? priority : undefined,
      hasLabels: existing?.["hasLabels"] === true,
      labelNames: arrayValue(existing?.["labelNames"]).filter(isString),
    },
    sections: sectionRequests(lookup),
  };
}

function workflowStatesFromTask(
  context: Record<string, unknown>,
): LinearWorkflowState[] {
  return arrayValue(context["workflowStates"]).flatMap((item) => {
    const state = workflowStateValue(item);
    return state ? [state] : [];
  });
}

function sectionRequests(lookup: LinearIssueLookup): LinearIssueContextOverview["sections"] {
  const base = {
    issueId: lookup.issueId,
    identifier: lookup.identifier,
    limit: DEFAULT_PAGE_LIMIT,
  };
  return {
    comments: {
      tool: "fetch_linear_issue_comments",
      description: "Issue comments.",
      request: base,
    },
    teamMembers: {
      tool: "fetch_linear_issue_team_members",
      description: "Assignable team members.",
      request: base,
    },
    availableLabels: {
      tool: "fetch_linear_issue_labels",
      description: "Available issue labels.",
      request: base,
    },
    workflowStates: {
      tool: "fetch_linear_issue_workflow_states",
      description: "Team workflow states.",
      request: base,
    },
  };
}

function pageFromTaskContext(
  context: Record<string, unknown>,
  section: LinearIssueDetailSection,
  cursor: string | undefined,
  limit: number,
): LinearIssueContextPage {
  const values = valuesForTaskSection(context, section);
  const offset = cursorToOffset(cursor);
  const pageItems = values.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;

  return {
    issueId: stringValue(context["issueId"]),
    identifier: stringValue(context["identifier"]),
    section,
    items: pageItems,
    pageInfo: {
      limit,
      cursor,
      nextCursor: nextOffset < values.length ? String(nextOffset) : undefined,
      hasMore: nextOffset < values.length,
    },
  };
}

function valuesForTaskSection(
  context: Record<string, unknown>,
  section: LinearIssueDetailSection,
): unknown[] {
  return arrayValue(context[section]);
}

function issueContextFromTask(task: AgentTask): Record<string, unknown> | undefined {
  const input = isPlainObject(task.input)
    ? (task.input as Record<string, unknown>)
    : {};
  return (
    recordValue(input["issueContext"]) ??
    recordValue(input["triageContext"]) ??
    recordValue(input["linearIssue"]) ??
    recordValue(input["issue"])
  );
}

function teamMemberValue(value: unknown): LinearTeamMember | undefined {
  const record = recordValue(value);
  const id = stringValue(record?.["id"]);
  const name = stringValue(record?.["name"]);
  if (!id || !name) return undefined;

  return {
    id,
    name,
    displayName: stringValue(record?.["displayName"]),
  };
}

function workflowStateValue(value: unknown): LinearWorkflowState | undefined {
  const record = recordValue(value);
  const id = stringValue(record?.["id"]);
  const type = stringValue(record?.["type"]);
  if (!id || !type) return undefined;
  return {
    id,
    type,
    name: stringValue(record?.["name"]),
  };
}

function limitValue(value: unknown): number {
  if (!isNumber(value) || !Number.isFinite(value)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.trunc(value)));
}

function cursorToOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number.parseInt(cursor, 10);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? (value as Record<string, unknown>) : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return isString(value) && value ? value : undefined;
}

function jsonResult(input: {
  content: unknown;
  details?: unknown;
}): EggToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(input.content, null, 2) }],
    details: input.details,
  };
}
