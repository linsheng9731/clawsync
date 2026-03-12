import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "fs-extra";
import type { CronJobStatus } from "../types.js";

const execFileAsync = promisify(execFile);

export const MANAGED_CRON_TAG = "clawsync:managed";

function quoteShellArg(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parseInterval(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const match = /^(\d+)([mhd])$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid interval "${input}". Use formats like 30m, 2h, 1d.`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`Invalid interval amount in "${input}".`);
  }

  if (unit === "m") {
    if (amount > 59) throw new Error("Minute interval must be between 1 and 59.");
    return `*/${amount} * * * *`;
  }

  if (unit === "h") {
    if (amount > 23) throw new Error("Hour interval must be between 1 and 23.");
    return `0 */${amount} * * *`;
  }

  if (amount === 1) return "0 2 * * *";
  if (amount > 31) throw new Error("Day interval must be between 1 and 31.");
  return `0 2 */${amount} * *`;
}

export function buildCronCommand(options: {
  nodePath: string;
  cliPath: string;
  pushArgs: string[];
  logPath: string;
}): string {
  const base = `${quoteShellArg(options.nodePath)} ${quoteShellArg(options.cliPath)} push`;
  const args = options.pushArgs.map(quoteShellArg).join(" ");
  const redirect = `>> ${quoteShellArg(options.logPath)} 2>&1`;
  return [base, args, redirect].filter(Boolean).join(" ");
}

export function buildManagedCronLine(cronExpr: string, cronCommand: string): string {
  return `${cronExpr} ${cronCommand} # ${MANAGED_CRON_TAG}`;
}

async function readCrontabRaw(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("crontab", ["-l"]);
    return stdout ?? "";
  } catch (error) {
    const err = error as { code?: number; stderr?: string; message?: string };
    const msg = `${err.stderr ?? ""} ${err.message ?? ""}`;
    if (err.code === 1 && /no crontab/i.test(msg)) return "";
    throw new Error(`Failed to read crontab: ${msg.trim()}`);
  }
}

async function writeCrontabRaw(content: string): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawsync-cron-"));
  const tempFile = path.join(tempDir, "crontab.txt");
  try {
    await fs.writeFile(tempFile, content, "utf8");
    await execFileAsync("crontab", [tempFile]);
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(`Failed to write crontab: ${`${err.stderr ?? ""} ${err.message ?? ""}`.trim()}`);
  } finally {
    await fs.remove(tempDir);
  }
}

function splitCrontabLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function isManagedLine(line: string): boolean {
  return line.includes(MANAGED_CRON_TAG);
}

function parseManagedLine(line: string): CronJobStatus {
  const stripped = line.replace(new RegExp(`\\s+#\\s*${MANAGED_CRON_TAG}\\s*$`), "").trim();
  const parts = stripped.split(/\s+/);
  if (parts.length < 6) {
    return { installed: true, rawLine: line };
  }
  return {
    installed: true,
    cronExpression: parts.slice(0, 5).join(" "),
    command: parts.slice(5).join(" "),
    rawLine: line,
  };
}

export async function getCronJobStatus(): Promise<CronJobStatus> {
  const raw = await readCrontabRaw();
  const managedLine = splitCrontabLines(raw).find(isManagedLine);
  if (!managedLine) return { installed: false };
  return parseManagedLine(managedLine);
}

export async function installCronJob(managedCronLine: string): Promise<{ replacedCount: number }> {
  const currentRaw = await readCrontabRaw();
  const currentLines = splitCrontabLines(currentRaw);
  const retained = currentLines.filter((line) => !isManagedLine(line));
  const replacedCount = currentLines.length - retained.length;
  const nextLines = [...retained, managedCronLine];
  await writeCrontabRaw(`${nextLines.join("\n")}\n`);
  return { replacedCount };
}

export async function removeCronJob(): Promise<{ removedCount: number }> {
  const currentRaw = await readCrontabRaw();
  const currentLines = splitCrontabLines(currentRaw);
  const retained = currentLines.filter((line) => !isManagedLine(line));
  const removedCount = currentLines.length - retained.length;
  if (removedCount === 0) return { removedCount };
  await writeCrontabRaw(retained.length > 0 ? `${retained.join("\n")}\n` : "");
  return { removedCount };
}
