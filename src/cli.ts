#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import * as tar from "tar";
import * as readline from "node:readline/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { buildSyncConfig, listComponents, resolveStateDir } from "./config.js";
import { resolveEntries } from "./scope.js";
import { packState, previewPackState, readArchiveManifest, scanPackState, unpackState } from "./archive.js";
import {
  canPushToGit,
  getDefaultGitPushBranch,
  getDefaultGitRepoDir,
  initGitRepo,
  pruneRemoteClawsyncBranches,
  pushToGit,
  pullFromGit,
} from "./backends/git.js";
import {
  buildCronCommand,
  buildManagedCronLine,
  getCronJobStatus,
  installCronJob,
  parseInterval,
  removeCronJob,
} from "./scheduler/cron.js";
import { runArchiveServer } from "./server.js";
import type { Manifest, MergeReport, UnpackStrategy } from "./types.js";

const program = new Command();
const execFileAsync = promisify(execFile);
const DISPLAY_MAX_DEPTH = 3;
const DISPLAY_MAX_ITEMS = 10;

function commonOptions(cmd: Command): Command {
  return cmd
    .option("--state-dir <path>", "OpenClaw state dir; default ~/.openclaw or OPENCLAW_STATE_DIR")
    .option("--config <path>", "sync config file path")
    .option("--include <list>", `components to include: ${listComponents().join(",")}`)
    .option("--exclude <list>", `components to exclude: ${listComponents().join(",")}`)
    .option("--ignore-paths <list>", "comma-separated relative paths to ignore, e.g. workspace/cache,media")
    .option(
      "--workspace-include-globs <list>",
      "comma-separated wildcard patterns to include non-config workspace files/folders",
    )
    .option("--no-sanitize", "disable sensitive value replacement in sync package");
}

function appendArg(args: string[], name: string, value?: string): void {
  if (!value) return;
  args.push(name, value);
}

function parseYesNoOption(raw: string | undefined, optionName: string): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "yes") return true;
  if (normalized === "no") return false;
  throw new Error(`Invalid value for ${optionName}: ${raw}. Allowed values: yes, no`);
}

function parsePositiveIntOption(raw: string | undefined, optionName: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid value for ${optionName}: ${raw}. Use a positive integer.`);
  }
  return value;
}

const FULL_MIGRATE_COMPONENTS = [
  "config",
  "workspace",
  "credentials",
  "sessions",
  "devices",
  "identity",
  "channels",
] as const;

const HIGH_RISK_RESTORE_PREFIXES = [
  "credentials/",
  "agents/",
  "sessions/",
  "telegram/",
  "whatsapp/",
  "signal/",
  "discord/",
  "devices/",
  "identity/",
];

function detectHighRiskRestorePaths(manifest: Manifest): string[] {
  return manifest.files.filter((file) => {
    if (file === "openclaw.json" || file === ".env") return true;
    return HIGH_RISK_RESTORE_PREFIXES.some((prefix) => file.startsWith(prefix));
  });
}

function toDisplayPath(input: string, maxDepth = DISPLAY_MAX_DEPTH): string {
  const segments = input.split("/").filter(Boolean);
  if (segments.length <= maxDepth) return input;
  return segments.slice(0, maxDepth).join("/");
}

function printCappedPathList(items: string[], options?: { maxItems?: number; maxDepth?: number; dedupe?: boolean }): void {
  const maxItems = options?.maxItems ?? DISPLAY_MAX_ITEMS;
  const maxDepth = options?.maxDepth ?? DISPLAY_MAX_DEPTH;
  const transformed = items.map((item) => toDisplayPath(item, maxDepth));
  const normalized = options?.dedupe === false ? transformed : Array.from(new Set(transformed));
  const displayed = normalized.slice(0, maxItems);
  for (const item of displayed) {
    console.log(`- ${item}`);
  }
  if (normalized.length > maxItems) {
    console.log(`- ... ${normalized.length - maxItems} more`);
  }
}

function printRestoreDryRunSummary(targetStateDir: string, strategy: UnpackStrategy, manifest: Manifest): void {
  const riskyFiles = detectHighRiskRestorePaths(manifest);
  console.log("dry-run mode");
  console.log(`target: ${targetStateDir}`);
  console.log(`strategy: ${strategy}`);
  console.log(`files in archive: ${manifest.files.length}`);
  console.log(`sanitized: ${manifest.sanitized ? "yes" : "no"}`);
  if (riskyFiles.length > 0) {
    console.log(`high-risk files: ${riskyFiles.length}`);
    console.log("sample high-risk paths:");
    for (const file of riskyFiles.slice(0, 8)) {
      console.log(`- ${toDisplayPath(file)}`);
    }
    if (riskyFiles.length > 8) {
      console.log(`- ... ${riskyFiles.length - 8} more`);
    }
  } else {
    console.log("high-risk files: 0");
  }
  console.log("no files were changed.");
}

async function createPreRestoreSnapshot(stateDir: string): Promise<string | null> {
  if (!(await fs.pathExists(stateDir))) return null;
  const stat = await fs.stat(stateDir);
  if (!stat.isDirectory()) return null;
  const parent = path.dirname(stateDir);
  const base = path.basename(stateDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = path.join(os.tmpdir(), `clawsync-pre-restore-${stamp}.tar.gz`);
  await tar.create(
    {
      gzip: true,
      cwd: parent,
      file: snapshotPath,
    },
    [base],
  );
  return snapshotPath;
}

async function confirmHighRiskRestoreIfNeeded(opts: {
  manifest: Manifest;
  dryRun?: boolean;
  yes?: boolean;
  commandLabel: string;
}): Promise<void> {
  if (opts.dryRun) return;
  const riskyFiles = detectHighRiskRestorePaths(opts.manifest);
  if (riskyFiles.length === 0) return;
  if (opts.yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `High-risk restore detected (${riskyFiles.length} sensitive files). Run "${opts.commandLabel} --dry-run" first, then re-run with --yes to apply.`,
    );
  }
  console.log("WARNING: this restore includes credentials/sessions/channel state.");
  console.log(`high-risk files: ${riskyFiles.length}`);
  console.log("tip: run with --dry-run first to preview changes.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Type 'yes' to continue restore: ");
    if (answer.trim() !== "yes") {
      throw new Error("Restore cancelled.");
    }
  } finally {
    rl.close();
  }
}

async function ensureGitPushTargetReady(repoDir?: string): Promise<void> {
  const result = await canPushToGit({ repoDir });
  if (result.originUrl) return;
  const resolvedRepoDir = repoDir ? path.resolve(repoDir) : getDefaultGitRepoDir();
  throw new Error(
    `Git target is not initialized at ${resolvedRepoDir}. Run: clawsync git init --repo-url <your-repo-url>${repoDir ? ` --repo-dir ${resolvedRepoDir}` : ""}`,
  );
}

function buildPushArgsFromOptions(opts: {
  stateDir?: string;
  config?: string;
  include?: string;
  exclude?: string;
  ignorePaths?: string;
  workspaceIncludeGlobs?: string;
  sanitize?: boolean;
  repoDir?: string;
  branch?: string;
  keep?: string;
  reuseMessageChannel?: string;
}): string[] {
  const args: string[] = [];
  appendArg(args, "--state-dir", opts.stateDir);
  appendArg(args, "--config", opts.config);
  appendArg(args, "--include", opts.include);
  appendArg(args, "--exclude", opts.exclude);
  appendArg(args, "--ignore-paths", opts.ignorePaths);
  appendArg(args, "--workspace-include-globs", opts.workspaceIncludeGlobs);
  if (opts.sanitize === false) args.push("--no-sanitize");
  appendArg(args, "--repo-dir", opts.repoDir);
  appendArg(args, "--branch", opts.branch);
  appendArg(args, "--keep", opts.keep);
  appendArg(args, "--reuse-message-channel", opts.reuseMessageChannel);
  return args;
}

function quoteForDisplay(arg: string): string {
  if (arg.length === 0) return `""`;
  if (/[\s"]/g.test(arg)) return `"${arg.replace(/"/g, '\\"')}"`;
  return arg;
}

function buildScheduleHintCommand(opts: {
  stateDir?: string;
  config?: string;
  include?: string;
  exclude?: string;
  ignorePaths?: string;
  workspaceIncludeGlobs?: string;
  sanitize?: boolean;
  repoDir?: string;
  branch?: string;
  keep?: string;
  reuseMessageChannel?: string;
}): string {
  const pushArgs = buildPushArgsFromOptions(opts);
  const cmd = ["clawsync", "schedule", "install", "--every", "1d", ...pushArgs];
  return cmd.map(quoteForDisplay).join(" ");
}

async function maybePrintScheduleGuidance(opts: {
  stateDir?: string;
  config?: string;
  include?: string;
  exclude?: string;
  ignorePaths?: string;
  workspaceIncludeGlobs?: string;
  sanitize?: boolean;
  repoDir?: string;
  branch?: string;
  keep?: string;
  reuseMessageChannel?: string;
}): Promise<void> {
  try {
    const status = await getCronJobStatus();
    if (status.installed) return;
    console.log("");
    console.log("tip: scheduled backup is not enabled yet.");
    console.log("enable daily automatic backup with:");
    console.log(buildScheduleHintCommand(opts));
  } catch {
    // If crontab is unavailable or unreadable, skip guidance quietly.
  }
}

interface PullSourceOptions {
  repoDir?: string;
  repoUrl?: string;
  branch?: string;
}

async function resolveArchiveFromSource(opts: PullSourceOptions, tempOut: string): Promise<string> {
  void tempOut;
  return pullFromGit({
    repoDir: opts.repoDir,
    repoUrl: opts.repoUrl,
    branch: opts.branch,
  });
}

function printMergeReport(report?: MergeReport): void {
  if (!report) return;
  console.log("## Merge Report");
  console.log(`- Total files: ${report.totalFiles}`);
  console.log(`- Merged new: ${report.mergedNewFiles}`);
  console.log(`- Kept local: ${report.keptLocalFiles}`);
  console.log(`- Conflicts: ${report.conflicts.length}`);
  if (report.conflicts.length === 0) return;
  console.log("### Conflict Details");
  console.log("| Path | Reason |");
  console.log("| --- | --- |");
  for (const item of report.conflicts) {
    console.log(`| \`${item.path}\` | \`${item.reason}\` |`);
  }
}

function printPackReport(archivePath: string, manifest: Manifest): void {
  console.log("## Pack Report");
  console.log(`- Archive: ${archivePath}`);
  console.log(`- Total files: ${manifest.files.length}`);
  console.log(`- Sanitized: ${manifest.sanitized ? "yes" : "no"}`);
  console.log(`- Env vars captured: ${manifest.envVars.length}`);
  console.log("### File Details (top 3 levels, max 10)");
  printCappedPathList(manifest.files);
}

function printEnvRecoveryGuidance(manifest: Manifest, stateDir: string): { missingEnvVars: string[] } {
  if (!manifest.sanitized) return { missingEnvVars: [] };
  if (manifest.envVars.length === 0) return { missingEnvVars: [] };
  const missingEnvVars = manifest.envVars.filter((key) => !process.env[key]);
  if (missingEnvVars.length === 0) {
    console.log("env vars: already present in current shell.");
    return { missingEnvVars };
  }
  console.log("env vars missing in current shell:");
  missingEnvVars.forEach((key) => console.log(`- ${key}`));
  if (!manifest.envScriptRelativePaths?.length) {
    console.log("WARNING: env export script not found; restore secrets manually.");
    return { missingEnvVars };
  }
  const shPath = manifest.envScriptRelativePaths.find((rel) => rel.endsWith("env-export.sh"));
  if (!shPath) {
    console.log("WARNING: env-export.sh not found; restore secrets manually.");
    return { missingEnvVars };
  }
  const absShPath = path.join(stateDir, shPath);
  console.log("IMPORTANT: environment variables are not auto-loaded.");
  console.log("Run the export script before verification:");
  console.log(`- bash/zsh: source "${absShPath}"`);
  return { missingEnvVars };
}

async function printPostRestoreHealthChecklist(): Promise<void> {
  console.log("post-restore verification:");
  try {
    const { stdout, stderr } = await execFileAsync("openclaw", ["gateway", "status"], { timeout: 10_000 });
    const output = (stdout || stderr || "").trim();
    if (output) {
      console.log("gateway status:");
      output.split(/\r?\n/).slice(0, 8).forEach((line) => {
        console.log(`- ${line}`);
      });
    } else {
      console.log("- gateway status: command returned empty output");
    }
  } catch (error) {
    const message = (error as Error).message || "unable to run `openclaw gateway status`";
    console.log(`- gateway status: check failed (${message})`);
  }
  console.log("- channel reconnect: verify channels can receive/send messages");
  console.log("- telegram: if silent, send /start to the bot");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(2)} ${units[idx]}`;
}

function printScanSummary(report: Awaited<ReturnType<typeof scanPackState>>): void {
  console.log("## Scan Summary");
  console.log(`- Scanned files: ${report.scannedFiles}`);
  console.log(`- Scanned size: ${formatBytes(report.scannedBytes)}`);
  if (report.ignoredFiles > 0) {
    console.log(`- Ignored by config: ${report.ignoredFiles} (${formatBytes(report.ignoredBytes)})`);
  }
  if (report.excludedNonConfigFiles > 0) {
    console.log(
      `- Excluded by workspace whitelist: ${report.excludedNonConfigFiles} (${formatBytes(report.excludedNonConfigBytes)})`,
    );
  }
  console.log(`- Included by default whitelist: ${report.includedConfigFiles} (${formatBytes(report.includedConfigBytes)})`);
  if (report.includedByUserRuleFiles > 0) {
    console.log(
      `- Included by user rule: ${report.includedByUserRuleFiles} (${formatBytes(report.includedByUserRuleBytes)})`,
    );
  }
  console.log(`- Selected to sync: ${report.selectedFiles} (${formatBytes(report.selectedBytes)})`);
  if (report.largestItems.length > 0) {
    console.log("### Largest Items");
    report.largestItems.forEach((item, idx) => {
      console.log(`${idx + 1}. ${toDisplayPath(item.relPath)} (${formatBytes(item.sizeBytes)}) [${item.component}]`);
    });
  }
}

function parseSelectedIndexes(raw: string, max: number): number[] {
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const indexes: number[] = [];
  for (const token of tokens) {
    const value = Number(token);
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`Invalid index: ${token}. Enter numbers between 1 and ${max}.`);
    }
    indexes.push(value - 1);
  }
  return Array.from(new Set(indexes));
}

async function chooseLargestItemsToIgnore(
  largestItems: Array<{ relPath: string; sizeBytes: number; component: string }>,
): Promise<string[]> {
  if (largestItems.length === 0) return [];
  if (!process.stdin.isTTY || !process.stdout.isTTY) return [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(
      "Ignore any largest items from this sync? Input indexes (comma-separated), or press Enter to sync all: ",
    );
    if (!answer.trim()) return [];
    const indexes = parseSelectedIndexes(answer, largestItems.length);
    return indexes.map((idx) => largestItems[idx].relPath);
  } finally {
    rl.close();
  }
}

program
  .name("clawsync")
  .description("Sync OpenClaw config/state with Git backend")
  .version("0.1.8", "--version", "output the current version");

program
  .command("version")
  .description("Show version information")
  .option("-v, --verbose", "show runtime details")
  .action((opts) => {
    console.log("clawsync 0.1.8");
    if (!opts.verbose) return;
    console.log(`node: ${process.version}`);
    console.log(`platform: ${process.platform}/${process.arch}`);
  });

const gitProgram = program.command("git").description("Manage clawsync git backend");

gitProgram
  .command("init")
  .description("Initialize local git repo and origin for clawsync push")
  .requiredOption("--repo-url <url>", "git remote origin url")
  .option("--repo-dir <path>", "local git repo directory")
  .option("--branch <name>", "initial checkout branch", "main")
  .action(async (opts) => {
    const result = await initGitRepo({
      repoDir: opts.repoDir,
      repoUrl: opts.repoUrl,
      branch: opts.branch,
    });
    console.log("git backend initialized.");
    console.log(`repo: ${result.repoDir}`);
    console.log(`origin: ${result.originUrl}`);
    console.log(`branch: ${result.branch}`);
  });

gitProgram
  .command("prune-branches")
  .description("Prune old remote clawsync_<YYYYMMDD> branches by retention days")
  .option("--repo-dir <path>", "local git repo directory")
  .option("--repo-url <url>", "git remote origin url (used when repo-dir needs initialization)")
  .option("--keep-days <days>", "keep branches within latest N days", "30")
  .option("--dry-run", "preview branches that would be deleted")
  .option("--yes", "apply deletion of candidate branches")
  .action(async (opts) => {
    const keepDays = parsePositiveIntOption(opts.keepDays, "--keep-days");
    if (keepDays === undefined) {
      throw new Error("--keep-days is required");
    }
    const apply = !opts.dryRun;
    if (apply && !opts.yes) {
      throw new Error("Refusing to delete remote branches without confirmation. Re-run with --yes, or use --dry-run.");
    }
    const result = await pruneRemoteClawsyncBranches({
      repoDir: opts.repoDir,
      repoUrl: opts.repoUrl,
      keepDays,
      apply,
    });
    console.log(`retention days: ${result.keepDays}`);
    console.log(`scanned remote branches: ${result.scannedRemoteBranches}`);
    console.log(`delete candidates: ${result.candidates.length}`);
    if (result.candidates.length > 0) {
      result.candidates.forEach((branch) => console.log(`- ${branch}`));
    }
    if (opts.dryRun) {
      console.log("mode: dry-run (no branches deleted)");
    } else {
      console.log(`deleted: ${result.deleted.length}`);
    }
  });

const profileProgram = program.command("profile").description("Run predefined backup profiles");

profileProgram
  .command("full-migrate")
  .description("Create a local full migration archive (does not push to git)")
  .option("--state-dir <path>", "OpenClaw state dir; default ~/.openclaw or OPENCLAW_STATE_DIR")
  .option("--config <path>", "sync config file path")
  .option("--out <dir>", "output directory for archive; default <state-dir>/migrations")
  .option("--dry-run", "preview selected files without writing archive")
  .option("--sanitize", "sanitize secrets in archive (disabled by default for migration)")
  .action(async (opts) => {
    const stateDir = resolveStateDir(opts.stateDir);
    const cfg = await buildSyncConfig({
      stateDir: opts.stateDir,
      config: opts.config,
      sanitize: opts.sanitize ? true : false,
    });
    const runCfg = {
      ...cfg,
      include: [...FULL_MIGRATE_COMPONENTS],
      exclude: [],
      includeAllWorkspaceFiles: true,
      sanitize: opts.sanitize ? true : false,
    };
    if (opts.dryRun) {
      const preview = await previewPackState(runCfg);
      console.log("dry-run mode");
      console.log("profile: full-migrate");
      console.log("target: local archive only (no git push)");
      console.log(`stateDir: ${runCfg.stateDir}`);
      console.log(`sanitize: ${runCfg.sanitize ? "on" : "off"}`);
      console.log(`files: ${preview.files.length}`);
      printCappedPathList(preview.files);
      return;
    }
    const outputDir = opts.out ? path.resolve(opts.out) : path.join(stateDir, "migrations");
    const result = await packState(runCfg, outputDir);
    console.log("profile: full-migrate");
    console.log("target: local archive only (no git push)");
    printPackReport(result.archivePath, result.manifest);
  });

commonOptions(
  program
    .command("serve")
    .description("Serve local archives via HTTP with token authentication")
    .requiredOption("--token <secret>", "access token for API requests")
    .option("--port <port>", "server port", "7373")
    .option("--dir <path>", "archive directory to serve")
    .option("--strategy <mode>", "default restore strategy for /restore", "overwrite")
    .option("--env-script-dir <path>", "directory to write env-export scripts when restoring")
    .option("--overwrite-gateway-token", "use token from backup openclaw.json when restoring via /restore")
).action(async (opts) => {
  const cfg = await buildSyncConfig(opts);
  const stateDir = cfg.stateDir;
  const archiveDir = opts.dir ? path.resolve(opts.dir) : path.join(stateDir, "migrations");
  const parsedPort = Number(opts.port);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    throw new Error(`Invalid --port value: ${opts.port}`);
  }
  const strategy = opts.strategy as UnpackStrategy;
  if (!["overwrite", "skip", "merge"].includes(strategy)) {
    throw new Error(`Invalid --strategy value: ${opts.strategy}. Allowed: overwrite|skip|merge`);
  }
  await runArchiveServer({
    token: opts.token,
    port: parsedPort,
    archiveDir,
    backupConfig: cfg,
    restoreStateDir: stateDir,
    restoreStrategy: strategy,
    envScriptDir: opts.envScriptDir,
    preserveGatewayToken: !opts.overwriteGatewayToken,
  });
});

commonOptions(
  program
    .command("scope")
    .description("Show selected component paths")
).action(async (opts) => {
  const cfg = await buildSyncConfig(opts);
  const entries = resolveEntries(cfg);
  console.log(`stateDir: ${cfg.stateDir}`);
  console.log(`include: ${cfg.include.join(", ")}`);
  console.log(`exclude: ${cfg.exclude.join(", ")}`);
  console.log("paths:");
  for (const e of entries) console.log(`- [${e.component}] ${e.relPath}`);
});

commonOptions(
  program
    .command("pack")
    .description("Pack selected state files into a tar.gz")
    .option("--out <dir>", "output directory for archive")
    .option("--dry-run", "preview selected files and sanitization without writing archive")
).action(async (opts) => {
  const cfg = await buildSyncConfig(opts);
  console.log("scanning files before pack...");
  const scanReport = await scanPackState(cfg, {
    topN: 8,
    onProgress: (item) => {
      if (item.action === "excluded-non-config") return;
      console.log(`scan: ${toDisplayPath(item.relPath)} (${formatBytes(item.sizeBytes)}) [${item.action}]`);
    },
  });
  printScanSummary(scanReport);

  let runtimeIgnorePaths = [...cfg.ignorePaths];
  if (!opts.dryRun) {
    const chosenToIgnore = await chooseLargestItemsToIgnore(scanReport.largestItems);
    if (chosenToIgnore.length > 0) {
      runtimeIgnorePaths = Array.from(new Set([...runtimeIgnorePaths, ...chosenToIgnore]));
      console.log(`ignore for current run: ${chosenToIgnore.join(", ")}`);
    }
  }
  const runCfg = { ...cfg, ignorePaths: runtimeIgnorePaths };

  if (opts.dryRun) {
    const preview = await previewPackState(runCfg);
    console.log("dry-run mode");
    console.log(`stateDir: ${runCfg.stateDir}`);
    console.log(`sanitize: ${runCfg.sanitize ? "on" : "off"}`);
    console.log(`files: ${preview.files.length}`);
    printCappedPathList(preview.files);
    console.log(`sanitized: ${preview.sanitized ? "yes" : "no"}`);
    if (preview.envVars.length > 0) {
      console.log("env vars:");
      for (const key of preview.envVars) console.log(`- ${key}`);
    }
    return;
  }
  const result = await packState(runCfg, opts.out);
  printPackReport(result.archivePath, result.manifest);
});

program
  .command("unpack")
  .description("Unpack an archive to state directory")
  .requiredOption("--from <path>", "archive path")
  .option("--state-dir <path>", "target state dir")
  .option("--strategy <mode>", "overwrite|skip|merge", "overwrite")
  .option("--env-script-dir <path>", "directory to write env-export scripts")
  .option("--dry-run", "preview restore plan without writing files")
  .option("--yes", "apply high-risk restore without interactive confirmation")
  .option("--no-pre-snapshot", "disable pre-restore local snapshot")
  .option("--overwrite-gateway-token", "use token from backup openclaw.json")
  .action(async (opts) => {
    const stateDir = resolveStateDir(opts.stateDir);
    const strategy = opts.strategy as UnpackStrategy;
    const archivePath = path.resolve(opts.from);
    const manifest = await readArchiveManifest(archivePath);
    if (opts.dryRun) {
      printRestoreDryRunSummary(stateDir, strategy, manifest);
      return;
    }
    await confirmHighRiskRestoreIfNeeded({
      manifest,
      dryRun: opts.dryRun,
      yes: opts.yes,
      commandLabel: "clawsync unpack --from <archive-path>",
    });
    await fs.ensureDir(stateDir);
    let snapshotPath: string | null = null;
    if (opts.preSnapshot !== false) {
      snapshotPath = await createPreRestoreSnapshot(stateDir);
    }
    const { manifest: restoredManifest, mergeReport } = await unpackState(archivePath, stateDir, strategy, opts.envScriptDir, {
      preserveGatewayToken: !opts.overwriteGatewayToken,
    });
    console.log(`restored to: ${stateDir}`);
    console.log(`files: ${restoredManifest.files.length}`);
    if (snapshotPath) {
      console.log(`pre-restore snapshot: ${snapshotPath}`);
    }
    if (opts.overwriteGatewayToken) {
      console.log("gateway token: restored from backup");
    } else {
      console.log("gateway token: preserved from local machine (default)");
    }
    const envStatus = printEnvRecoveryGuidance(restoredManifest, stateDir);
    printMergeReport(mergeReport);
    if (envStatus.missingEnvVars.length === 0) {
      await printPostRestoreHealthChecklist();
    }
  });

commonOptions(
  program
    .command("push")
    .description("Pack then push to git backend")
    .option("--repo-dir <path>", "local git repo directory")
    .option("--branch <name>", "git branch; default clawsync_<YYYYMMDD>")
    .option("--keep <count>", "keep latest N archives in git repo after push")
    .option("--reuse-message-channel <mode>", "reuse OpenClaw message channel: yes|no")
    .option("--dry-run", "preview selected files and sanitization without pushing")
).action(async (opts) => {
  const reuseMessageChannel = parseYesNoOption(opts.reuseMessageChannel, "--reuse-message-channel");
  const keepArchives = parsePositiveIntOption(opts.keep, "--keep");
  await ensureGitPushTargetReady(opts.repoDir);
  const cfg = await buildSyncConfig(opts);
  if (opts.dryRun) {
    const preview = await previewPackState(cfg);
    console.log("dry-run mode");
    console.log(`stateDir: ${cfg.stateDir}`);
    console.log(`sanitize: ${cfg.sanitize ? "on" : "off"}`);
    console.log(`files: ${preview.files.length}`);
    printCappedPathList(preview.files);
    console.log(`sanitized: ${preview.sanitized ? "yes" : "no"}`);
    if (preview.envVars.length > 0) {
      console.log("env vars:");
      for (const key of preview.envVars) console.log(`- ${key}`);
    }
    const repoTarget = opts.repoDir ?? "~/.clawsync-repo";
    const branch = opts.branch ?? getDefaultGitPushBranch();
    console.log(`target: git ${repoTarget} (branch: ${branch})`);
    if (reuseMessageChannel !== undefined) {
      console.log(`reuse message channel: ${reuseMessageChannel ? "yes" : "no"}`);
    }
    if (keepArchives !== undefined) {
      console.log(`archive retention: keep latest ${keepArchives}`);
    }
    return;
  }
  const { archivePath } = await packState(cfg);
  const repoPath = await pushToGit(archivePath, {
    repoDir: opts.repoDir,
    branch: opts.branch,
    keepArchives,
  });
  console.log(`pushed to git repo: ${repoPath}`);
  await maybePrintScheduleGuidance(opts);
});

const scheduleProgram = program
  .command("schedule")
  .description("Install and manage scheduled sync jobs");

commonOptions(
  scheduleProgram
    .command("install")
    .description("Install (or update) a managed cron schedule for push")
    .requiredOption("--every <interval>", "interval like 30m, 2h, 1d")
    .option("--repo-dir <path>", "local git repo directory")
    .option("--branch <name>", "git branch; default clawsync_<YYYYMMDD>")
    .option("--keep <count>", "keep latest N archives in git repo after each push")
    .option("--reuse-message-channel <mode>", "reuse OpenClaw message channel in notifications: yes|no")
).action(async (opts) => {
  parseYesNoOption(opts.reuseMessageChannel, "--reuse-message-channel");
  parsePositiveIntOption(opts.keep, "--keep");
  await ensureGitPushTargetReady(opts.repoDir);

  const cronExpression = parseInterval(opts.every);
  const pushArgs = buildPushArgsFromOptions(opts);
  const cliPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (!cliPath) throw new Error("Unable to resolve CLI entry path for cron task.");

  const stateDir = resolveStateDir(opts.stateDir);
  const logPath = path.join(stateDir, "logs", "sync-cron.log");
  await fs.ensureDir(path.dirname(logPath));

  const cronCommand = buildCronCommand({
    nodePath: process.execPath,
    cliPath,
    pushArgs,
    logPath,
  });
  const managedLine = buildManagedCronLine(cronExpression, cronCommand);
  const result = await installCronJob(managedLine);

  console.log(result.replacedCount > 0 ? "schedule updated." : "schedule installed.");
  console.log(`cron: ${cronExpression}`);
  console.log(`log: ${logPath}`);
});

scheduleProgram
  .command("status")
  .description("Show managed cron schedule status")
  .action(async () => {
    const status = await getCronJobStatus();
    if (!status.installed) {
      console.log("schedule: not installed");
      return;
    }
    console.log("schedule: installed");
    if (status.cronExpression) console.log(`cron: ${status.cronExpression}`);
    if (status.command) console.log(`command: ${status.command}`);
  });

scheduleProgram
  .command("remove")
  .description("Remove managed cron schedule")
  .action(async () => {
    const result = await removeCronJob();
    if (result.removedCount === 0) {
      console.log("schedule: no managed job found");
      return;
    }
    console.log("schedule removed");
  });

program
  .command("pull")
  .description("Pull from git then unpack")
  .option("--repo-dir <path>", "local git repo directory")
  .option("--repo-url <url>", "git remote origin url")
  .option("--branch <name>", "git branch", "main")
  .option("--state-dir <path>", "target state dir")
  .option("--strategy <mode>", "overwrite|skip|merge", "overwrite")
  .option("--env-script-dir <path>", "directory to write env-export scripts")
  .option("--dry-run", "preview restore plan without writing files")
  .option("--yes", "apply high-risk restore without interactive confirmation")
  .option("--no-pre-snapshot", "disable pre-restore local snapshot")
  .option("--overwrite-gateway-token", "use token from backup openclaw.json")
  .action(async (opts) => {
    const targetStateDir = resolveStateDir(opts.stateDir);
    const tempOut = await fs.mkdtemp(path.join(os.tmpdir(), "clawsync-download-"));
    const archivePath = await resolveArchiveFromSource(opts, tempOut);
    const strategy = opts.strategy as UnpackStrategy;
    const manifest = await readArchiveManifest(archivePath);
    if (opts.dryRun) {
      printRestoreDryRunSummary(targetStateDir, strategy, manifest);
      return;
    }
    await confirmHighRiskRestoreIfNeeded({
      manifest,
      dryRun: opts.dryRun,
      yes: opts.yes,
      commandLabel: "clawsync pull --repo-url <url>",
    });
    await fs.ensureDir(targetStateDir);
    let snapshotPath: string | null = null;
    if (opts.preSnapshot !== false) {
      snapshotPath = await createPreRestoreSnapshot(targetStateDir);
    }
    const { manifest: restoredManifest, mergeReport } = await unpackState(
      archivePath,
      targetStateDir,
      strategy,
      opts.envScriptDir,
      { preserveGatewayToken: !opts.overwriteGatewayToken },
    );
    console.log(`pulled and restored to: ${targetStateDir}`);
    console.log(`files: ${restoredManifest.files.length}`);
    if (snapshotPath) {
      console.log(`pre-restore snapshot: ${snapshotPath}`);
    }
    if (opts.overwriteGatewayToken) {
      console.log("gateway token: restored from backup");
    } else {
      console.log("gateway token: preserved from local machine (default)");
    }
    const envStatus = printEnvRecoveryGuidance(restoredManifest, targetStateDir);
    printMergeReport(mergeReport);
    if (envStatus.missingEnvVars.length === 0) {
      await printPostRestoreHealthChecklist();
    }
  });

program
  .command("merge")
  .description("Pull from git and merge into state directory (local-first)")
  .option("--repo-dir <path>", "local git repo directory")
  .option("--repo-url <url>", "git remote origin url")
  .option("--branch <name>", "git branch", "main")
  .option("--state-dir <path>", "target state dir")
  .option("--env-script-dir <path>", "directory to write env-export scripts")
  .option("--dry-run", "preview restore plan without writing files")
  .option("--yes", "apply high-risk restore without interactive confirmation")
  .option("--no-pre-snapshot", "disable pre-restore local snapshot")
  .option("--overwrite-gateway-token", "use token from backup openclaw.json")
  .action(async (opts) => {
    const targetStateDir = resolveStateDir(opts.stateDir);
    const tempOut = await fs.mkdtemp(path.join(os.tmpdir(), "clawsync-download-"));
    const archivePath = await resolveArchiveFromSource(opts, tempOut);
    const manifest = await readArchiveManifest(archivePath);
    if (opts.dryRun) {
      printRestoreDryRunSummary(targetStateDir, "merge", manifest);
      return;
    }
    await confirmHighRiskRestoreIfNeeded({
      manifest,
      dryRun: opts.dryRun,
      yes: opts.yes,
      commandLabel: "clawsync merge --repo-url <url>",
    });
    await fs.ensureDir(targetStateDir);
    let snapshotPath: string | null = null;
    if (opts.preSnapshot !== false) {
      snapshotPath = await createPreRestoreSnapshot(targetStateDir);
    }
    const { manifest: restoredManifest, mergeReport } = await unpackState(
      archivePath,
      targetStateDir,
      "merge",
      opts.envScriptDir,
      { preserveGatewayToken: !opts.overwriteGatewayToken },
    );
    console.log(`merged to: ${targetStateDir}`);
    console.log(`files: ${restoredManifest.files.length}`);
    if (snapshotPath) {
      console.log(`pre-restore snapshot: ${snapshotPath}`);
    }
    if (opts.overwriteGatewayToken) {
      console.log("gateway token: restored from backup");
    } else {
      console.log("gateway token: preserved from local machine (default)");
    }
    const envStatus = printEnvRecoveryGuidance(restoredManifest, targetStateDir);
    printMergeReport(mergeReport);
    if (envStatus.missingEnvVars.length === 0) {
      await printPostRestoreHealthChecklist();
    }
  });

program.parseAsync().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
