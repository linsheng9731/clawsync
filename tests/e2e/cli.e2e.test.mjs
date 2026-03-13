import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { once } from "node:events";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const CLI_PATH = path.join(ROOT, "dist", "cli.js");

async function mkTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `clawsync-e2e-${prefix}-`));
}

async function writeStateFixture(stateDir) {
  await fs.mkdir(path.join(stateDir, "workspace", "config"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "workspace", "project"), { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify(
      {
        auth: { apiKey: "sk-live-abc123" },
        nested: { token: "ghp_example" },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(stateDir, ".env"), "OPENAI_API_KEY=sk-test-secret\nNORMAL_KEY=ok\n", "utf8");
  await fs.writeFile(
    path.join(stateDir, "workspace", "config", "settings.json"),
    JSON.stringify({ password: "my-password", safe: "value" }, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(stateDir, "workspace", "project", "notes.txt"), "workspace notes", "utf8");
}

function gitEnv() {
  return {
    GIT_AUTHOR_NAME: "clawsync-e2e",
    GIT_AUTHOR_EMAIL: "e2e@example.com",
    GIT_COMMITTER_NAME: "clawsync-e2e",
    GIT_COMMITTER_EMAIL: "e2e@example.com",
  };
}

async function runCli(args, extraEnv = {}) {
  try {
    const result = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...gitEnv(), ...extraEnv },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function getFreePort() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
  });
}

async function waitForHealth(port, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const response = await httpGet(`http://127.0.0.1:${port}/health`);
      if (response.status === 200) return;
    } catch {
      // ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("serve health check timeout");
}

function matchLineValue(output, prefix) {
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}

async function setupGitBackupFromState(stateDir, branch = "main") {
  const remoteBare = await mkTmpDir("git-remote");
  const repoDirPush = await mkTmpDir("git-repo-push");
  await execFileAsync("git", ["init", "--bare"], { cwd: remoteBare });
  const initResult = await runCli([
    "git",
    "init",
    "--repo-url",
    remoteBare,
    "--repo-dir",
    repoDirPush,
    "--branch",
    branch,
  ]);
  assert.equal(initResult.code, 0, initResult.stderr);
  const pushResult = await runCli([
    "push",
    "--state-dir",
    stateDir,
    "--repo-dir",
    repoDirPush,
    "--branch",
    branch,
  ]);
  assert.equal(pushResult.code, 0, pushResult.stderr);
  return { remoteBare, repoDirPush };
}

test("scope shows default selected components", async () => {
  const stateDir = await mkTmpDir("scope");
  await writeStateFixture(stateDir);
  const result = await runCli(["scope", "--state-dir", stateDir]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /include: config, workspace/);
  assert.match(result.stdout, /paths:/);
  assert.match(result.stdout, /\[config\] openclaw\.json/);
  assert.match(result.stdout, /\[workspace\] workspace/);
});

test("version command supports -v and verbose output", async () => {
  const shortVersion = await runCli(["--version"]);
  assert.equal(shortVersion.code, 0, shortVersion.stderr);
  assert.match(shortVersion.stdout, /0\.1\.7/);

  const verboseVersion = await runCli(["version", "-v"]);
  assert.equal(verboseVersion.code, 0, verboseVersion.stderr);
  assert.match(verboseVersion.stdout, /clawsync 0\.1\.7/);
  assert.match(verboseVersion.stdout, /node:\s+v\d+\.\d+\.\d+/);
  assert.match(verboseVersion.stdout, /platform:\s+\w+\/\w+/);
});

test("pack/unpack sanitizes secrets and generates env scripts", async () => {
  const stateDir = await mkTmpDir("pack");
  const outDir = await mkTmpDir("pack-out");
  const restoreDir = await mkTmpDir("pack-restore");
  await writeStateFixture(stateDir);

  const packResult = await runCli(["pack", "--state-dir", stateDir, "--out", outDir]);
  assert.equal(packResult.code, 0, packResult.stderr);
  assert.match(packResult.stdout, /## Scan Summary/);
  assert.match(packResult.stdout, /### Largest Items/);
  assert.match(packResult.stdout, /## Pack Report/);
  assert.match(packResult.stdout, /### File Details/);
  assert.match(packResult.stdout, /- workspace\/config\/settings\.json/);
  assert.doesNotMatch(packResult.stdout, /- workspace\/project\/notes\.txt/);
  const archivePath = matchLineValue(packResult.stdout, "- Archive:");
  assert.ok(archivePath, "archive path should exist in output");

  const unpackResult = await runCli(["unpack", "--from", archivePath, "--state-dir", restoreDir, "--yes"]);
  assert.equal(unpackResult.code, 0, unpackResult.stderr);
  assert.match(unpackResult.stdout, /env vars missing in current shell/);
  assert.match(unpackResult.stdout, /source ".*env-export\.sh"/);
  assert.doesNotMatch(unpackResult.stdout, /post-restore verification/);

  const restoredConfig = await fs.readFile(path.join(restoreDir, "openclaw.json"), "utf8");
  const restoredEnv = await fs.readFile(path.join(restoreDir, ".env"), "utf8");
  const envScript = await fs.readFile(path.join(restoreDir, "clawsync", "env-export.sh"), "utf8");

  assert.match(restoredConfig, /\$\{CLAWSYNC_AUTH_APIKEY\}/);
  assert.match(restoredEnv, /\$\{CLAWSYNC_OPENAI_API_KEY\}/);
  assert.match(envScript, /CLAWSYNC_AUTH_APIKEY/);
  assert.match(envScript, /sk-live-abc123/);
  assert.equal(existsSync(path.join(restoreDir, "workspace", "project", "notes.txt")), false);
});

test("pack supports ignore-paths and excludes ignored files", async () => {
  const stateDir = await mkTmpDir("pack-ignore");
  const outDir = await mkTmpDir("pack-ignore-out");
  const restoreDir = await mkTmpDir("pack-ignore-restore");
  await writeStateFixture(stateDir);

  const packResult = await runCli([
    "pack",
    "--state-dir",
    stateDir,
    "--out",
    outDir,
    "--ignore-paths",
    "workspace/config/settings.json",
  ]);
  assert.equal(packResult.code, 0, packResult.stderr);
  const archivePath = matchLineValue(packResult.stdout, "- Archive:");
  assert.ok(archivePath, "archive path should exist in output");
  assert.doesNotMatch(packResult.stdout, /- workspace\/config\/settings\.json/);

  const unpackResult = await runCli(["unpack", "--from", archivePath, "--state-dir", restoreDir, "--yes"]);
  assert.equal(unpackResult.code, 0, unpackResult.stderr);
  assert.equal(existsSync(path.join(restoreDir, "workspace", "config", "settings.json")), false);
});

test("pack supports workspace include globs for non-config files", async () => {
  const stateDir = await mkTmpDir("pack-workspace-rules");
  const outDir = await mkTmpDir("pack-workspace-rules-out");
  const restoreDir = await mkTmpDir("pack-workspace-rules-restore");
  await writeStateFixture(stateDir);

  const packResult = await runCli([
    "pack",
    "--state-dir",
    stateDir,
    "--out",
    outDir,
    "--workspace-include-globs",
    "project/**/*.txt",
  ]);
  assert.equal(packResult.code, 0, packResult.stderr);
  assert.match(packResult.stdout, /included-by-user-rule/);
  assert.match(packResult.stdout, /- workspace\/project\/notes\.txt/);
  const archivePath = matchLineValue(packResult.stdout, "- Archive:");
  assert.ok(archivePath, "archive path should exist in output");

  const unpackResult = await runCli(["unpack", "--from", archivePath, "--state-dir", restoreDir, "--yes"]);
  assert.equal(unpackResult.code, 0, unpackResult.stderr);
  assert.equal(existsSync(path.join(restoreDir, "workspace", "project", "notes.txt")), true);
});

test("pull with --strategy merge keeps local conflicts and prints conflict details", async () => {
  const sourceStateDir = await mkTmpDir("merge-source");
  const localStateDir = await mkTmpDir("merge-local");
  await writeStateFixture(sourceStateDir);
  const { remoteBare } = await setupGitBackupFromState(sourceStateDir, "main");

  await fs.writeFile(
    path.join(localStateDir, "openclaw.json"),
    JSON.stringify({ auth: { apiKey: "local-only-key" } }, null, 2),
    "utf8",
  );

  const mergeResult = await runCli([
    "pull",
    "--repo-url",
    remoteBare,
    "--state-dir",
    localStateDir,
    "--strategy",
    "merge",
    "--yes",
  ]);
  assert.equal(mergeResult.code, 0, mergeResult.stderr);
  assert.match(mergeResult.stdout, /## Merge Report/);
  assert.match(mergeResult.stdout, /- Conflicts:\s+1/);
  assert.match(mergeResult.stdout, /\|\s*`openclaw\.json`\s*\|\s*`content-different`\s*\|/);

  const localConfig = await fs.readFile(path.join(localStateDir, "openclaw.json"), "utf8");
  assert.match(localConfig, /local-only-key/);
  assert.ok(existsSync(path.join(localStateDir, "workspace", "config", "settings.json")));
});

test("merge command performs local-first merge and reports conflicts", async () => {
  const sourceStateDir = await mkTmpDir("merge-cmd-source");
  const localStateDir = await mkTmpDir("merge-cmd-local");
  await writeStateFixture(sourceStateDir);
  const { remoteBare } = await setupGitBackupFromState(sourceStateDir, "main");

  await fs.writeFile(path.join(localStateDir, "openclaw.json"), "{\"auth\":{\"apiKey\":\"local\"}}", "utf8");

  const mergeResult = await runCli([
    "merge",
    "--repo-url",
    remoteBare,
    "--state-dir",
    localStateDir,
    "--yes",
  ]);
  assert.equal(mergeResult.code, 0, mergeResult.stderr);
  assert.match(mergeResult.stdout, /merged to:/);
  assert.match(mergeResult.stdout, /### Conflict Details/);
  assert.match(mergeResult.stdout, /\|\s*`openclaw\.json`\s*\|\s*`content-different`\s*\|/);
});

test("merge does not report conflicts for identical local files", async () => {
  const sourceStateDir = await mkTmpDir("merge-identical-source");
  const localStateDir = await mkTmpDir("merge-identical-local");
  await writeStateFixture(sourceStateDir);
  const remoteBare = await mkTmpDir("merge-identical-remote");
  const repoDir = await mkTmpDir("merge-identical-repo");
  await execFileAsync("git", ["init", "--bare"], { cwd: remoteBare });
  const initResult = await runCli(["git", "init", "--repo-url", remoteBare, "--repo-dir", repoDir, "--branch", "main"]);
  assert.equal(initResult.code, 0, initResult.stderr);
  const pushResult = await runCli([
    "push",
    "--state-dir",
    sourceStateDir,
    "--repo-dir",
    repoDir,
    "--branch",
    "main",
    "--no-sanitize",
  ]);
  assert.equal(pushResult.code, 0, pushResult.stderr);

  const originalConfig = await fs.readFile(path.join(sourceStateDir, "openclaw.json"), "utf8");
  await fs.writeFile(path.join(localStateDir, "openclaw.json"), originalConfig, "utf8");

  const mergeResult = await runCli([
    "pull",
    "--repo-url",
    remoteBare,
    "--state-dir",
    localStateDir,
    "--strategy",
    "merge",
    "--yes",
  ]);
  assert.equal(mergeResult.code, 0, mergeResult.stderr);
  assert.match(mergeResult.stdout, /- Conflicts:\s+0/);
});

test("profile full-migrate packs channels/devices/identity locally", async () => {
  const stateDir = await mkTmpDir("profile-full-migrate");
  const outDir = await mkTmpDir("profile-full-migrate-out");
  const restoreDir = await mkTmpDir("profile-full-migrate-restore");
  await writeStateFixture(stateDir);
  await fs.mkdir(path.join(stateDir, "devices"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "identity"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "telegram"), { recursive: true });
  await fs.writeFile(path.join(stateDir, "devices", "paired.json"), '{"node":"ok"}', "utf8");
  await fs.writeFile(path.join(stateDir, "identity", "device.json"), '{"id":"abc"}', "utf8");
  await fs.writeFile(path.join(stateDir, "telegram", "offset.json"), '{"offset":1}', "utf8");
  await fs.mkdir(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "agents", "main", "sessions", "04c43f73-0312-4c8f-bb55-af2e814b6873.jsonl.deleted.2026-02-27T00-21-06.085Z"),
    "session tombstone",
    "utf8",
  );

  const profileResult = await runCli([
    "profile",
    "full-migrate",
    "--state-dir",
    stateDir,
    "--out",
    outDir,
  ]);
  assert.equal(profileResult.code, 0, profileResult.stderr);
  assert.match(profileResult.stdout, /profile: full-migrate/);
  assert.match(profileResult.stdout, /target: local archive only \(no git push\)/);
  assert.match(profileResult.stdout, /- agents\/main\/sessions/);
  assert.doesNotMatch(
    profileResult.stdout,
    /agents\/main\/sessions\/04c43f73-0312-4c8f-bb55-af2e814b6873\.jsonl\.deleted\.2026-02-27T00-21-06\.085Z/,
  );
  const archivePath = matchLineValue(profileResult.stdout, "- Archive:");
  assert.ok(archivePath, "archive path should exist in output");

  const unpackResult = await runCli(["unpack", "--from", archivePath, "--state-dir", restoreDir, "--yes"]);
  assert.equal(unpackResult.code, 0, unpackResult.stderr);
  assert.equal(existsSync(path.join(restoreDir, "devices", "paired.json")), true);
  assert.equal(existsSync(path.join(restoreDir, "identity", "device.json")), true);
  assert.equal(existsSync(path.join(restoreDir, "telegram", "offset.json")), true);
});

test("unpack preserves local gateway token by default", async () => {
  const sourceStateDir = await mkTmpDir("token-source");
  const targetStateDir = await mkTmpDir("token-target");
  const outDir = await mkTmpDir("token-out");
  await writeStateFixture(sourceStateDir);
  await fs.writeFile(
    path.join(sourceStateDir, "openclaw.json"),
    JSON.stringify({ gateway: { auth: { token: "backup-token-123" } } }, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(targetStateDir, "openclaw.json"),
    JSON.stringify({ gateway: { auth: { token: "local-token-999" } } }, null, 2),
    "utf8",
  );

  const packResult = await runCli([
    "profile",
    "full-migrate",
    "--state-dir",
    sourceStateDir,
    "--out",
    outDir,
  ]);
  assert.equal(packResult.code, 0, packResult.stderr);
  const archivePath = matchLineValue(packResult.stdout, "- Archive:");
  assert.ok(archivePath, "archive path should exist in output");

  const restoreResult = await runCli([
    "unpack",
    "--from",
    archivePath,
    "--state-dir",
    targetStateDir,
    "--yes",
  ]);
  assert.equal(restoreResult.code, 0, restoreResult.stderr);
  assert.match(restoreResult.stdout, /gateway token: preserved from local machine/);

  const restoredConfigRaw = await fs.readFile(path.join(targetStateDir, "openclaw.json"), "utf8");
  const restoredConfig = JSON.parse(restoredConfigRaw);
  assert.equal(restoredConfig.gateway?.auth?.token, "local-token-999");
});

test("serve supports token auth for archive list and download", async () => {
  const archiveDir = await mkTmpDir("serve-archives");
  const port = await getFreePort();
  const token = "serve-test-token";
  const archiveName = "sample-archive.tar.gz";
  const archivePath = path.join(archiveDir, archiveName);
  await fs.writeFile(archivePath, "dummy-archive-content", "utf8");

  const serverProc = spawn(
    process.execPath,
    [CLI_PATH, "serve", "--token", token, "--port", String(port), "--dir", archiveDir],
    { cwd: ROOT, env: { ...process.env } },
  );
  try {
    await waitForHealth(port);

    const unauthorizedList = await httpGet(`http://127.0.0.1:${port}/archives`);
    assert.equal(unauthorizedList.status, 401);

    const listResponse = await httpGet(`http://127.0.0.1:${port}/archives?token=${token}`);
    assert.equal(listResponse.status, 200);
    assert.match(listResponse.body, /sample-archive\.tar\.gz/);

    const downloadResponse = await httpGet(
      `http://127.0.0.1:${port}/download/${encodeURIComponent(archiveName)}?token=${token}`,
    );
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.body, "dummy-archive-content");
  } finally {
    serverProc.kill("SIGTERM");
    await Promise.race([
      once(serverProc, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
});

test("push/pull with git backend and local bare remote", async () => {
  const stateDir = await mkTmpDir("git");
  const remoteBare = await mkTmpDir("git-remote");
  const repoDirPush = await mkTmpDir("git-repo-push");
  const repoDirPull = await mkTmpDir("git-repo-pull");
  const restoreDir = await mkTmpDir("git-restore");
  await writeStateFixture(stateDir);
  await execFileAsync("git", ["init", "--bare"], { cwd: remoteBare });
  const initResult = await runCli([
    "git",
    "init",
    "--repo-url",
    remoteBare,
    "--repo-dir",
    repoDirPush,
    "--branch",
    "main",
  ]);
  assert.equal(initResult.code, 0, initResult.stderr);

  const pushResult = await runCli([
    "push",
    "--state-dir",
    stateDir,
    "--repo-dir",
    repoDirPush,
    "--branch",
    "main",
  ]);
  assert.equal(pushResult.code, 0, pushResult.stderr);
  assert.ok(existsSync(path.join(repoDirPush, "latest.txt")));

  const pullResult = await runCli([
    "pull",
    "--repo-url",
    remoteBare,
    "--repo-dir",
    repoDirPull,
    "--branch",
    "main",
    "--state-dir",
    restoreDir,
    "--yes",
  ]);
  assert.equal(pullResult.code, 0, pullResult.stderr);
  assert.ok(existsSync(path.join(restoreDir, "openclaw.json")));
});

test("push with git backend defaults branch to clawsync_<YYYYMMDD>", async () => {
  const stateDir = await mkTmpDir("git-default-branch");
  const remoteBare = await mkTmpDir("git-default-branch-remote");
  const repoDir = await mkTmpDir("git-default-branch-repo");
  await writeStateFixture(stateDir);
  await execFileAsync("git", ["init", "--bare"], { cwd: remoteBare });
  const initResult = await runCli(["git", "init", "--repo-url", remoteBare, "--repo-dir", repoDir]);
  assert.equal(initResult.code, 0, initResult.stderr);

  const pushResult = await runCli([
    "push",
    "--state-dir",
    stateDir,
    "--repo-dir",
    repoDir,
  ]);
  assert.equal(pushResult.code, 0, pushResult.stderr);

  const today = new Date();
  const y = String(today.getFullYear());
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const expectedBranch = `clawsync_${y}${m}${d}`;
  const remoteBranch = await execFileAsync("git", ["show-ref", "--verify", `refs/heads/${expectedBranch}`], {
    cwd: remoteBare,
  });
  assert.ok(remoteBranch.stdout.trim().length > 0);
});

test("git init can update origin for existing repo-dir", async () => {
  const remoteA = await mkTmpDir("git-reinit-remote-a");
  const remoteB = await mkTmpDir("git-reinit-remote-b");
  const repoDir = await mkTmpDir("git-reinit-repo");
  await execFileAsync("git", ["init", "--bare"], { cwd: remoteA });
  await execFileAsync("git", ["init", "--bare"], { cwd: remoteB });

  const firstInit = await runCli(["git", "init", "--repo-url", remoteA, "--repo-dir", repoDir]);
  assert.equal(firstInit.code, 0, firstInit.stderr);
  const secondInit = await runCli(["git", "init", "--repo-url", remoteB, "--repo-dir", repoDir]);
  assert.equal(secondInit.code, 0, secondInit.stderr);

  const originUrl = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: repoDir });
  assert.equal(originUrl.stdout.trim(), remoteB);
});

test("push to git without init shows guidance", async () => {
  const stateDir = await mkTmpDir("git-push-no-init-state");
  const repoDir = await mkTmpDir("git-push-no-init-repo");
  await writeStateFixture(stateDir);

  const pushResult = await runCli([
    "push",
    "--state-dir",
    stateDir,
    "--repo-dir",
    repoDir,
  ]);
  assert.notEqual(pushResult.code, 0);
  assert.match(pushResult.stderr, /clawsync git init --repo-url/);
});

test("dry-run preview works and reuse-message-channel validates yes/no", async () => {
  const stateDir = await mkTmpDir("dry-run");
  const remoteBare = await mkTmpDir("dry-run-remote");
  const repoDir = await mkTmpDir("dry-run-repo");
  await writeStateFixture(stateDir);
  await execFileAsync("git", ["init", "--bare"], { cwd: remoteBare });
  const initResult = await runCli(["git", "init", "--repo-url", remoteBare, "--repo-dir", repoDir]);
  assert.equal(initResult.code, 0, initResult.stderr);

  const dryRun = await runCli([
    "push",
    "--state-dir",
    stateDir,
    "--repo-dir",
    repoDir,
    "--dry-run",
    "--reuse-message-channel",
    "yes",
  ]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /dry-run mode/);
  assert.match(dryRun.stdout, /target: git/);
  assert.match(dryRun.stdout, /reuse message channel: yes/);

  const invalid = await runCli([
    "push",
    "--state-dir",
    stateDir,
    "--repo-dir",
    repoDir,
    "--reuse-message-channel",
    "maybe",
  ]);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /Invalid value for --reuse-message-channel/);
});

test("schedule install/status/remove works with mocked crontab", async () => {
  const stateDir = await mkTmpDir("schedule");
  const remoteBare = await mkTmpDir("schedule-remote");
  const repoDir = await mkTmpDir("schedule-repo");
  const binDir = await mkTmpDir("schedule-bin");
  const fakeCrontab = path.join(binDir, "crontab");
  const crontabFile = path.join(binDir, "crontab.txt");

  await fs.writeFile(
    fakeCrontab,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const file = process.env.CLAWSYNC_TEST_CRONTAB_FILE;
if (!file) {
  console.error("missing CLAWSYNC_TEST_CRONTAB_FILE");
  process.exit(2);
}
if (args[0] === "-l") {
  if (!fs.existsSync(file)) {
    console.error("no crontab for test-user");
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(file, "utf8"));
  process.exit(0);
}
if (args.length === 1) {
  fs.copyFileSync(args[0], file);
  process.exit(0);
}
console.error("unsupported args");
process.exit(2);
`,
    { mode: 0o755 },
  );
  await writeStateFixture(stateDir);
  await execFileAsync("git", ["init", "--bare"], { cwd: remoteBare });
  const initResult = await runCli(["git", "init", "--repo-url", remoteBare, "--repo-dir", repoDir]);
  assert.equal(initResult.code, 0, initResult.stderr);

  const env = {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    CLAWSYNC_TEST_CRONTAB_FILE: crontabFile,
  };

  const installResult = await runCli(
    [
      "schedule",
      "install",
      "--every",
      "1d",
      "--state-dir",
      stateDir,
      "--repo-dir",
      repoDir,
      "--ignore-paths",
      "workspace/cache,media",
      "--workspace-include-globs",
      "project/**/*.txt",
    ],
    env,
  );
  assert.equal(installResult.code, 0, installResult.stderr);
  assert.match(installResult.stdout, /schedule installed|schedule updated/);

  const statusResult = await runCli(["schedule", "status"], env);
  assert.equal(statusResult.code, 0, statusResult.stderr);
  assert.match(statusResult.stdout, /schedule: installed/);

  const crontabContent = await fs.readFile(crontabFile, "utf8");
  assert.match(crontabContent, /--ignore-paths/);
  assert.match(crontabContent, /workspace\/cache,media/);
  assert.match(crontabContent, /--workspace-include-globs/);
  assert.match(crontabContent, /project\/\*\*\/\*\.txt/);

  const removeResult = await runCli(["schedule", "remove"], env);
  assert.equal(removeResult.code, 0, removeResult.stderr);
  assert.match(removeResult.stdout, /schedule removed/);
});
