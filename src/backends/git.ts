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
  options: { repoDir?: string; repoUrl?: string; branch?: string },
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
