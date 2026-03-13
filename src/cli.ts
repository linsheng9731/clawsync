#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import * as readline from "node:readline/promises";
import { Command } from "commander";
import { buildSyncConfig, listComponents, resolveStateDir } from "./config.js";
import { resolveEntries } from "./scope.js";
import { packState, previewPackState, scanPackState, unpackState } from "./archive.js";
import {
  canPushToGit,
  getDefaultGitPushBranch,
  getDefaultGitRepoDir,
  initGitRepo,
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
import type { Manifest, MergeReport, UnpackStrategy } from "./types.js";

const program = new Command();

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
  console.log("### File Details");
  for (const item of manifest.files) {
    console.log(`- ${item}`);
  }
}

function printEnvRecoveryGuidance(manifest: Manifest, stateDir: string): void {
  if (!manifest.sanitized) return;
  console.log("env vars to restore:");
  if (manifest.envVars.length === 0) {
    console.log("- none");
  } else {
    for (const key of manifest.envVars) {
      console.log(`- ${key}`);
    }
  }
  if (!manifest.envScriptRelativePaths?.length) return;
  const shPath = manifest.envScriptRelativePaths.find((rel) => rel.endsWith("env-export.sh"));
  if (!shPath) return;
  const absShPath = path.join(stateDir, shPath);
  console.log("how to apply:");
  console.log(`- bash/zsh: source "${absShPath}"`);
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
      console.log(`${idx + 1}. ${item.relPath} (${formatBytes(item.sizeBytes)}) [${item.component}]`);
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
  .version("0.1.1", "--version", "output the current version");

program
  .command("version")
  .description("Show version information")
  .option("-v, --verbose", "show runtime details")
  .action((opts) => {
    console.log("clawsync 0.1.1");
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
      console.log(`scan: ${item.relPath} (${formatBytes(item.sizeBytes)}) [${item.action}]`);
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
    for (const file of preview.files) console.log(`- ${file}`);
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
  .action(async (opts) => {
    const stateDir = resolveStateDir(opts.stateDir);
    await fs.ensureDir(stateDir);
    const strategy = opts.strategy as UnpackStrategy;
    const { manifest, mergeReport } = await unpackState(path.resolve(opts.from), stateDir, strategy, opts.envScriptDir);
    console.log(`restored to: ${stateDir}`);
    console.log(`files: ${manifest.files.length}`);
    if (manifest.envScriptRelativePaths?.length) {
      console.log("env scripts:");
      for (const rel of manifest.envScriptRelativePaths) console.log(`- ${rel}`);
    }
    printEnvRecoveryGuidance(manifest, stateDir);
    printMergeReport(mergeReport);
  });

commonOptions(
  program
    .command("push")
    .description("Pack then push to git backend")
    .option("--repo-dir <path>", "local git repo directory")
    .option("--branch <name>", "git branch; default clawsync_<YYYYMMDD>")
    .option("--reuse-message-channel <mode>", "reuse OpenClaw message channel: yes|no")
    .option("--dry-run", "preview selected files and sanitization without pushing")
).action(async (opts) => {
  const reuseMessageChannel = parseYesNoOption(opts.reuseMessageChannel, "--reuse-message-channel");
  await ensureGitPushTargetReady(opts.repoDir);
  const cfg = await buildSyncConfig(opts);
  if (opts.dryRun) {
    const preview = await previewPackState(cfg);
    console.log("dry-run mode");
    console.log(`stateDir: ${cfg.stateDir}`);
    console.log(`sanitize: ${cfg.sanitize ? "on" : "off"}`);
    console.log(`files: ${preview.files.length}`);
    for (const file of preview.files) console.log(`- ${file}`);
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
    return;
  }
  const { archivePath } = await packState(cfg);
  const repoPath = await pushToGit(archivePath, {
    repoDir: opts.repoDir,
    branch: opts.branch,
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
    .option("--reuse-message-channel <mode>", "reuse OpenClaw message channel in notifications: yes|no")
).action(async (opts) => {
  parseYesNoOption(opts.reuseMessageChannel, "--reuse-message-channel");
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
  .action(async (opts) => {
    const targetStateDir = resolveStateDir(opts.stateDir);
    await fs.ensureDir(targetStateDir);
    const tempOut = await fs.mkdtemp(path.join(os.tmpdir(), "clawsync-download-"));
    const archivePath = await resolveArchiveFromSource(opts, tempOut);
    const strategy = opts.strategy as UnpackStrategy;
    const { manifest, mergeReport } = await unpackState(archivePath, targetStateDir, strategy, opts.envScriptDir);
    console.log(`pulled and restored to: ${targetStateDir}`);
    console.log(`files: ${manifest.files.length}`);
    if (manifest.envScriptRelativePaths?.length) {
      console.log("env scripts:");
      for (const rel of manifest.envScriptRelativePaths) console.log(`- ${rel}`);
    }
    printEnvRecoveryGuidance(manifest, targetStateDir);
    printMergeReport(mergeReport);
  });

program
  .command("merge")
  .description("Pull from git and merge into state directory (local-first)")
  .option("--repo-dir <path>", "local git repo directory")
  .option("--repo-url <url>", "git remote origin url")
  .option("--branch <name>", "git branch", "main")
  .option("--state-dir <path>", "target state dir")
  .option("--env-script-dir <path>", "directory to write env-export scripts")
  .action(async (opts) => {
    const targetStateDir = resolveStateDir(opts.stateDir);
    await fs.ensureDir(targetStateDir);
    const tempOut = await fs.mkdtemp(path.join(os.tmpdir(), "clawsync-download-"));
    const archivePath = await resolveArchiveFromSource(opts, tempOut);
    const { manifest, mergeReport } = await unpackState(archivePath, targetStateDir, "merge", opts.envScriptDir);
    console.log(`merged to: ${targetStateDir}`);
    console.log(`files: ${manifest.files.length}`);
    if (manifest.envScriptRelativePaths?.length) {
      console.log("env scripts:");
      for (const rel of manifest.envScriptRelativePaths) console.log(`- ${rel}`);
    }
    printEnvRecoveryGuidance(manifest, targetStateDir);
    printMergeReport(mergeReport);
  });

program.parseAsync().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
