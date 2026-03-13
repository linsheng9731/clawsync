import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import S3rver from "s3rver";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const CLI_PATH = path.join(ROOT, "dist", "cli.js");

async function mkTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `clawsync-e2e-${prefix}-`));
}

async function writeStateFixture(stateDir) {
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
    path.join(stateDir, "workspace", "project", "config.json"),
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

function matchLineValue(output, prefix) {
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
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
  assert.match(shortVersion.stdout, /0\.1\.1/);

  const verboseVersion = await runCli(["version", "-v"]);
  assert.equal(verboseVersion.code, 0, verboseVersion.stderr);
  assert.match(verboseVersion.stdout, /clawsync 0\.1\.1/);
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
  assert.match(packResult.stdout, /- workspace\/project\/config\.json/);
  assert.match(packResult.stdout, /excluded-non-config/);
  assert.doesNotMatch(packResult.stdout, /- workspace\/project\/notes\.txt/);
  const archivePath = matchLineValue(packResult.stdout, "- Archive:");
  assert.ok(archivePath, "archive path should exist in output");

  const unpackResult = await runCli(["unpack", "--from", archivePath, "--state-dir", restoreDir]);
  assert.equal(unpackResult.code, 0, unpackResult.stderr);
  assert.match(unpackResult.stdout, /env scripts:/);

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
    "workspace/project/config.json",
  ]);
  assert.equal(packResult.code, 0, packResult.stderr);
  const archivePath = matchLineValue(packResult.stdout, "- Archive:");
  assert.ok(archivePath, "archive path should exist in output");
  assert.doesNotMatch(packResult.stdout, /- workspace\/project\/config\.json/);

  const unpackResult = await runCli(["unpack", "--from", archivePath, "--state-dir", restoreDir]);
  assert.equal(unpackResult.code, 0, unpackResult.stderr);
  assert.equal(existsSync(path.join(restoreDir, "workspace", "project", "config.json")), false);
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

  const unpackResult = await runCli(["unpack", "--from", archivePath, "--state-dir", restoreDir]);
  assert.equal(unpackResult.code, 0, unpackResult.stderr);
  assert.equal(existsSync(path.join(restoreDir, "workspace", "project", "notes.txt")), true);
});

test("push/pull with directory backend", async () => {
  const stateDir = await mkTmpDir("dir");
  const backupDir = await mkTmpDir("dir-backup");
  const restoreDir = await mkTmpDir("dir-restore");
  await writeStateFixture(stateDir);

  const pushResult = await runCli(["push", "--state-dir", stateDir, "--to-dir", backupDir]);
  assert.equal(pushResult.code, 0, pushResult.stderr);
  assert.ok(existsSync(path.join(backupDir, "latest.txt")));

  const pullResult = await runCli(["pull", "--from-dir", backupDir, "--state-dir", restoreDir]);
  assert.equal(pullResult.code, 0, pullResult.stderr);
  assert.ok(existsSync(path.join(restoreDir, "openclaw.json")));
});

test("pull with --strategy merge keeps local conflicts and prints conflict details", async () => {
  const sourceStateDir = await mkTmpDir("merge-source");
  const backupDir = await mkTmpDir("merge-backup");
  const localStateDir = await mkTmpDir("merge-local");
  await writeStateFixture(sourceStateDir);

  const pushResult = await runCli(["push", "--state-dir", sourceStateDir, "--to-dir", backupDir]);
  assert.equal(pushResult.code, 0, pushResult.stderr);

  await fs.writeFile(
    path.join(localStateDir, "openclaw.json"),
    JSON.stringify({ auth: { apiKey: "local-only-key" } }, null, 2),
    "utf8",
  );

  const mergeResult = await runCli([
    "pull",
    "--from-dir",
    backupDir,
    "--state-dir",
    localStateDir,
    "--strategy",
    "merge",
  ]);
  assert.equal(mergeResult.code, 0, mergeResult.stderr);
  assert.match(mergeResult.stdout, /## Merge Report/);
  assert.match(mergeResult.stdout, /- Conflicts:\s+1/);
  assert.match(mergeResult.stdout, /\|\s*`openclaw\.json`\s*\|\s*`content-different`\s*\|/);

  const localConfig = await fs.readFile(path.join(localStateDir, "openclaw.json"), "utf8");
  assert.match(localConfig, /local-only-key/);
  assert.ok(existsSync(path.join(localStateDir, "workspace", "project", "config.json")));
});

test("merge command performs local-first merge and reports conflicts", async () => {
  const sourceStateDir = await mkTmpDir("merge-cmd-source");
  const backupDir = await mkTmpDir("merge-cmd-backup");
  const localStateDir = await mkTmpDir("merge-cmd-local");
  await writeStateFixture(sourceStateDir);

  const pushResult = await runCli(["push", "--state-dir", sourceStateDir, "--to-dir", backupDir]);
  assert.equal(pushResult.code, 0, pushResult.stderr);

  await fs.writeFile(path.join(localStateDir, "openclaw.json"), "{\"auth\":{\"apiKey\":\"local\"}}", "utf8");

  const mergeResult = await runCli([
    "merge",
    "--from-dir",
    backupDir,
    "--state-dir",
    localStateDir,
  ]);
  assert.equal(mergeResult.code, 0, mergeResult.stderr);
  assert.match(mergeResult.stdout, /merged to:/);
  assert.match(mergeResult.stdout, /### Conflict Details/);
  assert.match(mergeResult.stdout, /\|\s*`openclaw\.json`\s*\|\s*`content-different`\s*\|/);
});

test("merge does not report conflicts for identical local files", async () => {
  const sourceStateDir = await mkTmpDir("merge-identical-source");
  const backupDir = await mkTmpDir("merge-identical-backup");
  const localStateDir = await mkTmpDir("merge-identical-local");
  await writeStateFixture(sourceStateDir);

  const pushResult = await runCli(["push", "--state-dir", sourceStateDir, "--to-dir", backupDir, "--no-sanitize"]);
  assert.equal(pushResult.code, 0, pushResult.stderr);

  const originalConfig = await fs.readFile(path.join(sourceStateDir, "openclaw.json"), "utf8");
  await fs.writeFile(path.join(localStateDir, "openclaw.json"), originalConfig, "utf8");

  const mergeResult = await runCli([
    "pull",
    "--from-dir",
    backupDir,
    "--state-dir",
    localStateDir,
    "--strategy",
    "merge",
  ]);
  assert.equal(mergeResult.code, 0, mergeResult.stderr);
  assert.match(mergeResult.stdout, /- Conflicts:\s+0/);
});

test("push/pull with git backend and local bare remote", async () => {
  const stateDir = await mkTmpDir("git");
  const remoteBare = await mkTmpDir("git-remote");
  const repoDirPush = await mkTmpDir("git-repo-push");
  const repoDirPull = await mkTmpDir("git-repo-pull");
  const restoreDir = await mkTmpDir("git-restore");
  await writeStateFixture(stateDir);
  await execFileAsync("git", ["init", "--bare"], { cwd: remoteBare });

  const pushResult = await runCli([
    "push",
    "--state-dir",
    stateDir,
    "--to-git",
    "--repo-url",
    remoteBare,
    "--repo-dir",
    repoDirPush,
    "--branch",
    "main",
  ]);
  assert.equal(pushResult.code, 0, pushResult.stderr);
  assert.ok(existsSync(path.join(repoDirPush, "latest.txt")));

  const pullResult = await runCli([
    "pull",
    "--from-git",
    "--repo-url",
    remoteBare,
    "--repo-dir",
    repoDirPull,
    "--branch",
    "main",
    "--state-dir",
    restoreDir,
  ]);
  assert.equal(pullResult.code, 0, pullResult.stderr);
  assert.ok(existsSync(path.join(restoreDir, "openclaw.json")));
});

test("push/pull with S3 backend via local s3rver", async () => {
  const stateDir = await mkTmpDir("s3");
  const s3DataDir = await mkTmpDir("s3-data");
  const restoreDir = await mkTmpDir("s3-restore");
  await writeStateFixture(stateDir);

  const port = 4569;
  const endpoint = `http://127.0.0.1:${port}`;
  const bucket = "openclaw-bucket";
  const prefix = "sync";
  const s3rver = new S3rver({
    address: "127.0.0.1",
    port,
    directory: s3DataDir,
    silent: true,
    configureBuckets: [{ name: bucket }],
  });
  await s3rver.run();

  try {
    const env = {
      AWS_ACCESS_KEY_ID: "S3RVER",
      AWS_SECRET_ACCESS_KEY: "S3RVER",
      AWS_REGION: "us-east-1",
    };
    const pushResult = await runCli(
      [
        "push",
        "--state-dir",
        stateDir,
        "--to-s3",
        `s3://${bucket}/${prefix}`,
        "--s3-endpoint",
        endpoint,
      ],
      env,
    );
    assert.equal(pushResult.code, 0, pushResult.stderr);

    const pullResult = await runCli(
      [
        "pull",
        "--from-s3",
        `s3://${bucket}/${prefix}`,
        "--s3-endpoint",
        endpoint,
        "--state-dir",
        restoreDir,
      ],
      env,
    );
    assert.equal(pullResult.code, 0, pullResult.stderr);
    assert.ok(existsSync(path.join(restoreDir, "openclaw.json")));
  } finally {
    await s3rver.close();
  }
});

test("dry-run preview works and reuse-message-channel validates yes/no", async () => {
  const stateDir = await mkTmpDir("dry-run");
  const backupDir = await mkTmpDir("dry-run-backup");
  await writeStateFixture(stateDir);

  const dryRun = await runCli([
    "push",
    "--state-dir",
    stateDir,
    "--to-dir",
    backupDir,
    "--dry-run",
    "--reuse-message-channel",
    "yes",
  ]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /dry-run mode/);
  assert.match(dryRun.stdout, /target: dir/);
  assert.match(dryRun.stdout, /reuse message channel: yes/);

  const invalid = await runCli([
    "push",
    "--state-dir",
    stateDir,
    "--to-dir",
    backupDir,
    "--reuse-message-channel",
    "maybe",
  ]);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /Invalid value for --reuse-message-channel/);
});

test("schedule install/status/remove works with mocked crontab", async () => {
  const stateDir = await mkTmpDir("schedule");
  const backupDir = await mkTmpDir("schedule-backup");
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
      "--to-dir",
      backupDir,
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
