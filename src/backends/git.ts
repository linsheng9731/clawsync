import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { simpleGit, type SimpleGit } from "simple-git";

function defaultRepoDir(): string {
  return path.join(os.homedir(), ".clawsync-repo");
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
    const origin = remotes.find((r: { name: string }) => r.name === "origin");
    if (!origin) {
      await git.addRemote("origin", repoUrl);
    }
  }
  return git;
}

export async function pushToGit(
  archivePath: string,
  options: { repoDir?: string; repoUrl?: string; branch?: string },
): Promise<string> {
  const repoDir = path.resolve(options.repoDir || defaultRepoDir());
  const git = await ensureRepo(repoDir, options.repoUrl, options.branch);
  const branch = options.branch || "main";

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

  const remotes = await git.getRemotes(true);
  if (remotes.find((r: { name: string }) => r.name === "origin")) {
    await git.push(["--set-upstream", "origin", branch]);
  }
  return repoDir;
}

export async function pullFromGit(
  options: { repoDir?: string; repoUrl?: string; branch?: string },
): Promise<string> {
  const repoDir = path.resolve(options.repoDir || defaultRepoDir());
  const git = await ensureRepo(repoDir, options.repoUrl, options.branch);
  const branch = options.branch || "main";

  const remotes = await git.getRemotes(true);
  if (remotes.find((r: { name: string }) => r.name === "origin")) {
    await git.pull("origin", branch);
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
