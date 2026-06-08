import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CodexRuntimeHomeOptions {
  runtimeHome: string;
  sourceHome?: string;
  allowedPlugins?: string[];
}

export interface PreparedCodexRuntimeHome {
  homePath: string;
  sourceHomePath: string;
  configPath: string;
  allowedPlugins: string[];
  env: Record<string, string>;
}

const DEFAULT_CODEX_HOME = ".codex";

export async function prepareCodexRuntimeHome(
  options: CodexRuntimeHomeOptions,
): Promise<PreparedCodexRuntimeHome> {
  const homePath = resolve(options.runtimeHome);
  const sourceHomePath = resolve(
    options.sourceHome ?? join(homedir(), DEFAULT_CODEX_HOME),
  );
  const allowedPlugins = options.allowedPlugins ?? [];

  if (homePath === sourceHomePath) {
    throw new Error("CODEX_RUNTIME_HOME must differ from CODEX_SOURCE_HOME");
  }

  await mkdir(homePath, { recursive: true });

  const sourceConfigPath = join(sourceHomePath, "config.toml");
  const configPath = join(homePath, "config.toml");
  const sourceConfig = await readFile(sourceConfigPath, "utf8");
  await writeFile(
    configPath,
    filterCodexConfig(sourceConfig, allowedPlugins),
    "utf8",
  );

  await linkSourceEntry({ sourceHomePath, homePath, name: "auth.json" });
  await linkSourceEntry({ sourceHomePath, homePath, name: "plugins" });
  await linkSourceEntry({ sourceHomePath, homePath, name: "skills" });

  return {
    homePath,
    sourceHomePath,
    configPath,
    allowedPlugins,
    env: {
      ...stringProcessEnv(),
      CODEX_HOME: homePath,
    },
  };
}

function filterCodexConfig(source: string, allowedPlugins: string[]): string {
  const allowedPluginIds = new Set(allowedPlugins);
  const lines = source.split(/\r?\n/);
  const filtered: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.+\]$/.test(trimmed)) {
      const pluginId = pluginIdFromHeader(trimmed);
      skipping = pluginId !== undefined && !allowedPluginIds.has(pluginId);
    }

    if (!skipping) filtered.push(line);
  }

  return filtered.join("\n");
}

function pluginIdFromHeader(header: string): string | undefined {
  return /^\[plugins\."([^"]+)"(?:\..*)?\]$/.exec(header)?.[1];
}

async function linkSourceEntry(input: {
  sourceHomePath: string;
  homePath: string;
  name: string;
}): Promise<void> {
  const sourcePath = join(input.sourceHomePath, input.name);
  const targetPath = join(input.homePath, input.name);
  if (!(await exists(sourcePath))) return;

  if (await exists(targetPath)) {
    const existing = await lstat(targetPath);
    if (!existing.isSymbolicLink()) {
      throw new Error(
        `Cannot prepare Codex runtime home: ${targetPath} exists and is not a symlink`,
      );
    }

    const currentTarget = await readlink(targetPath);
    if (resolve(input.homePath, currentTarget) === sourcePath) return;
    await rm(targetPath, { force: true });
  }

  await symlink(sourcePath, targetPath);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function stringProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
