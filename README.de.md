[English](README.md) | [中文](README.zh-CN.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [Italiano](README.it.md) | [Español](README.es.md)

# clawsync (Deutsch)

Synchronisiere den OpenClaw-Status mit einem Git-first-Workflow inklusive lokalem Backup, Migration und sicherem Restore.

## Highlights

- **Vollständiger Git-nativer Ablauf**: integrierte Befehle `git init`, `push`, `pull`, `merge` (local-first).
- **Feingranulare Backup-Steuerung**: `--include/--exclude`, `--ignore-paths`, `--workspace-include-globs`.
- **Integrierte Secret-Sanitization**: `sanitize` ist standardmäßig aktiv, ersetzt Secrets durch Platzhalter und erzeugt Env-Recovery-Skripte.
- **Flexible Restore-Strategien**: `overwrite`, `skip`, `merge` plus Sicherheitsdefaults (`--dry-run`, Pre-Restore-Snapshot, lokales Gateway-Token beibehalten).

## Installation

### Ein-Klick-Installation (GitHub Releases)

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash
```

Spezifische Version installieren:

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash -s -- v0.1.1
```

Standardpfad: `~/.local/bin/clawsync` (überschreibbar via `CLAWSYNC_INSTALL_DIR`).

### Lokale Dev-Installation

```bash
npm install
npm run build
npm link
clawsync --help
```

## Empfohlener Workflow

1) Git-Backend initialisieren:

```bash
clawsync git init --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo
```

2) Optionales Pack-Preview:

```bash
clawsync pack --dry-run
clawsync pack
```

3) Backup pushen:

```bash
clawsync push --repo-dir ~/.clawsync-repo
```

4) Pull und Restore:

```bash
clawsync pull --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

5) Local-first Merge:

```bash
clawsync merge --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

## Befehlsreferenz

Alle Befehle unterstützen `--help`:

```bash
clawsync <command> --help
```

### Globale Optionen (je nach Befehl)

- `--version`
- `--state-dir <path>`
- `--config <path>`
- `--include <list>`
- `--exclude <list>`
- `--ignore-paths <list>`
- `--workspace-include-globs <list>`
- `--no-sanitize`

### `clawsync git init`

Initialisiert/aktualisiert das lokale Git-Repo für `clawsync push`.

- `--repo-url <url>` (erforderlich)
- `--repo-dir <path>` (Default: `~/.clawsync-repo`)
- `--branch <name>` (Default: `main`)

### `clawsync git prune-branches`

Entfernt alte Remote-Backup-Branches vom Typ `clawsync_YYYYMMDD`.

- `--repo-dir <path>`
- `--repo-url <url>` (optional, falls Repo initialisiert werden muss)
- `--keep-days <days>`: Branches der letzten N Tage behalten (Default: `30`)
- `--dry-run`: Vorschau ohne Löschen
- `--yes`: erforderlich für tatsächliches Löschen

Beispiel:

```bash
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --dry-run
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --yes
```

### `clawsync pack`

Erstellt ein `tar.gz` aus ausgewählten State-Dateien.

- `--out <dir>`
- `--dry-run`

### `clawsync profile full-migrate`

Erstellt ein vollständiges, lokales Migrationsarchiv (kein Git-Push).

- enthält: `config,workspace,credentials,sessions,devices,identity,channels`
- `workspace/` standardmäßig vollständig
- Standardausgabe: `<state-dir>/migrations`
- `sanitize` standardmäßig aus (`--sanitize` zum Aktivieren)
- unterstützt `--dry-run`

### `clawsync push`

Packt und pusht zum Git-Backend.

- `--repo-dir <path>`
- `--branch <name>`
- `--keep <count>`
- `--dry-run`
- `--reuse-message-channel <mode>`: `yes|no`

Standardbranch: `clawsync_YYYYMMDD`.

### `clawsync pull`

Lädt aus Git und stellt lokal wieder her.

- `--repo-url <url>`
- `--repo-dir <path>`
- `--branch <name>` (Default: `main`)
- `--state-dir <path>`
- `--strategy <mode>`: `overwrite|skip|merge`
- `--env-script-dir <path>`
- `--dry-run`
- `--yes`
- `--no-pre-snapshot`
- `--overwrite-gateway-token`

Nach Restore (`unpack` / `pull` / `merge`):

- bei fehlenden Env-Variablen: Ausgabe von `source ".../env-export.sh"`
- sonst automatische Post-Restore-Prüfung (`openclaw gateway status`, Reconnect-Hinweise)

### `clawsync merge`

Gleiche Source-Optionen wie `pull`, aber immer local-first merge.

### `clawsync unpack`

Restore aus lokalem Archiv.

- `--from <path>` (erforderlich)
- `--strategy <mode>`: `overwrite|skip|merge`
- `--dry-run`, `--yes`, `--no-pre-snapshot`, `--overwrite-gateway-token`
- `--env-script-dir <path>`

### `clawsync serve`

Stellt lokale Archive via HTTP mit Token-Validierung und eingebauter Web-UI bereit.

- `--token <secret>` (erforderlich)
- `--port <port>` (Default: `7373`)
- `--dir <path>` (Default: `<state-dir>/migrations`)
- `--state-dir <path>`
- `--strategy <mode>`
- `--env-script-dir <path>`
- `--overwrite-gateway-token`

Endpoints:

- `GET /health`
- `GET /`
- `GET /archives`
- `GET /download/<filename>`
- `POST /upload`
- `POST /backup`
- `POST /restore/<filename>?dry_run=1|confirm=1`

### `clawsync schedule install`

Installiert/aktualisiert einen verwalteten Cron-Job für periodisches `clawsync push`.

- `--every <interval>` (erforderlich): `30m`, `2h`, `1d`
- Git-Optionen: `--repo-dir`, `--branch`, `--keep`
- zusätzlich: `--ignore-paths`, `--workspace-include-globs`, `--reuse-message-channel`

## Optionale Konfigurationsdatei

Default-Pfad: `~/.openclaw/clawsync.json`

```json
{
  "stateDir": "~/.openclaw",
  "include": ["config", "workspace"],
  "exclude": ["credentials", "sessions", "devices", "identity", "channels", "tools", "media"],
  "strategy": "overwrite",
  "sanitize": true
}
```

CLI-Flags überschreiben Konfigurationswerte.

## Sicherheitshinweise

- `credentials` und `.env` können Secrets enthalten
- bei sensiblen Daten nur private Git-Remotes verwenden
- `credentials` nach Möglichkeit ausschließen
- `sanitize` für automatisierte Backups aktiv lassen
- generierte Env-Skripte enthalten Klartext-Secrets und sollten lokal bleiben
