[English](README.md) | [中文](README.zh-CN.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [Italiano](README.it.md) | [Español](README.es.md)

# clawsync (Français)

Synchronisez l'état OpenClaw avec un workflow Git-first, plus la sauvegarde locale, la migration et la restauration sécurisée.

## Points forts

- **Workflow Git natif complet** : commandes `git init`, `push`, `pull` et `merge` (local-first) intégrées.
- **Contrôle fin du périmètre de backup** : `--include/--exclude`, `--ignore-paths`, `--workspace-include-globs`.
- **Pipeline de sanitization intégré** : `sanitize` activé par défaut, secrets remplacés par placeholders, scripts env générés pour la réhydratation.
- **Stratégies de restauration avancées** : `overwrite`, `skip`, `merge` + garde-fous (`--dry-run`, snapshot avant restauration, conservation du token gateway local).

## Installation

### Installation en une commande (GitHub Releases)

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash
```

Installer une version précise :

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash -s -- v0.1.1
```

Chemin par défaut : `~/.local/bin/clawsync` (modifiable via `CLAWSYNC_INSTALL_DIR`).

### Installation locale pour développement

```bash
npm install
npm run build
npm link
clawsync --help
```

## Workflow recommandé

1) Initialiser le backend Git :

```bash
clawsync git init --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo
```

2) Vérification facultative du pack :

```bash
clawsync pack --dry-run
clawsync pack
```

3) Pousser la sauvegarde :

```bash
clawsync push --repo-dir ~/.clawsync-repo
```

4) Pull puis restauration :

```bash
clawsync pull --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

5) Merge local-first :

```bash
clawsync merge --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

## Référence des commandes

Toutes les commandes acceptent `--help` :

```bash
clawsync <command> --help
```

### Options globales (selon la commande)

- `--version`
- `--state-dir <path>`
- `--config <path>`
- `--include <list>`
- `--exclude <list>`
- `--ignore-paths <list>`
- `--workspace-include-globs <list>`
- `--no-sanitize`

### `clawsync git init`

Initialise/met à jour le dépôt Git local utilisé par `clawsync push`.

- `--repo-url <url>` (obligatoire)
- `--repo-dir <path>` (défaut : `~/.clawsync-repo`)
- `--branch <name>` (défaut : `main`)

### `clawsync git prune-branches`

Supprime les anciennes branches distantes `clawsync_YYYYMMDD`.

- `--repo-dir <path>`
- `--repo-url <url>` (optionnel, si le repo doit être initialisé)
- `--keep-days <days>` : conserver les branches des N derniers jours (défaut : `30`)
- `--dry-run` : prévisualiser sans supprimer
- `--yes` : requis pour effectuer la suppression

Exemple :

```bash
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --dry-run
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --yes
```

### `clawsync pack`

Crée une archive `tar.gz` à partir des fichiers d'état sélectionnés.

- `--out <dir>`
- `--dry-run`

### `clawsync profile full-migrate`

Crée une archive complète de migration locale (sans push Git).

- inclut : `config,workspace,credentials,sessions,devices,identity,channels`
- `workspace/` inclus en entier par défaut
- sortie par défaut : `<state-dir>/migrations`
- `sanitize` désactivé par défaut (`--sanitize` pour l'activer)
- supporte `--dry-run`

### `clawsync push`

Pack puis push vers le backend Git.

- `--repo-dir <path>`
- `--branch <name>`
- `--keep <count>`
- `--dry-run`
- `--reuse-message-channel <mode>`: `yes|no`

Branche par défaut : `clawsync_YYYYMMDD`.

### `clawsync pull`

Récupère depuis Git puis restaure localement.

- `--repo-url <url>`
- `--repo-dir <path>`
- `--branch <name>` (défaut : `main`)
- `--state-dir <path>`
- `--strategy <mode>`: `overwrite|skip|merge`
- `--env-script-dir <path>`
- `--dry-run`
- `--yes`
- `--no-pre-snapshot`
- `--overwrite-gateway-token`

Après restauration (`unpack` / `pull` / `merge`) :

- si env manquant : affichage de `source ".../env-export.sh"`
- sinon : vérification post-restore automatique (`openclaw gateway status`, rappels de reconnexion)

### `clawsync merge`

Même source que `pull`, mais avec merge local-first.

### `clawsync unpack`

Restaure depuis une archive locale.

- `--from <path>` (obligatoire)
- `--strategy <mode>`: `overwrite|skip|merge`
- `--dry-run`, `--yes`, `--no-pre-snapshot`, `--overwrite-gateway-token`
- `--env-script-dir <path>`

### `clawsync serve`

Expose les archives locales via HTTP avec token et UI Web intégrée.

- `--token <secret>` (obligatoire)
- `--port <port>` (défaut : `7373`)
- `--dir <path>` (défaut : `<state-dir>/migrations`)
- `--state-dir <path>`
- `--strategy <mode>`
- `--env-script-dir <path>`
- `--overwrite-gateway-token`

Endpoints :

- `GET /health`
- `GET /`
- `GET /archives`
- `GET /download/<filename>`
- `POST /upload`
- `POST /backup`
- `POST /restore/<filename>?dry_run=1|confirm=1`

### `clawsync schedule install`

Installe/met à jour un cron managé pour `clawsync push`.

- `--every <interval>` (obligatoire) : `30m`, `2h`, `1d`
- options Git : `--repo-dir`, `--branch`, `--keep`
- aussi : `--ignore-paths`, `--workspace-include-globs`, `--reuse-message-channel`

## Fichier de configuration optionnel

Chemin par défaut : `~/.openclaw/clawsync.json`

```json
{
  "stateDir": "~/.openclaw",
  "include": ["config", "workspace"],
  "exclude": ["credentials", "sessions", "devices", "identity", "channels", "tools", "media"],
  "strategy": "overwrite",
  "sanitize": true
}
```

Les flags CLI ont priorité sur le fichier de config.

## Notes de sécurité

- `credentials` et `.env` peuvent contenir des secrets
- utilisez un remote Git privé pour du contenu sensible
- excluez `credentials` sauf nécessité
- gardez `sanitize` activé pour les sauvegardes automatiques
- les scripts env générés contiennent des secrets en clair : conservez-les localement
