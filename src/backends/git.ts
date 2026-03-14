import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { simpleGit, type SimpleGit } from "simple-git";

function defaultRepoDir(): string {
  return path.join(os.homedir(), ".clawsync-repo");
}

export function getDefaultGitRepoDir(): string {
  return defaultRepoDir();
}

function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\.git$/, "");
}

function formatDateForBranch(date = new Date()): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function defaultPushBranch(): string {
  return `clawsync_${formatDateForBranch()}`;
}

export function getDefaultGitPushBranch(): string {
  return defaultPushBranch();
}

function parseClawsyncBranchDate(branchName: string): Date | null {
  const match = /^clawsync_(\d{4})(\d{2})(\d{2})$/.exec(branchName);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function startOfUtcDay(input: Date): Date {
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
}

function diffUtcDays(later: Date, earlier: Date): number {
  const ms = startOfUtcDay(later).getTime() - startOfUtcDay(earlier).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

async function ensureBranch(git: SimpleGit, branch: string): Promise<void> {
  const local = await git.branchLocal();
  if (local.all.includes(branch)) {
    await git.checkout(branch);
    return;
  }

  const remote = await git.branch(["-r"]);
  const remoteBranch = `origin/${branch}`;
  if (remote.all.includes(remoteBranch)) {
    await git.checkout(["-B", branch, remoteBranch]);
    return;
  }

  await git.checkoutLocalBranch(branch);
}

async function remoteBranchExists(git: SimpleGit, branch: string): Promise<boolean> {
  const output = await git.listRemote(["--heads", "origin", branch]);
  return output.trim().length > 0;
}

async function ensureRepo(repoDir: string, repoUrl?: string, branch = "main"): Promise<SimpleGit> {
  const abs = path.resolve(repoDir || defaultRepoDir());
  await fs.ensureDir(abs);
  const git = simpleGit(abs);
  const hasGitDir = await fs.pathExists(path.join(abs, ".git"));

  if (!hasGitDir) {
    if (repoUrl) {
      try {
        await simpleGit().clone(repoUrl, abs, ["--branch", branch]);
      } catch {
        // Empty or branch-less remote: initialize locally then attach origin.
        await git.init(["-b", branch]);
      }
    } else {
      await git.init(["-b", branch]);
    }
  }

  if (repoUrl) {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r: { name: string; refs?: { fetch?: string; push?: string } }) => r.name === "origin");
    if (!origin) {
      await git.addRemote("origin", repoUrl);
    } else {
      const fetchUrl = origin.refs?.fetch;
      if (!fetchUrl || normalizeRepoUrl(fetchUrl) !== normalizeRepoUrl(repoUrl)) {
        await git.remote(["set-url", "origin", repoUrl]);
      }
    }
  }

  await ensureBranch(git, branch);
  return git;
}

export async function initGitRepo(options: { repoDir?: string; repoUrl: string; branch?: string }): Promise<{
  repoDir: string;
  originUrl: string;
  branch: string;
}> {
  const repoDir = path.resolve(options.repoDir || defaultRepoDir());
  const branch = options.branch || "main";
  const git = await ensureRepo(repoDir, options.repoUrl, branch);
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r: { name: string; refs?: { fetch?: string } }) => r.name === "origin");
  if (!origin?.refs?.fetch) {
    throw new Error(`Failed to configure git origin in ${repoDir}.`);
  }
  const branchInfo = await git.branchLocal();
  return {
    repoDir,
    originUrl: origin.refs.fetch,
    branch: branchInfo.current || branch,
  };
}

export async function canPushToGit(options: { repoDir?: string }): Promise<{ repoDir: string; originUrl: string | null }> {
  const repoDir = path.resolve(options.repoDir || defaultRepoDir());
  const hasGitDir = await fs.pathExists(path.join(repoDir, ".git"));
  if (!hasGitDir) {
    return { repoDir, originUrl: null };
  }
  const git = simpleGit(repoDir);
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r: { name: string; refs?: { fetch?: string } }) => r.name === "origin");
  return {
    repoDir,
    originUrl: origin?.refs?.fetch ?? null,
  };
}

export async function pushToGit(
  archivePath: string,
  options: { repoDir?: string; repoUrl?: string; branch?: string; keepArchives?: number },
): Promise<string> {
  const repoDir = path.resolve(options.repoDir || defaultRepoDir());
  const branch = options.branch || defaultPushBranch();
  const git = await ensureRepo(repoDir, options.repoUrl, branch);

  const remotes = await git.getRemotes(true);
  const hasOrigin = remotes.some((r: { name: string }) => r.name === "origin");
  if (!hasOrigin) {
    throw new Error(
      `Git remote 'origin' is not configured in ${repoDir}. Run: clawsync git init --repo-url <your-repo-url> --repo-dir ${repoDir}`,
    );
  }
  if (hasOrigin) {
    if (await remoteBranchExists(git, branch)) {
      try {
        await git.pull("origin", branch, { "--rebase": "true" });
      } catch (error) {
        const message = (error as Error).message || "";
        throw new Error(
          `Failed to rebase local '${branch}' with origin/${branch}. Resolve in ${repoDir}, then retry. git error: ${message}`,
        );
      }
    }
  }

  await fs.ensureDir(path.join(repoDir, "archives"));
  const name = path.basename(archivePath);
  const target = path.join(repoDir, "archives", name);
  await fs.copyFile(archivePath, target);
  await fs.writeFile(path.join(repoDir, "latest.txt"), `archives/${name}\n`, "utf8");

  if (options.keepArchives !== undefined) {
    const keep = options.keepArchives;
    if (!Number.isInteger(keep) || keep <= 0) {
      throw new Error(`Invalid keep value: ${keep}. Use a positive integer.`);
    }
    const archivesDir = path.join(repoDir, "archives");
    const archiveNames = (await fs.readdir(archivesDir))
      .filter((item) => item.endsWith(".tar.gz"))
      .sort()
      .reverse();
    const toRemove = archiveNames.slice(keep);
    for (const oldName of toRemove) {
      await fs.remove(path.join(archivesDir, oldName));
    }
  }

  await git.add(["archives", "latest.txt"]);
  const status = await git.status();
  if (status.files.length > 0) {
    await git.commit(`sync clawsync state ${new Date().toISOString()}`);
  }

  if (hasOrigin) {
    try {
      await git.push(["--set-upstream", "origin", branch]);
    } catch (error) {
      const message = (error as Error).message || "";
      if (/fetch first|non-fast-forward|rejected/i.test(message)) {
        throw new Error(
          `Git push rejected for branch '${branch}'. Remote has new commits; rerun clawsync push to auto-rebase, or resolve manually with: git -C ${repoDir} pull --rebase origin ${branch}`,
        );
      }
      throw error;
    }
  }
  return repoDir;
}

export async function pullFromGit(
  options: { repoDir?: string; repoUrl?: string; branch?: string },
): Promise<string> {
  const repoDir = path.resolve(options.repoDir || defaultRepoDir());
  const branch = options.branch || "main";
  const git = await ensureRepo(repoDir, options.repoUrl, branch);

  const remotes = await git.getRemotes(true);
  if (remotes.find((r: { name: string }) => r.name === "origin") && (await remoteBranchExists(git, branch))) {
    await git.pull("origin", branch, { "--rebase": "true" });
  }

  const latestPath = path.join(repoDir, "latest.txt");
  if (!(await fs.pathExists(latestPath))) {
    throw new Error(`latest.txt not found in git repo: ${repoDir}`);
  }
  const rel = (await fs.readFile(latestPath, "utf8")).trim();
  const archivePath = path.join(repoDir, rel);
  if (!(await fs.pathExists(archivePath))) {
    throw new Error(`Archive referenced by latest.txt does not exist: ${archivePath}`);
  }
  return archivePath;
}

export async function pruneRemoteClawsyncBranches(options: {
  repoDir?: string;
  repoUrl?: string;
  keepDays: number;
  apply: boolean;
  now?: Date;
}): Promise<{
  keepDays: number;
  scannedRemoteBranches: number;
  candidates: string[];
  deleted: string[];
}> {
  if (!Number.isInteger(options.keepDays) || options.keepDays <= 0) {
    throw new Error(`Invalid keepDays value: ${options.keepDays}. Use a positive integer.`);
  }

  const repoDir = path.resolve(options.repoDir || defaultRepoDir());
  const git = await ensureRepo(repoDir, options.repoUrl, "main");
  const remotes = await git.getRemotes(true);
  const hasOrigin = remotes.some((r: { name: string }) => r.name === "origin");
  if (!hasOrigin) {
    throw new Error(
      `Git remote 'origin' is not configured in ${repoDir}. Run: clawsync git init --repo-url <your-repo-url> --repo-dir ${repoDir}`,
    );
  }

  const raw = await git.listRemote(["--heads", "origin"]);
  const remoteBranches = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1] ?? "")
    .filter((ref) => ref.startsWith("refs/heads/"))
    .map((ref) => ref.replace("refs/heads/", ""));

  const now = options.now ?? new Date();
  const candidates: string[] = [];
  for (const branch of remoteBranches) {
    const parsedDate = parseClawsyncBranchDate(branch);
    if (!parsedDate) continue;
    const ageDays = diffUtcDays(now, parsedDate);
    if (ageDays > options.keepDays) {
      candidates.push(branch);
    }
  }

  const deleted: string[] = [];
  if (options.apply) {
    for (const branch of candidates) {
      await git.push(["origin", "--delete", branch]);
      deleted.push(branch);
    }
  }

  return {
    keepDays: options.keepDays,
    scannedRemoteBranches: remoteBranches.length,
    candidates,
    deleted,
  };
}
