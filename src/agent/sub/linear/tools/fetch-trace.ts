import { defineToolParameters } from "../../../tool/schema";
import type { EggTool, EggToolResult } from "../../../tool/types";

const LANGFUSE_BASE_URL = "https://lab.gooo.ai/api/public";
const MAX_MESSAGE_LENGTH = 500;
const MAX_TOTAL_LENGTH = 4000;

interface FetchTraceParams {
  url?: string;
  mode?: "tools" | "conversation";
}

interface Observation {
  id: string;
  name: string;
  type: string;
  level: string;
  statusMessage: string | null;
  input: unknown;
  output: unknown;
  parentObservationId: string | null;
}

export function createFetchTraceTool(): EggTool<FetchTraceParams> {
  return {
    name: "fetch_trace",
    description:
      "从 lab.gooo.ai 获取 trace 详情。tools 模式提取工具调用和异常；conversation 模式提取用户输入和最终助手输出。",
    parameters: defineToolParameters({
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "完整的 lab.gooo.ai trace 链接，如 https://lab.gooo.ai/project/abc123/traces/def456",
        },
        mode: {
          type: "string",
          enum: ["tools", "conversation"],
          description:
            "提取模式。tools：工具调用和异常信息；conversation：LLM 对话内容。",
        },
      },
      required: ["url"],
      additionalProperties: false,
    }),
    execute: async (params: FetchTraceParams): Promise<EggToolResult> => {
      const url = typeof params.url === "string" ? params.url : "";
      const mode = params.mode ?? "tools";
      const traceId = parseTraceId(url);

      if (!traceId) {
        throw new Error(`Could not parse traceId from URL: ${url}`);
      }

      const observations = await fetchObservations(traceId);
      const text =
        mode === "conversation"
          ? summarizeConversation(observations)
          : summarizeToolCalls(observations);

      return {
        content: [{ type: "text", text }],
        details: { traceId, mode },
      };
    },
  };
}

function parseTraceId(url: string): string | null {
  const match = url.match(
    /https?:\/\/lab\.gooo\.ai\/project\/[^/]+\/traces\/([a-f0-9]+)/,
  );
  return match?.[1] ?? null;
}

async function fetchObservations(traceId: string): Promise<Observation[]> {
  const publicKey = process.env["LANGFUSE_PUBLIC_KEY"] ?? "";
  const secretKey = process.env["LANGFUSE_SECRET_KEY"] ?? "";

  if (!publicKey || !secretKey) {
    throw new Error("LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY not configured");
  }

  const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const response = await fetch(
    `${LANGFUSE_BASE_URL}/observations?traceId=${traceId}`,
    { headers: { Authorization: `Basic ${credentials}` } },
  );

  if (!response.ok) {
    throw new Error(
      `Langfuse observations API returned ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as { data?: Observation[] };
  return body.data ?? [];
}

function summarizeToolCalls(observations: Observation[]): string {
  const toolCounts = new Map<string, number>();
  const errors: Array<{ tool: string; error: string }> = [];

  for (const observation of observations) {
    if (!observation.name.startsWith("call-tool-")) continue;

    const toolName = observation.name.replace("call-tool-", "");
    toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);

    if (observation.level === "ERROR") {
      errors.push({
        tool: toolName,
        error: extractObservationError(observation, observations),
      });
    }
  }

  if (errors.length > 0) {
    return errors.map((item) => `${item.tool} tool 出现异常: ${item.error}`).join("\n");
  }

  const toolSummary = [...toolCounts.entries()]
    .map(([name, count]) => `${name}(${count}次)`)
    .join(", ");

  if (toolSummary) return `调用了 ${toolSummary} tool，未发现异常`;
  return "该 trace 中未发现 tool 调用记录";
}

function extractObservationError(
  observation: Observation,
  observations: Observation[],
): string {
  let errorMessage = observation.statusMessage ?? "";

  if (!errorMessage && observation.output && typeof observation.output === "object") {
    const output = observation.output as Record<string, unknown>;
    if (typeof output["value"] === "string") {
      errorMessage = parseOutputMessage(output["value"]);
    } else if (typeof output["message"] === "string") {
      errorMessage = output["message"];
    }
  }

  if (!errorMessage) {
    const parent = observations.find(
      (item) =>
        item.id === observation.parentObservationId && item.level === "ERROR",
    );
    errorMessage = parent?.statusMessage ?? "";
  }

  return errorMessage || "unknown error";
}

function parseOutputMessage(value: string): string {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed["message"] === "string" ? parsed["message"] : value;
  } catch {
    return value;
  }
}

function summarizeConversation(observations: Observation[]): string {
  const generations = observations.filter((item) => item.type === "GENERATION");
  if (generations.length === 0) return "该 trace 中未发现 LLM 对话记录";

  const userMessage = firstUserMessage(generations);
  const assistantMessage = lastAssistantMessage(generations);
  const parts: string[] = [];

  if (userMessage) {
    parts.push(`[用户原始输入] ${truncate(userMessage, MAX_MESSAGE_LENGTH)}`);
  }
  if (assistantMessage) {
    parts.push(
      `[最终助手输出] ${truncate(
        assistantMessage,
        MAX_TOTAL_LENGTH - MAX_MESSAGE_LENGTH,
      )}`,
    );
  }

  return parts.length > 0
    ? parts.join("\n\n")
    : "该 trace 中未提取到有效的对话内容";
}

function firstUserMessage(generations: Observation[]): string {
  for (const generation of generations) {
    if (!generation.input || typeof generation.input !== "object") continue;
    const input = generation.input as Record<string, unknown>;
    const messages = input["messages"];
    if (!Array.isArray(messages)) continue;

    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const record = message as Record<string, unknown>;
      if (record["role"] !== "user") continue;
      const text = extractMessageText(record);
      if (text) return text;
    }
  }

  return "";
}

function lastAssistantMessage(generations: Observation[]): string {
  for (let index = generations.length - 1; index >= 0; index--) {
    const generation = generations[index];
    if (!generation) continue;
    const text = extractAssistantOutput(generation);
    if (text) return text;
  }

  return "";
}

function extractMessageText(message: Record<string, unknown>): string {
  const content = message["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .flatMap((part): string[] => {
      if (!part || typeof part !== "object") return [];
      const record = part as Record<string, unknown>;
      return record["type"] === "text" && typeof record["text"] === "string"
        ? [record["text"]]
        : [];
    })
    .join("\n");
}

function extractAssistantOutput(generation: Observation): string {
  if (!generation.output || typeof generation.output !== "object") return "";
  const output = generation.output as Record<string, unknown>;
  if (typeof output["content"] === "string") return output["content"];

  const message = output["message"];
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  return typeof record["content"] === "string" ? record["content"] : "";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...（已截断）`;
}
