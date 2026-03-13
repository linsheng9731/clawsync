import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import * as tar from "tar";
import { resolveExistingPaths } from "./scope.js";
import { sanitizeStagingPayload, toCmdScript, toPosixScript, toPowerShellScript } from "./sanitize.js";
import type {
  Manifest,
  MergeConflictItem,
  MergeReport,
  ScopeEntry,
  SyncConfig,
  SyncComponent,
  UnpackResult,
  UnpackStrategy,
} from "./types.js";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function toPortablePath(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

function toFsPath(relPath: string): string {
  return relPath.split("/").join(path.sep);
}

function normalizeRelativePath(input: string): string {
  return input.replace(/^\.\//, "").replaceAll("\\", "/").replace(/\/+$/, "");
}

function isIgnoredPath(relPath: string, ignorePaths: string[]): boolean {
  if (ignorePaths.length === 0) return false;
  const normalizedPath = normalizeRelativePath(relPath);
  return ignorePaths.some((raw) => {
    const normalizedIgnore = normalizeRelativePath(raw);
    if (!normalizedIgnore) return false;
    if (normalizedPath === normalizedIgnore) return true;
    return normalizedPath.startsWith(`${normalizedIgnore}/`);
  });
}

export interface PackScanItem {
  component: SyncComponent;
  relPath: string;
  sizeBytes: number;
}

export type PackScanAction =
  | "included-default"
  | "included-config"
  | "included-by-user-rule"
  | "ignored-by-config"
  | "excluded-non-config";

export interface PackScanDecision extends PackScanItem {
  action: PackScanAction;
}

export interface PackScanSummary {
  scannedFiles: number;
  scannedBytes: number;
  ignoredFiles: number;
  ignoredBytes: number;
  excludedNonConfigFiles: number;
  excludedNonConfigBytes: number;
  includedConfigFiles: number;
  includedConfigBytes: number;
  includedByUserRuleFiles: number;
  includedByUserRuleBytes: number;
  selectedFiles: number;
  selectedBytes: number;
  largestItems: PackScanDecision[];
}

async function collectEntryFiles(
  baseDir: string,
  entry: ScopeEntry,
  config: SyncConfig,
  relPath = entry.relPath,
): Promise<PackScanItem[]> {
  const fullPath = path.join(baseDir, relPath);
  const stat = await fs.stat(fullPath);
  if (stat.isFile()) {
    const portablePath = toPortablePath(relPath);
    if (entry.component === "workspace") {
      const whitelistedByDefault = isWorkspaceWhitelistedByDefault(portablePath);
      const whitelistedByUserRule = matchesWorkspaceIncludeRule(portablePath, config.workspaceIncludeGlobs);
      if (!whitelistedByDefault && !whitelistedByUserRule) {
        return [];
      }
    }
    return [{ component: entry.component, relPath: portablePath, sizeBytes: stat.size }];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const children = await fs.readdir(fullPath);
  const files: PackScanItem[] = [];
  const hasWorkspaceUserRules = config.workspaceIncludeGlobs.length > 0;
  for (const child of children) {
    if (entry.component === "workspace" && relPath === entry.relPath && !hasWorkspaceUserRules) {
      if (!WORKSPACE_DEFAULT_WHITELIST_DIRS.has(child)) {
        continue;
      }
    }
    files.push(...(await collectEntryFiles(baseDir, entry, config, path.join(relPath, child))));
  }
  return files;
}

async function collectScannedFiles(config: SyncConfig): Promise<PackScanItem[]> {
  const entries = await resolveExistingPaths(config);
  const scanned: PackScanItem[] = [];
  for (const entry of entries) {
    scanned.push(...(await collectEntryFiles(config.stateDir, entry, config)));
  }
  return scanned;
}

function toGlobRegex(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let out = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === "*") {
      const next = normalized[i + 1];
      if (next === "*") {
        const after = normalized[i + 2];
        if (after === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (/[$()*+.?[\\\]^{|}]/.test(ch)) {
      out += `\\${ch}`;
      continue;
    }
    out += ch;
  }
  out += "$";
  return new RegExp(out);
}

const WORKSPACE_DEFAULT_WHITELIST_DIRS = new Set(["memory", "skills", "config"]);

function isWorkspaceWhitelistedByDefault(relPath: string): boolean {
  if (!relPath.startsWith("workspace/")) return false;
  const topLevelDir = relPath.split("/")[1];
  return WORKSPACE_DEFAULT_WHITELIST_DIRS.has(topLevelDir);
}

function normalizeWorkspacePattern(pattern: string): string {
  const normalized = pattern.trim().replaceAll("\\", "/");
  if (!normalized) return normalized;
  if (normalized.endsWith("/")) return `${normalized}**`;
  return normalized;
}

function matchesWorkspaceIncludeRule(relPath: string, patterns: string[]): boolean {
  if (!relPath.startsWith("workspace/")) return false;
  if (patterns.length === 0) return false;
  const workspaceRelative = relPath.slice("workspace/".length);
  return patterns.some((raw) => {
    const normalized = normalizeWorkspacePattern(raw);
    if (!normalized) return false;
    const regex = toGlobRegex(normalized);
    return regex.test(workspaceRelative) || regex.test(relPath);
  });
}

function buildPackDecision(item: PackScanItem, config: SyncConfig): PackScanDecision {
  if (isIgnoredPath(item.relPath, config.ignorePaths)) {
    return { ...item, action: "ignored-by-config" };
  }
  if (item.component === "workspace") {
    if (isWorkspaceWhitelistedByDefault(item.relPath)) {
      return { ...item, action: "included-config" };
    }
    if (matchesWorkspaceIncludeRule(item.relPath, config.workspaceIncludeGlobs)) {
      return { ...item, action: "included-by-user-rule" };
    }
    return { ...item, action: "excluded-non-config" };
  }
  return { ...item, action: "included-default" };
}

function summarizePackScan(scanned: PackScanItem[], config: SyncConfig, topN: number): {
  summary: PackScanSummary;
  selectedItems: PackScanDecision[];
  allDecisions: PackScanDecision[];
} {
  const decisions = scanned.map((item) => buildPackDecision(item, config));
  const selectedItems = decisions.filter((item) =>
    item.action === "included-default" ||
    item.action === "included-config" ||
    item.action === "included-by-user-rule"
  );
  const ignoredItems = decisions.filter((item) => item.action === "ignored-by-config");
  const excludedNonConfigItems = decisions.filter((item) => item.action === "excluded-non-config");
  const includedConfigItems = decisions.filter((item) => item.action === "included-config");
  const includedByUserRuleItems = decisions.filter((item) => item.action === "included-by-user-rule");
  const bySizeDesc = [...selectedItems].sort((a, b) => b.sizeBytes - a.sizeBytes);

  const sumBytes = (items: Array<{ sizeBytes: number }>): number => items.reduce((acc, item) => acc + item.sizeBytes, 0);
  const summary: PackScanSummary = {
    scannedFiles: scanned.length,
    scannedBytes: sumBytes(scanned),
    ignoredFiles: ignoredItems.length,
    ignoredBytes: sumBytes(ignoredItems),
    excludedNonConfigFiles: excludedNonConfigItems.length,
    excludedNonConfigBytes: sumBytes(excludedNonConfigItems),
    includedConfigFiles: includedConfigItems.length,
    includedConfigBytes: sumBytes(includedConfigItems),
    includedByUserRuleFiles: includedByUserRuleItems.length,
    includedByUserRuleBytes: sumBytes(includedByUserRuleItems),
    selectedFiles: selectedItems.length,
    selectedBytes: sumBytes(selectedItems),
    largestItems: bySizeDesc.slice(0, Math.max(0, topN)),
  };
  return { summary, selectedItems, allDecisions: decisions };
}

export async function scanPackState(
  config: SyncConfig,
  options?: {
    topN?: number;
    onProgress?: (item: PackScanDecision) => void;
  },
): Promise<PackScanSummary> {
  const scanned = await collectScannedFiles(config);
  const { summary, allDecisions } = summarizePackScan(scanned, config, options?.topN ?? 5);
  for (const item of allDecisions) {
    options?.onProgress?.(item);
  }
  return summary;
}

export interface PreviewResult {
  files: string[];
  sanitized: boolean;
  envVars: string[];
}

export async function previewPackState(config: SyncConfig): Promise<PreviewResult> {
  const scanned = await collectScannedFiles(config);
  const { selectedItems } = summarizePackScan(scanned, config, 0);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clawsync-preview-"));
  const payload = path.join(tempRoot, "payload");
  await fs.ensureDir(payload);

  const files: string[] = [];
  for (const item of selectedItems) {
    const relPath = toFsPath(item.relPath);
    const src = path.join(config.stateDir, relPath);
    const dest = path.join(payload, relPath);
    await fs.ensureDir(path.dirname(dest));
    await fs.copyFile(src, dest);
    files.push(item.relPath);
  }

  if (!config.sanitize) {
    return { files: files.sort(), sanitized: false, envVars: [] };
  }
  const result = await sanitizeStagingPayload(payload);
  return {
    files: files.sort(),
    sanitized: result.sanitized,
    envVars: Object.keys(result.envMap).sort(),
  };
}

export async function packState(config: SyncConfig, outDir?: string): Promise<{ archivePath: string; manifest: Manifest }> {
  const scanned = await collectScannedFiles(config);
  const { selectedItems } = summarizePackScan(scanned, config, 0);
  const tempRoot = outDir ? path.resolve(outDir) : await fs.mkdtemp(path.join(os.tmpdir(), "clawsync-"));
  await fs.ensureDir(tempRoot);
  const staging = path.join(tempRoot, "staging");
  const payload = path.join(staging, "payload");
  await fs.ensureDir(payload);

  const files: string[] = [];
  for (const item of selectedItems) {
    const relPath = toFsPath(item.relPath);
    const src = path.join(config.stateDir, relPath);
    const dest = path.join(payload, relPath);
    await fs.ensureDir(path.dirname(dest));
    await fs.copyFile(src, dest);
    files.push(item.relPath);
  }

  let envMap: Record<string, string> = {};
  let sanitized = false;
  if (config.sanitize) {
    const result = await sanitizeStagingPayload(payload);
    envMap = result.envMap;
    sanitized = result.sanitized;
  }

  await fs.writeJson(path.join(staging, "secrets.json"), envMap, { spaces: 2 });

  const manifest: Manifest = {
    createdAt: new Date().toISOString(),
    stateDir: config.stateDir,
    include: config.include,
    exclude: config.exclude,
    ignorePaths: config.ignorePaths.length > 0 ? [...config.ignorePaths] : undefined,
    workspaceIncludeGlobs: config.workspaceIncludeGlobs.length > 0 ? [...config.workspaceIncludeGlobs] : undefined,
    files: files.sort(),
    sanitized,
    envVars: Object.keys(envMap).sort(),
  };
  await fs.writeJson(path.join(staging, "manifest.json"), manifest, { spaces: 2 });

  const archivePath = path.join(tempRoot, `clawsync-${timestamp()}.tar.gz`);
  await tar.create(
    {
      gzip: true,
      cwd: staging,
      file: archivePath,
    },
    ["manifest.json", "payload", "secrets.json"],
  );

  return { archivePath, manifest };
}

export async function unpackState(
  archivePath: string,
  targetStateDir: string,
  strategy: UnpackStrategy,
  envScriptDir?: string,
): Promise<UnpackResult> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clawsync-unpack-"));
  await tar.extract({ file: archivePath, cwd: tempRoot, gzip: true });

  const manifestPath = path.join(tempRoot, "manifest.json");
  const payloadRoot = path.join(tempRoot, "payload");
  const secretsPath = path.join(tempRoot, "secrets.json");
  const manifest = await fs.readJson(manifestPath) as Manifest;
  const conflicts: MergeConflictItem[] = [];
  let mergedNewFiles = 0;
  let keptLocalFiles = 0;

  async function compareContent(srcPath: string, destPath: string): Promise<boolean | "unreadable"> {
    try {
      const [srcContent, destContent] = await Promise.all([fs.readFile(srcPath), fs.readFile(destPath)]);
      return srcContent.equals(destContent);
    } catch {
      return "unreadable";
    }
  }

  for (const relPath of manifest.files) {
    const src = path.join(payloadRoot, relPath);
    const dest = path.join(targetStateDir, relPath);
    const destExists = await fs.pathExists(dest);

    if (strategy === "skip") {
      if (destExists) continue;
      await fs.copy(src, dest, { overwrite: false, errorOnExist: false });
      continue;
    }
    if (strategy === "overwrite") {
      await fs.copy(src, dest, { overwrite: true, errorOnExist: false });
      continue;
    }

    if (!destExists) {
      await fs.copy(src, dest, { overwrite: false, errorOnExist: false });
      mergedNewFiles += 1;
      continue;
    }

    const [srcStat, destStat] = await Promise.all([fs.stat(src), fs.stat(dest)]);
    const srcType = srcStat.isDirectory() ? "dir" : srcStat.isFile() ? "file" : "other";
    const destType = destStat.isDirectory() ? "dir" : destStat.isFile() ? "file" : "other";
    if (srcType !== destType) {
      conflicts.push({ path: relPath, reason: "type-mismatch" });
      keptLocalFiles += 1;
      continue;
    }

    if (srcType === "dir") {
      // Top-level directory entries are considered merged when local path already exists.
      continue;
    }

    const sameContent = await compareContent(src, dest);
    if (sameContent === true) continue;
    if (sameContent === "unreadable") {
      conflicts.push({ path: relPath, reason: "unreadable" });
      keptLocalFiles += 1;
      continue;
    }

    conflicts.push({ path: relPath, reason: "content-different" });
    keptLocalFiles += 1;
  }

  if (await fs.pathExists(secretsPath)) {
    const envMap = await fs.readJson(secretsPath) as Record<string, string>;
    if (Object.keys(envMap).length > 0) {
      const scriptRoot = envScriptDir
        ? path.resolve(envScriptDir)
        : path.join(targetStateDir, "clawsync");
      await fs.ensureDir(scriptRoot);

      const shPath = path.join(scriptRoot, "env-export.sh");
      const ps1Path = path.join(scriptRoot, "env-export.ps1");
      const cmdPath = path.join(scriptRoot, "env-export.cmd");

      await fs.writeFile(shPath, toPosixScript(envMap), "utf8");
      await fs.writeFile(ps1Path, toPowerShellScript(envMap), "utf8");
      await fs.writeFile(cmdPath, toCmdScript(envMap), "utf8");

      await fs.chmod(shPath, 0o600);
      await fs.chmod(ps1Path, 0o600);
      await fs.chmod(cmdPath, 0o600);

      manifest.envScriptRelativePaths = [
        path.relative(targetStateDir, shPath),
        path.relative(targetStateDir, ps1Path),
        path.relative(targetStateDir, cmdPath),
      ];
    }
  }
  let mergeReport: MergeReport | undefined;
  if (strategy === "merge") {
    mergeReport = {
      strategy: "merge",
      totalFiles: manifest.files.length,
      mergedNewFiles,
      keptLocalFiles,
      conflicts,
    };
  }

  return { manifest, mergeReport };
}
