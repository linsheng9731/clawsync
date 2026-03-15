[English](README.md) | [中文](README.zh-CN.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [Italiano](README.it.md) | [Español](README.es.md)

# clawsync (Español)

Sincroniza el estado de OpenClaw con un flujo Git-first, respaldo local, migración y restauración segura.

**Autor (X):** [@shngshngln86211](https://x.com/shngshngln86211)

## Características destacadas

- **Flujo Git nativo más completo**: incluye `git init`, `push`, `pull` y `merge` (local-first).
- **Control granular del alcance del backup**: `--include/--exclude`, `--ignore-paths`, `--workspace-include-globs`.
- **Pipeline de sanitización integrado**: `sanitize` activo por defecto, reemplazo de secretos con placeholders y scripts env de recuperación.
- **Estrategias de restauración más ricas**: `overwrite`, `skip`, `merge` con defaults de seguridad (`--dry-run`, snapshot previo, preservación del token gateway local).

## Instalación

### Instalación con un comando (GitHub Releases)

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash
```

Instalar una versión específica:

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash -s -- v0.1.1
```

Ruta por defecto: `~/.local/bin/clawsync` (se puede cambiar con `CLAWSYNC_INSTALL_DIR`).

### Instalación local para desarrollo

```bash
npm install
npm run build
npm link
clawsync --help
```

## Flujo recomendado

1) Inicializa el backend Git:

```bash
clawsync git init --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo
```

2) Revisión opcional del paquete:

```bash
clawsync pack --dry-run
clawsync pack
```

3) Push del backup:

```bash
clawsync push --repo-dir ~/.clawsync-repo
```

4) Pull y restauración:

```bash
clawsync pull --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

5) Merge local-first:

```bash
clawsync merge --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

## Referencia de comandos

Todos los comandos soportan `--help`:

```bash
clawsync <command> --help
```

### Opciones globales (donde aplique)

- `--version`
- `--state-dir <path>`
- `--config <path>`
- `--include <list>`
- `--exclude <list>`
- `--ignore-paths <list>`
- `--workspace-include-globs <list>`
- `--no-sanitize`

### `clawsync git init`

Inicializa/actualiza el repositorio Git local usado por `clawsync push`.

- `--repo-url <url>` (obligatorio)
- `--repo-dir <path>` (por defecto `~/.clawsync-repo`)
- `--branch <name>` (por defecto `main`)

### `clawsync git prune-branches`

Elimina las ramas remotas `clawsync_YYYYMMDD` antiguas más allá de un número de días.

- `--repo-dir <path>`: ruta del repo local
- `--repo-url <url>`: URL remoto (opcional, si hace falta inicializar el repo)
- `--keep-days <days>`: conservar ramas de los últimos N días (por defecto `30`)
- `--dry-run`: solo vista previa, sin eliminar
- `--yes`: requerido para eliminar realmente las ramas remotas

Ejemplo:

```bash
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --dry-run
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --yes
```

### `clawsync pack`

Crea un archivo `tar.gz` desde los archivos de estado seleccionados.

- `--out <dir>`
- `--dry-run`

### `clawsync profile full-migrate`

Crea un archivo de migración completa solo local (sin push a Git).

- incluye: `config,workspace,credentials,sessions,devices,identity,channels`
- `workspace/` se incluye completo por defecto
- salida por defecto: `<state-dir>/migrations`
- `sanitize` desactivado por defecto (`--sanitize` para activar)
- soporta `--dry-run`

### `clawsync push`

Empaqueta y luego hace push al backend Git.

- `--repo-dir <path>`
- `--branch <name>`
- `--keep <count>`
- `--dry-run`
- `--reuse-message-channel <mode>`: `yes|no`

Si no se especifica rama, usa `clawsync_YYYYMMDD`.

### `clawsync pull`

Trae desde Git y restaura al estado local.

- `--repo-url <url>`
- `--repo-dir <path>`
- `--branch <name>` (por defecto `main`)
- `--state-dir <path>`
- `--strategy <mode>`: `overwrite|skip|merge`
- `--env-script-dir <path>`
- `--dry-run`
- `--yes`
- `--no-pre-snapshot`
- `--overwrite-gateway-token`

Después de restaurar (`unpack` / `pull` / `merge`):

- si faltan variables env sanitizadas, muestra el comando exacto `source ".../env-export.sh"`
- si ya existen, ejecuta verificación post-restore automáticamente (`openclaw gateway status` y recordatorios)

### `clawsync merge`

Mismas opciones de origen que `pull`, pero siempre con merge local-first.

### `clawsync unpack`

Restaura desde un archivo local.

- `--from <path>` (obligatorio)
- `--strategy <mode>`: `overwrite|skip|merge`
- `--dry-run`, `--yes`, `--no-pre-snapshot`, `--overwrite-gateway-token`
- `--env-script-dir <path>`

### `clawsync serve`

Sirve archivos locales por HTTP con validación por token y web UI integrada.

- `--token <secret>` (obligatorio)
- `--port <port>` (por defecto `7373`)
- `--dir <path>` (por defecto `<state-dir>/migrations`)
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

Instala/actualiza un cron gestionado para ejecutar `clawsync push` periódicamente.

- `--every <interval>` (obligatorio): `30m`, `2h`, `1d`
- opciones Git: `--repo-dir`, `--branch`, `--keep`
- también soporta `--ignore-paths`, `--workspace-include-globs`, `--reuse-message-channel`

## Archivo de configuración opcional

Ruta por defecto: `~/.openclaw/clawsync.json`

```json
{
  "stateDir": "~/.openclaw",
  "include": ["config", "workspace"],
  "exclude": ["credentials", "sessions", "devices", "identity", "channels", "tools", "media"],
  "strategy": "overwrite",
  "sanitize": true
}
```

Las flags CLI tienen prioridad sobre el archivo de configuración.

## Notas de seguridad

- `credentials` y `.env` pueden contener secretos
- usa remotos Git privados para contenido sensible
- excluye `credentials` salvo que sea necesario
- mantén `sanitize` activado en backups automatizados
- los scripts env generados contienen secretos en texto plano; mantenlos solo en local
