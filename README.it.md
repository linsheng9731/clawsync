[English](README.md) | [中文](README.zh-CN.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [Italiano](README.it.md) | [Español](README.es.md)

# clawsync (Italiano)

Sincronizza lo stato di OpenClaw con un workflow Git-first, backup locali, migrazione e ripristino sicuro.

## Punti chiave

- **Workflow Git nativo completo**: comandi integrati `git init`, `push`, `pull`, `merge` (local-first).
- **Controllo granulare del backup**: `--include/--exclude`, `--ignore-paths`, `--workspace-include-globs`.
- **Pipeline di sanitizzazione segreti**: `sanitize` attivo di default, sostituzione con placeholder e script env per il recupero post-restore.
- **Strategie di restore più ricche**: `overwrite`, `skip`, `merge` con default di sicurezza (`--dry-run`, snapshot pre-restore, preservazione token gateway locale).

## Installazione

### Installazione one-click (GitHub Releases)

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash
```

Installare una versione specifica:

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash -s -- v0.1.1
```

Percorso predefinito: `~/.local/bin/clawsync` (override con `CLAWSYNC_INSTALL_DIR`).

### Installazione locale per sviluppo

```bash
npm install
npm run build
npm link
clawsync --help
```

## Workflow consigliato

1) Inizializza il backend Git:

```bash
clawsync git init --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo
```

2) Check opzionale del pacchetto:

```bash
clawsync pack --dry-run
clawsync pack
```

3) Push del backup:

```bash
clawsync push --repo-dir ~/.clawsync-repo
```

4) Pull e restore:

```bash
clawsync pull --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

5) Merge local-first:

```bash
clawsync merge --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

## Riferimento comandi

Tutti i comandi supportano `--help`:

```bash
clawsync <command> --help
```

### Opzioni globali (dove applicabili)

- `--version`
- `--state-dir <path>`
- `--config <path>`
- `--include <list>`
- `--exclude <list>`
- `--ignore-paths <list>`
- `--workspace-include-globs <list>`
- `--no-sanitize`

### `clawsync git init`

Inizializza/aggiorna il repository Git locale usato da `clawsync push`.

- `--repo-url <url>` (obbligatorio)
- `--repo-dir <path>` (default `~/.clawsync-repo`)
- `--branch <name>` (default `main`)

### `clawsync git prune-branches`

Rimuove i branch remoti `clawsync_YYYYMMDD` obsoleti oltre un numero di giorni specificato.

- `--repo-dir <path>`: percorso del repo locale
- `--repo-url <url>`: URL remoto (opzionale, usato se serve inizializzare il repo)
- `--keep-days <days>`: mantieni i branch degli ultimi N giorni (default `30`)
- `--dry-run`: solo anteprima, senza eliminazione
- `--yes`: richiesto per eliminare effettivamente i branch remoti

Esempio:

```bash
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --dry-run
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --yes
```

### `clawsync pack`

Crea un archivio `tar.gz` dai file di stato selezionati.

- `--out <dir>`
- `--dry-run`

### `clawsync profile full-migrate`

Crea un archivio di migrazione completa solo locale (senza push Git).

- include: `config,workspace,credentials,sessions,devices,identity,channels`
- `workspace/` incluso interamente di default
- output predefinito: `<state-dir>/migrations`
- `sanitize` disattivato di default (`--sanitize` per abilitarlo)
- supporta `--dry-run`

### `clawsync push`

Esegue pack e poi push al backend Git.

- `--repo-dir <path>`
- `--branch <name>`
- `--keep <count>`
- `--dry-run`
- `--reuse-message-channel <mode>`: `yes|no`

Branch predefinito: `clawsync_YYYYMMDD`.

### `clawsync pull`

Scarica da Git e ripristina nello stato locale.

- `--repo-url <url>`
- `--repo-dir <path>`
- `--branch <name>` (default `main`)
- `--state-dir <path>`
- `--strategy <mode>`: `overwrite|skip|merge`
- `--env-script-dir <path>`
- `--dry-run`
- `--yes`
- `--no-pre-snapshot`
- `--overwrite-gateway-token`

Dopo il restore (`unpack` / `pull` / `merge`):

- se mancano env sanitize, stampa il comando `source ".../env-export.sh"`
- se le env esistono già, avvia automaticamente la verifica post-restore (`openclaw gateway status` e reminder)

### `clawsync merge`

Stesse opzioni sorgente di `pull`, ma usa sempre merge local-first.

### `clawsync unpack`

Ripristino da archivio locale.

- `--from <path>` (obbligatorio)
- `--strategy <mode>`: `overwrite|skip|merge`
- `--dry-run`, `--yes`, `--no-pre-snapshot`, `--overwrite-gateway-token`
- `--env-script-dir <path>`

### `clawsync serve`

Espone archivi locali via HTTP con validazione token e web UI integrata.

- `--token <secret>` (obbligatorio)
- `--port <port>` (default `7373`)
- `--dir <path>` (default `<state-dir>/migrations`)
- `--state-dir <path>`
- `--strategy <mode>`
- `--env-script-dir <path>`
- `--overwrite-gateway-token`

Endpoint:

- `GET /health`
- `GET /`
- `GET /archives`
- `GET /download/<filename>`
- `POST /upload`
- `POST /backup`
- `POST /restore/<filename>?dry_run=1|confirm=1`

### `clawsync schedule install`

Installa/aggiorna un cron gestito per `clawsync push` periodico.

- `--every <interval>` (obbligatorio): `30m`, `2h`, `1d`
- opzioni Git: `--repo-dir`, `--branch`, `--keep`
- supporta anche `--ignore-paths`, `--workspace-include-globs`, `--reuse-message-channel`

## File di configurazione opzionale

Percorso predefinito: `~/.openclaw/clawsync.json`

```json
{
  "stateDir": "~/.openclaw",
  "include": ["config", "workspace"],
  "exclude": ["credentials", "sessions", "devices", "identity", "channels", "tools", "media"],
  "strategy": "overwrite",
  "sanitize": true
}
```

I flag CLI hanno precedenza sul file di configurazione.

## Note di sicurezza

- `credentials` e `.env` possono contenere segreti
- usa remote Git privati quando sincronizzi dati sensibili
- preferisci escludere `credentials` se non necessario
- mantieni `sanitize` attivo nei backup automatici
- gli script env generati contengono segreti in chiaro, quindi conservali solo in locale
