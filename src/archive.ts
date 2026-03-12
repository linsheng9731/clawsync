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
  SyncConfig,
  UnpackResult,
  UnpackStrategy,
} from "./types.js";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export interface PreviewResult {
  files: string[];
  sanitized: boolean;
  envVars: string[];
}

export async function previewPackState(config: SyncConfig): Promise<PreviewResult> {
  const entries = await resolveExistingPaths(config);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clawsync-preview-"));
  const payload = path.join(tempRoot, "payload");
  await fs.ensureDir(payload);

  const files: string[] = [];
  for (const entry of entries) {
    const src = path.join(config.stateDir, entry.relPath);
    const dest = path.join(payload, entry.relPath);
    await fs.copy(src, dest, { overwrite: true, errorOnExist: false });
    files.push(entry.relPath);
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
  const entries = await resolveExistingPaths(config);
  const tempRoot = outDir ? path.resolve(outDir) : await fs.mkdtemp(path.join(os.tmpdir(), "clawsync-"));
  await fs.ensureDir(tempRoot);
  const staging = path.join(tempRoot, "staging");
  const payload = path.join(staging, "payload");
  await fs.ensureDir(payload);

  const files: string[] = [];
  for (const entry of entries) {
    const src = path.join(config.stateDir, entry.relPath);
    const dest = path.join(payload, entry.relPath);
    await fs.copy(src, dest, { overwrite: true, errorOnExist: false });
    files.push(entry.relPath);
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
