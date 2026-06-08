import "dotenv/config";
import type {
  ModelReasoningEffort,
  SandboxMode,
} from "@openai/codex-sdk";

export interface AppConfig {
  port: number;
  agentSessionStorePath: string;
  sessionTraceStorePath: string;
  linearAccessToken?: string;
  linearClientId?: string;
  linearClientSecret?: string;
  linearTokenStorePath: string;
  codexMaxConcurrentRuns: number;
  codexModel?: string;
  codexSourceHome?: string;
  codexRuntimeHome: string;
  codexAllowedPlugins: string[];
  codexWorkingDirectory: string;
  codexSandboxMode: SandboxMode;
  codexReasoningEffort?: ModelReasoningEffort;
  codexNetworkAccessEnabled: boolean;
}

export function loadConfig(): AppConfig {
  const sessionsRoot = process.env["AGENT_SESSIONS_ROOT"] ?? ".data/sessions";

  return {
    port: parseInt(process.env["PORT"] ?? "3000", 10),
    agentSessionStorePath:
      process.env["AGENT_SESSION_STORE_PATH"] ?? sessionsRoot,
    sessionTraceStorePath:
      process.env["SESSION_TRACE_STORE_PATH"] ??
      process.env["CHAT_CONTEXT_STORE_PATH"] ??
      sessionsRoot,
    linearAccessToken: optionalString(process.env["LINEAR_ACCESS_TOKEN"]),
    linearClientId: optionalString(process.env["LINEAR_CLIENT_ID"]),
    linearClientSecret: optionalString(process.env["LINEAR_CLIENT_SECRET"]),
    linearTokenStorePath:
      optionalString(process.env["LINEAR_TOKEN_STORE_PATH"]) ??
      optionalString(process.env["TOKEN_STORE_PATH"]) ??
      ".data/oauth-token.json",
    codexMaxConcurrentRuns: parseInt(process.env["CODEX_MAX_CONCURRENT_RUNS"] ?? "2", 10),
    codexModel: optionalString(process.env["CODEX_MODEL"]),
    codexSourceHome:
      optionalString(process.env["CODEX_SOURCE_HOME"]) ??
      optionalString(process.env["CODEX_HOME"]),
    codexRuntimeHome:
      optionalString(process.env["CODEX_RUNTIME_HOME"]) ?? ".data/codex-home",
    codexAllowedPlugins: parseStringList(
      process.env["CODEX_ALLOWED_PLUGINS"],
      [],
    ),
    codexWorkingDirectory:
      optionalString(process.env["CODEX_WORKING_DIRECTORY"]) ?? process.cwd(),
    codexSandboxMode: parseSandboxMode(
      process.env["CODEX_SANDBOX_MODE"] ?? process.env["CODEX_SANDBOX"],
    ),
    codexReasoningEffort: parseReasoningEffort(
      process.env["CODEX_REASONING_EFFORT"],
    ),
    codexNetworkAccessEnabled: parseBoolean(
      process.env["CODEX_NETWORK_ACCESS"],
      false,
    ),
  };
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseStringList(
  value: string | undefined,
  fallback: string[],
): string[] {
  const parsed = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed && parsed.length > 0 ? parsed : fallback;
}

function parseSandboxMode(value: string | undefined): SandboxMode {
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  ) {
    return value;
  }

  return "read-only";
}

function parseReasoningEffort(
  value: string | undefined,
): ModelReasoningEffort | undefined {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }

  return undefined;
}
