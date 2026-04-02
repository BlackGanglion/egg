import { Type } from "@mariozechner/pi-ai";
import type { TriageTool } from "./types";

export const SUBMIT_TRIAGE_TOOL_NAME = "submit_triage_result";

export const submitTriageTool: TriageTool = {
  definition: {
    name: SUBMIT_TRIAGE_TOOL_NAME,
    description:
      "提交最终的 issue 分诊结果。分析完成后必须调用此工具提交判断。",
    parameters: Type.Object({
      shouldTriage: Type.Boolean({
        description:
          "该 issue 是否属于自动分类范围。不属于时设为 false。",
      }),
      assigneeId: Type.Union([Type.String(), Type.Null()], {
        description:
          "分配的团队成员 id，无法判断时为 null。",
      }),
      priority: Type.Integer({
        description: "优先级，取值 0-4。",
        minimum: 0,
        maximum: 4,
      }),
      labelIds: Type.Array(Type.String(), {
        description: "标签 id 数组，没有合适标签时为空数组。",
      }),
      reason: Type.String({
        description: "简要说明判断理由（2-3句话），使用中文。",
      }),
    }),
  },

  // Not actually called — result is extracted directly from tool call arguments
  execute: async () => ({
    content: [{ type: "text" as const, text: "ok" }],
    isError: false,
  }),
};
