#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import * as readline from "node:readline/promises";
import { Command } from "commander";
import { buildSyncConfig, listComponents, resolveStateDir } from "./config.js";
import { resolveEntries } from "./scope.js";
import { packState, previewPackState, scanPackState, unpackState } from "./archive.js";
import { pushToDir, resolveFromDir } from "./backends/dir.js";
import { pushToS3, pullFromS3 } from "./backends/s3.js";
import { pushToGit, pullFromGit } from "./backends/git.js";
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

function countPushTargets(opts: { toDir?: string; toS3?: string; toGit?: boolean }): number {
  return [Boolean(opts.toDir), Boolean(opts.toS3), Boolean(opts.toGit)].filter(Boolean).length;
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

function buildPushArgsFromOptions(opts: {
  stateDir?: string;
  config?: string;
  include?: string;
  exclude?: string;
  ignorePaths?: string;
  workspaceIncludeGlobs?: string;
  sanitize?: boolean;
  toDir?: string;
  toS3?: string;
  toGit?: boolean;
  s3Endpoint?: string;
  repoDir?: string;
  repoUrl?: string;
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

  appendArg(args, "--to-dir", opts.toDir);
  appendArg(args, "--to-s3", opts.toS3);
  if (opts.toGit) args.push("--to-git");
  appendArg(args, "--s3-endpoint", opts.s3Endpoint);
  appendArg(args, "--repo-dir", opts.repoDir);
  appendArg(args, "--repo-url", opts.repoUrl);
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
  toDir?: string;
  toS3?: string;
  toGit?: boolean;
  s3Endpoint?: string;
  repoDir?: string;
  repoUrl?: string;
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
  toDir?: string;
  toS3?: string;
  toGit?: boolean;
  s3Endpoint?: string;
  repoDir?: string;
  repoUrl?: string;
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
  fromDir?: string;
  fromS3?: string;
  fromGit?: boolean;
  s3Endpoint?: string;
  repoDir?: string;
  repoUrl?: string;
  branch?: string;
}

async function resolveArchiveFromSource(opts: PullSourceOptions, tempOut: string): Promise<string> {
  if (opts.fromDir) {
    return resolveFromDir(opts.fromDir);
  }
  if (opts.fromS3) {
    return pullFromS3(opts.fromS3, tempOut, opts.s3Endpoint);
  }
  if (opts.fromGit) {
    return pullFromGit({
      repoDir: opts.repoDir,
      repoUrl: opts.repoUrl,
      branch: opts.branch,
    });
  }
  throw new Error("Specify one source: --from-dir, --from-s3, or --from-git");
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
  console.log(`- Ignored by config: ${report.ignoredFiles} (${formatBytes(report.ignoredBytes)})`);
  console.log(
    `- Excluded non-config workspace files: ${report.excludedNonConfigFiles} (${formatBytes(report.excludedNonConfigBytes)})`,
  );
  console.log(`- Included config files: ${report.includedConfigFiles} (${formatBytes(report.includedConfigBytes)})`);
  console.log(
    `- Included by user rule: ${report.includedByUserRuleFiles} (${formatBytes(report.includedByUserRuleBytes)})`,
  );
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
  .description("Sync OpenClaw config/state to directory, S3, or Git")
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
    printMergeReport(mergeReport);
  });

commonOptions(
  program
    .command("push")
    .description("Pack then push to a backend")
    .option("--to-dir <path>", "target directory")
    .option("--to-s3 <s3Uri>", "target s3 uri like s3://bucket/prefix")
    .option("--to-git", "use git backend")
    .option("--s3-endpoint <url>", "custom s3 endpoint")
    .option("--repo-dir <path>", "local git repo directory")
    .option("--repo-url <url>", "git remote origin url")
    .option("--branch <name>", "git branch", "main")
    .option("--reuse-message-channel <mode>", "reuse OpenClaw message channel: yes|no")
    .option("--dry-run", "preview selected files and sanitization without pushing")
).action(async (opts) => {
  const reuseMessageChannel = parseYesNoOption(opts.reuseMessageChannel, "--reuse-message-channel");
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
    if (opts.toDir) console.log(`target: dir ${opts.toDir}`);
    if (opts.toS3) console.log(`target: s3 ${opts.toS3}`);
    if (opts.toGit) console.log(`target: git ${opts.repoUrl ?? opts.repoDir ?? "~/.clawsync-repo"}`);
    if (reuseMessageChannel !== undefined) {
      console.log(`reuse message channel: ${reuseMessageChannel ? "yes" : "no"}`);
    }
    return;
  }
  const { archivePath } = await packState(cfg);

  if (opts.toDir) {
    const finalPath = await pushToDir(archivePath, opts.toDir);
    console.log(`pushed to dir: ${finalPath}`);
    await maybePrintScheduleGuidance(opts);
    return;
  }
  if (opts.toS3) {
    const uri = await pushToS3(archivePath, opts.toS3, opts.s3Endpoint);
    console.log(`pushed to s3: ${uri}`);
    await maybePrintScheduleGuidance(opts);
    return;
  }
  if (opts.toGit) {
    const repoPath = await pushToGit(archivePath, {
      repoDir: opts.repoDir,
      repoUrl: opts.repoUrl,
      branch: opts.branch,
    });
    console.log(`pushed to git repo: ${repoPath}`);
    await maybePrintScheduleGuidance(opts);
    return;
  }
  throw new Error("Specify one target: --to-dir, --to-s3, or --to-git");
});

const scheduleProgram = program
  .command("schedule")
  .description("Install and manage scheduled sync jobs");

commonOptions(
  scheduleProgram
    .command("install")
    .description("Install (or update) a managed cron schedule for push")
    .requiredOption("--every <interval>", "interval like 30m, 2h, 1d")
    .option("--to-dir <path>", "target directory")
    .option("--to-s3 <s3Uri>", "target s3 uri like s3://bucket/prefix")
    .option("--to-git", "use git backend")
    .option("--s3-endpoint <url>", "custom s3 endpoint")
    .option("--repo-dir <path>", "local git repo directory")
    .option("--repo-url <url>", "git remote origin url")
    .option("--branch <name>", "git branch", "main")
    .option("--reuse-message-channel <mode>", "reuse OpenClaw message channel in notifications: yes|no")
).action(async (opts) => {
  if (countPushTargets(opts) !== 1) {
    throw new Error("Specify exactly one target: --to-dir, --to-s3, or --to-git");
  }
  parseYesNoOption(opts.reuseMessageChannel, "--reuse-message-channel");

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
  .description("Pull from backend then unpack")
  .option("--from-dir <path>", "source directory or archive path")
  .option("--from-s3 <s3Uri>", "source s3 uri like s3://bucket/prefix")
  .option("--from-git", "use git backend")
  .option("--s3-endpoint <url>", "custom s3 endpoint")
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
    printMergeReport(mergeReport);
  });

program
  .command("merge")
  .description("Pull from backend and merge into state directory (local-first)")
  .option("--from-dir <path>", "source directory or archive path")
  .option("--from-s3 <s3Uri>", "source s3 uri like s3://bucket/prefix")
  .option("--from-git", "use git backend")
  .option("--s3-endpoint <url>", "custom s3 endpoint")
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
    printMergeReport(mergeReport);
  });

program.parseAsync().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
