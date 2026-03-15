[English](README.md) | [中文](README.zh-CN.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [Italiano](README.it.md) | [Español](README.es.md)

# clawsync

Sync OpenClaw state with a Git-only backup workflow.

**Author (X):** [@shngshngln86211](https://x.com/shngshngln86211)

## Feature Highlights

- **More complete Git-native workflow**: built-in `git init`, `push`, `pull`, and local-first `merge`, with branch-based backup/restore flow for traceable sync history.
- **Fine-grained backup scope control**: choose components with `--include/--exclude`, skip paths with `--ignore-paths`, and include extra workspace files with `--workspace-include-globs`.
- **Built-in sensitive data sanitization pipeline**: `sanitize` is enabled by default, replaces secrets with placeholders, and emits env recovery scripts for post-restore rehydration.
- **Richer restore strategies**: support `overwrite`, `skip`, and `merge` modes, plus restore safety defaults (`--dry-run`, pre-restore snapshot, local gateway token preservation).

## Installation

### One-click install (GitHub Releases)

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash
```

Install a specific version:

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash -s -- v0.1.1
```

Default install path: `~/.local/bin/clawsync` (override with `CLAWSYNC_INSTALL_DIR`).

### Local development install

```bash
npm install
npm run build
npm link
clawsync --help
```

## Recommended Workflow

1) Initialize Git backend once:

```bash
clawsync git init --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo
```

2) Optional package check:

```bash
clawsync pack --dry-run
clawsync pack
```

3) Push backup:

```bash
clawsync push --repo-dir ~/.clawsync-repo
```

4) Pull and restore:

```bash
clawsync pull --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

5) Local-first merge:

```bash
clawsync merge --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

## Command Reference

All commands support `--help`:

```bash
clawsync <command> --help
```

### Global options (where applicable)

- `--version`: print current clawsync version
- `--state-dir <path>`: OpenClaw state directory (default `~/.openclaw` or `OPENCLAW_STATE_DIR`)
- `--config <path>`: custom config file path
- `--include <list>`: comma-separated components to include (`config,workspace,credentials,sessions,devices,identity,channels,tools,media`)
- `--exclude <list>`: comma-separated components to exclude
- `--ignore-paths <list>`: comma-separated relative paths to ignore
- `--workspace-include-globs <list>`: include extra workspace files/folders
- `--no-sanitize`: disable secret placeholder replacement

### `clawsync git init`

Initialize/update the local Git repo used by `clawsync push`.

- `--repo-url <url>` (required): remote Git URL for `origin`
- `--repo-dir <path>`: local repo path (default `~/.clawsync-repo`)
- `--branch <name>`: initial checkout branch (default `main`)

### `clawsync git prune-branches`

Prune old remote backup branches that match `clawsync_YYYYMMDD`.

- `--repo-dir <path>`: local git repo path
- `--repo-url <url>`: remote URL (optional, used when repo needs initialization)
- `--keep-days <days>`: keep branches within latest N days (default `30`)
- `--dry-run`: preview candidates without deletion
- `--yes`: required to actually delete remote branches

Example:

```bash
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --dry-run
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --yes
```

### `clawsync pack`

Create a `tar.gz` archive from selected state files.

- `--out <dir>`: output directory (if omitted, uses a temporary `/tmp/clawsync-*` directory)
- `--dry-run`: preview files/sanitization without writing archive

Note: `pack` does not write into `~/.clawsync-repo` unless you explicitly set `--out ~/.clawsync-repo/archives`.
Output note: file/path previews are condensed to top 3 levels and capped to 10 lines.

### `clawsync profile full-migrate`

Create a local-only full migration archive (does not push to Git).

- includes: `config,workspace,credentials,sessions,devices,identity,channels`
- workspace scope: includes full `workspace/` content by default (including business/project files)
- default output: `<state-dir>/migrations`
- defaults to `sanitize: off` (use `--sanitize` to enable)
- supports `--dry-run`

### `clawsync push`

Pack then push to Git backend.

- `--repo-dir <path>`: local Git repo path
- `--branch <name>`: target branch
- `--keep <count>`: keep latest N archives in git repo after push (archive retention)
- `--dry-run`: preview push target and selection
- `--reuse-message-channel <mode>`: `yes|no`

Default branch when omitted: `clawsync_YYYYMMDD` (example: `clawsync_20260313`).

### `clawsync pull`

Pull from Git then unpack to local state.

- `--repo-url <url>`: remote Git URL (optional if `origin` already set in `repo-dir`)
- `--repo-dir <path>`: local Git repo path
- `--branch <name>`: source branch (default `main`)
- `--state-dir <path>`: target state dir
- `--strategy <mode>`: `overwrite|skip|merge`
- `--env-script-dir <path>`: output path for env recovery scripts
- `--dry-run`: preview restore plan, no write
- `--yes`: skip interactive high-risk confirmation
- `--no-pre-snapshot`: disable automatic pre-restore snapshot
- `--overwrite-gateway-token`: use backup token instead of preserving local token

After restore (`unpack`/`pull`/`merge`):

- if sanitized env vars are missing in current shell, CLI prints the exact `source ".../env-export.sh"` command
- if required env vars already exist, CLI auto-runs post-restore verification:
  - `openclaw gateway status`
  - channel reconnect reminder
  - Telegram `/start` reminder when needed

### `clawsync merge`

Same source options as `pull`, but always uses local-first merge behavior.

Restore safety defaults for `unpack`/`pull`/`merge`:

- high-risk restore prompts confirmation
- recommends `--dry-run` first
- creates pre-restore snapshot in `/tmp` by default
- preserves local `gateway.auth.token` by default

### `clawsync unpack`

Restore from a local archive with the same safety flags as `pull`:

- `--from <path>` (required): local archive path
- `--strategy <mode>`: `overwrite|skip|merge`
- `--dry-run`, `--yes`, `--no-pre-snapshot`, `--overwrite-gateway-token`
- `--env-script-dir <path>`

### `clawsync serve`

Serve local archives via HTTP with token validation and a built-in web UI.

- `--token <secret>` (required): access token
- `--port <port>`: server port (default `7373`)
- `--dir <path>`: archive directory to serve (default `<state-dir>/migrations`)
- `--state-dir <path>`: used when `--dir` is omitted
- `--strategy <mode>`: default restore mode for `/restore` (`overwrite|skip|merge`)
- `--env-script-dir <path>`: output path for env recovery scripts after restore
- `--overwrite-gateway-token`: use backup token instead of preserving local token during `/restore`
- also supports the same pack-scope flags as `pack/push` (`--include`, `--exclude`, `--ignore-paths`, etc.) for `/backup`

Endpoints:

- `GET /health`: health check (no token)
- `GET /`: simple web UI (token required)
- `GET /archives`: list archives (token required)
- `GET /download/<filename>`: download archive (token required)
- `POST /upload`: upload archive (token required)
- `POST /backup`: create archive (token required, localhost-only)
- `POST /restore/<filename>?dry_run=1|confirm=1`: restore archive (token required, localhost-only)

Example:

```bash
clawsync serve --token "your-secret-token" --port 7373
curl "http://127.0.0.1:7373/archives?token=your-secret-token"
```

### `clawsync schedule install`

Install/update managed cron job for periodic `clawsync push`.

- `--every <interval>` (required): `30m`, `2h`, `1d`
- Git options: `--repo-dir`, `--branch`, `--keep`
- Also supports `--ignore-paths`, `--workspace-include-globs`, `--reuse-message-channel`

Run `clawsync git init --repo-url ...` before schedule install.

## Optional Config File

Default config path: `~/.openclaw/clawsync.json`

```json
{
  "stateDir": "~/.openclaw",
  "include": ["config", "workspace"],
  "exclude": ["credentials", "sessions", "devices", "identity", "channels", "tools", "media"],
  "strategy": "overwrite",
  "sanitize": true
}
```

CLI flags override config values.

## Security Notes

- `credentials` and `.env` may contain secrets
- keep Git remotes private if syncing sensitive content
- prefer excluding `credentials` unless required
- keep `sanitize` enabled for automated backups
- generated env scripts contain plaintext secrets and should stay local
