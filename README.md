# clawsync

Sync OpenClaw state across machines through local directory, S3-compatible object storage, or Git repository backends.

## Installation

```bash
npm install
npm run build
npm link
clawsync --help
```

## Features

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

Use:

```bash
clawsync scope
clawsync scope --include config,workspace,sessions --exclude credentials
```

### 2) Archive pack/unpack

Create and restore `tar.gz` sync archives:

```bash
clawsync pack --out ./backup
clawsync unpack --from ./backup/clawsync-xxx.tar.gz
clawsync unpack --from ./backup/clawsync-xxx.tar.gz --strategy skip
clawsync unpack --from ./backup/clawsync-xxx.tar.gz --strategy merge
```

### 3) Multi-backend push/pull

#### Directory backend

```bash
clawsync push --to-dir ./backup
clawsync pull --from-dir ./backup
clawsync pull --from-dir ./backup --strategy merge
clawsync merge --from-dir ./backup
```

#### S3 backend

```bash
clawsync push --to-s3 s3://my-bucket/openclaw
clawsync pull --from-s3 s3://my-bucket/openclaw
```

Custom S3 endpoint is supported:

```bash
clawsync push --to-s3 s3://my-bucket/openclaw --s3-endpoint http://127.0.0.1:9000
```

#### Git backend

```bash
clawsync push --to-git --repo-url git@github.com:you/clawsync-backup.git --branch main
clawsync pull --from-git --repo-url git@github.com:you/clawsync-backup.git --branch main
clawsync merge --from-git --repo-url git@github.com:you/clawsync-backup.git --branch main
```

Optional local repo cache path:

```bash
clawsync push --to-git --repo-dir ~/.clawsync-repo
```

### 4) Sanitization and secret recovery scripts

By default, archives are sanitized:

- sensitive values are replaced by `${CLAWSYNC_*}`
- original values are stored in `secrets.json`
- after `pull`/`unpack`, environment scripts are generated:
  - `env-export.sh`
  - `env-export.ps1`
  - `env-export.cmd`

Disable sanitization only when you intentionally need raw values:

```bash
clawsync pack --no-sanitize --out ./backup
```

### 5) Local-first merge and conflict report

`merge` strategy keeps local files when conflicts happen, and only adds missing files from backup.

Use one of these:

```bash
clawsync pull --from-dir ./backup --strategy merge
clawsync merge --from-dir ./backup
```

Merge output includes a conflict report with per-file details:

- total files scanned
- merged new files
- kept local files
- conflict count
- conflict details with `path` and `reason`

### 6) Dry-run preview

Preview behavior without writing archives or uploading:

```bash
clawsync pack --dry-run
clawsync push --to-git --repo-url git@github.com:you/clawsync-backup.git --dry-run
```

### 7) Managed scheduled backup (cron)

Install/update managed cron entry:

```bash
clawsync schedule install --every 1d --to-dir ./backup
clawsync schedule install --every 2h --to-s3 s3://my-bucket/openclaw
clawsync schedule install --every 1d --to-git --repo-url git@github.com:you/clawsync-backup.git --branch main
```

Manage schedule:

```bash
clawsync schedule status
clawsync schedule remove
```

Notes:

- interval supports `m` / `h` / `d` (`30m`, `2h`, `1d`)
- cron logs are written to `~/.openclaw/logs/sync-cron.log` (or under `--state-dir`)
- install is idempotent and replaces existing managed entry

## Optional config file

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

## End-to-end tests (feature-oriented)

E2E suite path: `tests/e2e/cli.e2e.test.mjs`

Run:

```bash
npm test
```

### Coverage matrix

- `scope`: default component selection and resolved paths
- `pack` + `unpack`: archive generation, restore, sanitize placeholders, env-export scripts
- `push/pull --to-dir/--from-dir`: full round trip through directory backend
- `push/pull --to-git/--from-git`: full round trip using local bare remote repository
- `push/pull --to-s3/--from-s3`: full round trip using embedded local S3 server (`s3rver`)
- `push --dry-run`: preview output, target summary, and `--reuse-message-channel yes|no` validation
- `schedule install/status/remove`: full lifecycle using mocked `crontab` command to avoid touching host cron

### Test design principles

- feature-first: each case maps to user-visible capability
- real CLI execution: tests call built `dist/cli.js` as subprocess
- isolated environment: each test uses temporary directories and disposable backends
- no host side effects: cron tests replace `crontab` with a test shim

## Security notes

- `credentials` and `.env` may contain secrets
- keep git remotes private if syncing sensitive content
- prefer excluding `credentials` unless required
- keep `sanitize` enabled for automated backups
- generated env scripts contain plaintext secrets and must stay local
