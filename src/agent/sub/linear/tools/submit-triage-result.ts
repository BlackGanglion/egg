import lodash from "lodash";
import type { AgentTask } from "../../../types";
import { defineToolParameters } from "../../../tool/schema";
import type { EggTool, EggToolResult } from "../../../tool/types";
import type {
  LinearIssueContextLookup,
  LinearIssueReader,
  LinearIssueUpdate,
  LinearIssueWriter,
  LinearTriageContext,
} from "./types";

export interface TriageResult {
  shouldTriage: boolean;
  shouldClose: boolean;
  assigneeId: string | null;
  priority: number;
  labelIds: string[];
  reason: string;
  keepInTriage: boolean;
}

interface SubmitTriageParams {
  shouldTriage?: boolean;
  shouldClose?: boolean;
  assigneeId?: string | null;
  priority?: number;
  labelIds?: string[];
  reason?: string;
  keepInTriage?: boolean;
}

type LinearIssueLookup = Pick<LinearIssueContextLookup, "issueId" | "identifier">;

const { isPlainObject, isString } = lodash;

export function createSubmitTriageResultTool(options: {
  task: AgentTask;
  reader?: LinearIssueReader;
  writer?: LinearIssueWriter;
}): EggTool<SubmitTriageParams> {
  return {
    name: "submit_triage_result",
    description:
      "提交最终的 Linear issue 分诊结果。只有 linear 子 agent 可使用；需要写回 Linear 时必须配置 Linear writer。",
    parameters: defineToolParameters({
      type: "object",
      properties: {
        shouldTriage: {
          type: "boolean",
          description: "该 issue 是否属于自动分类范围。不属于时设为 false。",
        },
        shouldClose: {
          type: "boolean",
          description: "是否直接关闭该 issue。对于误操作、无意义反馈等情况设为 true。",
        },
        assigneeId: {
          type: "string",
          nullable: true,
          description: "分配的团队成员 id，无法判断时为 null。",
        },
        priority: {
          type: "integer",
          minimum: 0,
          maximum: 4,
          description: "Linear priority，取值 0-4。",
        },
        labelIds: {
          type: "array",
          items: { type: "string" },
          description: "标签 id 数组，没有合适标签时为空数组。",
        },
        reason: {
          type: "string",
          description: "简要说明判断理由，使用中文。",
        },
        keepInTriage: {
          type: "boolean",
          description:
            "是否保持 issue 在 Triage 状态。仅在明确需要人工继续处理时设为 true。",
        },
      },
      required: ["shouldTriage", "reason"],
      additionalProperties: false,
    }),
    execute: async (params: SubmitTriageParams): Promise<EggToolResult> => {
      const result = normalizeTriageResult(params);
      const lookup = issueLookupFromTask(options.task);

      if (!result.shouldTriage) {
        return {
          content: [{ type: "text", text: "Skipped: not eligible for auto-triage" }],
          details: {
            result,
            issueId: lookup.issueId,
            identifier: lookup.identifier,
            applied: false,
          },
        };
      }

      const context = await resolveTriageContext(lookup, options.reader);
      const update = buildIssueUpdate(result, context);
      const hasUpdate = Object.keys(update).length > 0;
      const hasComment = Boolean(result.reason);

      if ((hasUpdate || hasComment) && !options.writer) {
        throw new Error("Linear issue writer is not configured");
      }

      if (hasUpdate) {
        await options.writer!.updateIssue(context.issueId, update);
      }

      if (hasComment) {
        await options.writer!.createComment(context.issueId, result.reason);
      }

      return {
        content: [{ type: "text", text: "Triage result applied successfully" }],
        details: {
          result,
          issueId: context.issueId,
          update,
          applied: true,
        },
      };
    },
  };
}

async function resolveTriageContext(
  lookup: LinearIssueLookup,
  reader: LinearIssueReader | undefined,
): Promise<LinearTriageContext> {
  if (!lookup.issueId && !lookup.identifier) {
    throw new Error("submit_triage_result requires issueId or identifier in task context");
  }

  if (!reader) {
    throw new Error("Linear issue reader is not configured");
  }

  const context = await reader.fetchIssueContext({
    issueId: lookup.issueId,
    identifier: lookup.identifier,
    includeComments: false,
    includeTeamContext: true,
  });

  if (!context) {
    throw new Error(
      `Linear issue context not found: ${lookup.identifier ?? lookup.issueId}`,
    );
  }

  return context;
}

function issueLookupFromTask(task: AgentTask): LinearIssueLookup {
  const input = isPlainObject(task.input)
    ? (task.input as Record<string, unknown>)
    : {};
  const nested = isPlainObject(input["issueContext"])
    ? (input["issueContext"] as Record<string, unknown>)
    : isPlainObject(input["triageContext"])
      ? (input["triageContext"] as Record<string, unknown>)
      : undefined;
  const source = nested ?? input;

  return {
    issueId: stringValue(source["issueId"]) ?? stringValue(input["issueId"]),
    identifier:
      stringValue(source["identifier"]) ?? stringValue(input["identifier"]),
  };
}

function stringValue(value: unknown): string | undefined {
  return isString(value) && value ? value : undefined;
}

function normalizeTriageResult(params: SubmitTriageParams): TriageResult {
  return {
    shouldTriage: params.shouldTriage !== false,
    shouldClose: params.shouldClose === true,
    assigneeId: typeof params.assigneeId === "string" ? params.assigneeId : null,
    priority:
      typeof params.priority === "number" && Number.isFinite(params.priority)
        ? Math.max(0, Math.min(4, Math.trunc(params.priority)))
        : 0,
    labelIds: Array.isArray(params.labelIds)
      ? params.labelIds.filter((item): item is string => typeof item === "string")
      : [],
    reason: typeof params.reason === "string" ? params.reason : "",
    keepInTriage: params.keepInTriage === true,
  };
}

function buildIssueUpdate(
  result: TriageResult,
  context: LinearTriageContext,
): LinearIssueUpdate {
  const update: LinearIssueUpdate = {};

  if (result.shouldClose) {
    const canceledState = context.workflowStates.find(
      (state) => state.type === "canceled",
    );
    if (canceledState) update.stateId = canceledState.id;
    return update;
  }

  if (result.assigneeId) update.assigneeId = result.assigneeId;
  if (!context.existing.hasPriority && result.priority > 0) {
    update.priority = result.priority;
  }
  if (!context.existing.hasLabels && result.labelIds.length > 0) {
    update.labelIds = result.labelIds;
  }

  if (context.currentState?.type === "triage" && !result.keepInTriage) {
    const backlogState = context.workflowStates.find(
      (state) => state.type === "backlog",
    );
    if (backlogState) update.stateId = backlogState.id;
  }

  return update;
}
