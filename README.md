# clawsync

Sync OpenClaw state with a Git-only backup workflow.

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
- `--include <list>`: comma-separated components to include
- `--exclude <list>`: comma-separated components to exclude
- `--ignore-paths <list>`: comma-separated relative paths to ignore
- `--workspace-include-globs <list>`: include extra workspace files/folders
- `--no-sanitize`: disable secret placeholder replacement

### `clawsync git init`

Initialize/update the local Git repo used by `clawsync push`.

- `--repo-url <url>` (required): remote Git URL for `origin`
- `--repo-dir <path>`: local repo path (default `~/.clawsync-repo`)
- `--branch <name>`: initial checkout branch (default `main`)

### `clawsync pack`

Create a `tar.gz` archive from selected state files.

- `--out <dir>`: output directory (if omitted, uses a temporary `/tmp/clawsync-*` directory)
- `--dry-run`: preview files/sanitization without writing archive

Note: `pack` does not write into `~/.clawsync-repo` unless you explicitly set `--out ~/.clawsync-repo/archives`.

### `clawsync push`

Pack then push to Git backend.

- `--repo-dir <path>`: local Git repo path
- `--branch <name>`: target branch
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

### `clawsync merge`

Same source options as `pull`, but always uses local-first merge behavior.

### `clawsync schedule install`

Install/update managed cron job for periodic `clawsync push`.

- `--every <interval>` (required): `30m`, `2h`, `1d`
- Git options: `--repo-dir`, `--branch`
- Also supports `--ignore-paths`, `--workspace-include-globs`, `--reuse-message-channel`

Run `clawsync git init --repo-url ...` before schedule install.

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

CLI flags override config values.

## Security Notes

- `credentials` and `.env` may contain secrets
- keep Git remotes private if syncing sensitive content
- prefer excluding `credentials` unless required
- keep `sanitize` enabled for automated backups
- generated env scripts contain plaintext secrets and should stay local
