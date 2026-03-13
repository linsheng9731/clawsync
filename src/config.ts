import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import type { SyncComponent, SyncConfig, UnpackStrategy } from "./types.js";

const ALL_COMPONENTS: SyncComponent[] = [
  "config",
  "workspace",
  "credentials",
  "sessions",
  "tools",
  "media",
];

const DEFAULT_INCLUDE: SyncComponent[] = ["config", "workspace"];
const DEFAULT_EXCLUDE: SyncComponent[] = ["credentials", "sessions", "tools", "media"];

interface FileConfig {
  include?: SyncComponent[];
  exclude?: SyncComponent[];
  ignorePaths?: string[];
  workspaceIncludeGlobs?: string[];
  stateDir?: string;
  strategy?: UnpackStrategy;
  sanitize?: boolean;
}

function expandUserPath(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

export function resolveStateDir(explicitStateDir?: string): string {
  if (explicitStateDir) return path.resolve(expandUserPath(explicitStateDir));
  if (process.env.OPENCLAW_STATE_DIR?.trim()) return path.resolve(expandUserPath(process.env.OPENCLAW_STATE_DIR.trim()));
  return path.join(os.homedir(), ".openclaw");
}

export async function loadConfigFile(configPath?: string): Promise<FileConfig> {
  const defaultPath = path.join(resolveStateDir(), "clawsync.json");
  const targetPath = configPath ? path.resolve(configPath) : defaultPath;
  const exists = await fs.pathExists(targetPath);
  if (!exists) return {};
  return fs.readJson(targetPath);
}

function parseComponents(raw?: string): SyncComponent[] | undefined {
  if (!raw) return undefined;
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = tokens.filter((t) => !ALL_COMPONENTS.includes(t as SyncComponent));
  if (invalid.length > 0) {
    throw new Error(`Invalid components: ${invalid.join(", ")}. Allowed: ${ALL_COMPONENTS.join(", ")}`);
  }
  return tokens as SyncComponent[];
}

function normalizeRelativePath(input: string): string {
  const trimmed = input.trim();
  const noLeadingDot = trimmed.replace(/^\.\//, "");
  return noLeadingDot.replaceAll("\\", "/").replace(/\/+$/, "");
}

function parseIgnorePaths(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const tokens = raw
    .split(",")
    .map(normalizeRelativePath)
    .filter(Boolean);
  return Array.from(new Set(tokens));
}

function parseWorkspaceIncludeGlobs(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const tokens = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replaceAll("\\", "/"));
  return Array.from(new Set(tokens));
}

export async function buildSyncConfig(options: {
  stateDir?: string;
  config?: string;
  include?: string;
  exclude?: string;
  ignorePaths?: string;
  workspaceIncludeGlobs?: string;
  strategy?: UnpackStrategy;
  sanitize?: boolean;
}): Promise<SyncConfig> {
  const fileConfig = await loadConfigFile(options.config);
  const includeFromCli = parseComponents(options.include);
  const excludeFromCli = parseComponents(options.exclude);
  const ignorePathsFromCli = parseIgnorePaths(options.ignorePaths);
  const workspaceIncludeGlobsFromCli = parseWorkspaceIncludeGlobs(options.workspaceIncludeGlobs);

  const include = includeFromCli ?? fileConfig.include ?? DEFAULT_INCLUDE;
  const exclude = excludeFromCli ?? fileConfig.exclude ?? DEFAULT_EXCLUDE;
  const ignorePaths = ignorePathsFromCli ?? fileConfig.ignorePaths ?? [];
  const workspaceIncludeGlobs = workspaceIncludeGlobsFromCli ?? fileConfig.workspaceIncludeGlobs ?? [];
  const strategy = options.strategy ?? fileConfig.strategy ?? "overwrite";
  const sanitize = options.sanitize ?? fileConfig.sanitize ?? true;

  return {
    stateDir: resolveStateDir(options.stateDir ?? fileConfig.stateDir),
    include,
    exclude,
    ignorePaths,
    workspaceIncludeGlobs,
    strategy,
    format: "tar",
    sanitize,
  };
}

export function listComponents(): SyncComponent[] {
  return [...ALL_COMPONENTS];
}
