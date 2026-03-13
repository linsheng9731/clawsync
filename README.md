# clawsync

Sync OpenClaw state across machines through local directory, S3-compatible object storage, or Git repository backends.

## Installation

### One-click install (GitHub Releases)

Install latest:

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash
```

Install a specific version:

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash -s -- v0.1.1
```

Default install path is `~/.local/bin/clawsync`. You can override it with `CLAWSYNC_INSTALL_DIR`.

### Local development install

```bash
npm install
npm run build
npm link
clawsync --help
```

## Usage Workflow

### 1) One-time initialization

```bash
clawsync git init --repo-url git@github.com:linsheng9731/openclaw-backup.git --repo-dir ~/.clawsync-repo
```

### 2) Package check (optional but recommended)

```bash
clawsync pack --dry-run
clawsync pack
```

### 3) Push backup

```bash
clawsync push --to-git --repo-dir ~/.clawsync-repo
```

### 4) Pull and restore

```bash
clawsync pull --from-git --repo-url git@github.com:linsheng9731/openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

### 5) Local-first merge

```bash
clawsync merge --from-git --repo-url git@github.com:linsheng9731/openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

## Command Reference

All commands support `--help` for full options:

```bash
clawsync <command> --help
```

### Global options (where applicable)

- `--version`: print current clawsync version
- `--state-dir <path>`: OpenClaw state directory (default `~/.openclaw` or `OPENCLAW_STATE_DIR`)
- `--config <path>`: custom config file path
- `--include <list>`: comma-separated components to include
- `--exclude <list>`: comma-separated components to exclude
- `--ignore-paths <list>`: comma-separated relative paths to ignore (files or directories)
- `--workspace-include-globs <list>`: wildcard rules to include non-config files/folders under `workspace/`
- `--no-sanitize`: disable secret placeholder replacement

### `clawsync version`

Prints version information.

- `-v, --verbose`: include runtime details (Node.js and platform)

### `clawsync git init`

Initializes or updates the local Git repo used by `clawsync push --to-git`.

- `--repo-url <url>` (required): remote Git URL to set as `origin`
- `--repo-dir <path>`: local Git repo path (default `~/.clawsync-repo`)
- `--branch <name>`: initial checkout branch for local repo setup (default `main`)

```bash
clawsync git init --repo-url git@github.com:you/clawsync-backup.git
clawsync git init --repo-url git@github.com:you/clawsync-backup.git --repo-dir ~/.clawsync-repo
```

### `clawsync scope`

Prints the final selected scope (state dir, include/exclude, and resolved file paths) without creating or modifying any backup.

```bash
clawsync scope
clawsync scope --include config,workspace,sessions --exclude credentials
```

### `clawsync pack`

Creates a `tar.gz` archive from selected state files.

- `--out <dir>`: output directory for the generated archive
- `--dry-run`: preview selected files and sanitization result without writing archive
- scans file sizes before packing and prints progress/summary plus largest items
- in interactive terminal, you can choose large items to ignore for current run
- by default, under `workspace/` only `memory/`, `skills/`, and `config/` are included
- use `--workspace-include-globs` to include other workspace files/folders

```bash
clawsync pack --out ./backup
clawsync pack --dry-run
```

### `clawsync unpack`

Restores an archive to a state directory.

- `--from <path>` (required): source archive path
- `--strategy <mode>`: restore strategy (`overwrite` | `skip` | `merge`)
- `--env-script-dir <path>`: output directory for generated env recovery scripts

```bash
clawsync unpack --from ./backup/clawsync-xxx.tar.gz
clawsync unpack --from ./backup/clawsync-xxx.tar.gz --strategy merge
```

### `clawsync push`

Packs state, then uploads/publishes archive to one backend target.

- `--to-dir <path>`: directory backend target
- `--to-s3 <s3Uri>`: S3 backend target
- `--to-git`: Git backend target
- `--dry-run`: preview files/sanitization/target without writing or uploading
- `--reuse-message-channel <mode>`: OpenClaw message channel behavior (`yes` | `no`)
- backend-specific:
  - S3: `--s3-endpoint <url>`
  - Git: `--repo-dir <path>`, `--branch <name>`
  - Git default branch: `clawsync_YYYYMMDD` (for example `clawsync_20260313`)

```bash
clawsync push --to-dir ./backup
clawsync push --to-s3 s3://my-bucket/openclaw --s3-endpoint http://127.0.0.1:9000
clawsync push --to-git --repo-dir ~/.clawsync-repo
```

### `clawsync pull`

Downloads an archive from a backend source, then restores it to local state.

- source options (choose one): `--from-dir`, `--from-s3`, `--from-git`
- restore options: `--state-dir`, `--strategy <overwrite|skip|merge>`, `--env-script-dir`
- backend-specific:
  - S3: `--s3-endpoint <url>`
  - Git: `--repo-dir <path>`, `--repo-url <url>`, `--branch <name>`

```bash
clawsync pull --from-dir ./backup
clawsync pull --from-s3 s3://my-bucket/openclaw
clawsync pull --from-git --repo-url git@github.com:you/clawsync-backup.git --branch main
```

### `clawsync merge`

Same source options as `pull`, but always uses local-first merge behavior (keeps local files on conflicts and only adds missing files from backup).

```bash
clawsync merge --from-dir ./backup
clawsync merge --from-git --repo-url git@github.com:you/clawsync-backup.git --branch main
```

### `clawsync schedule install`

Installs or updates a managed cron job that periodically runs `clawsync push`.

- `--every <interval>` (required): interval format (`30m`, `2h`, `1d`)
- push target and options: same as `clawsync push` target/backend flags
- `--ignore-paths`: persisted ignored paths for scheduled sync
- `--workspace-include-globs`: persisted workspace include rules for scheduled sync
- when using `--to-git`, run `clawsync git init --repo-url ...` first

```bash
clawsync schedule install --every 1d --to-dir ./backup
clawsync schedule install --every 2h --to-s3 s3://my-bucket/openclaw
clawsync schedule install --every 1d --to-git --repo-dir ~/.clawsync-repo
```

### `clawsync schedule status`

Shows whether managed cron schedule is installed, and prints cron expression/command when present.

```bash
clawsync schedule status
```

### `clawsync schedule remove`

Removes the managed cron schedule entry created by `clawsync schedule install`.

```bash
clawsync schedule remove
```

## Feature Overview

### 1) Scope-based state selection

Sync is component-based:

- `config`: `openclaw.json`, `.env`
- `workspace`: `workspace/`
- `credentials`: `credentials/`
- `sessions`: `sessions/`, `agents/`
- `tools`: `tools/`
- `media`: `media/`

Default behavior:

- include: `config,workspace`
- exclude: `credentials,sessions,tools,media`

### 2) Archive pack/unpack

Create and restore `tar.gz` sync archives with `pack` and `unpack`.

### 3) Multi-backend push/pull

Supports directory, S3-compatible storage, and Git repository backends.

### 4) Sanitization and env recovery scripts

By default, archives are sanitized:

- sensitive values are replaced by `${CLAWSYNC_*}`
- original values are stored in `secrets.json`
- after `pull`/`unpack`, env scripts are generated:
  - `env-export.sh`
  - `env-export.ps1`
  - `env-export.cmd`

### 5) Local-first merge and conflict report

`merge` keeps local files when conflicts happen and only adds missing files from backup, with per-file conflict details.

### 6) Dry-run preview

Preview behavior without writing archives or uploading:

```bash
clawsync pack --dry-run
clawsync push --to-git --repo-dir ~/.clawsync-repo --dry-run
```

### 7) Managed scheduled backup (cron)

Install/update/check/remove managed cron entries through `clawsync schedule`.

## Optional Config File

Default config path: `~/.openclaw/clawsync.json`

```json
{
  "stateDir": "~/.openclaw",
  "include": ["config", "workspace"],
  "exclude": ["credentials", "sessions", "tools", "media"],
  "strategy": "overwrite",
  "sanitize": true
}
```

CLI flags override config file values.

## End-to-End Tests

E2E suite path: `tests/e2e/cli.e2e.test.mjs`

Run:

```bash
npm test
```

Coverage includes scope selection, archive pack/unpack, directory/S3/Git backend round trips, dry-run behavior, and schedule lifecycle.

## Security Notes

- `credentials` and `.env` may contain secrets
- keep Git remotes private if syncing sensitive content
- prefer excluding `credentials` unless required
- keep `sanitize` enabled for automated backups
- generated env scripts contain plaintext secrets and should stay local
