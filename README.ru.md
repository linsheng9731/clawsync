[English](README.md) | [中文](README.zh-CN.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [Italiano](README.it.md) | [Español](README.es.md)

# clawsync (Русский)

Синхронизируйте состояние OpenClaw через Git-first workflow: локальные архивы, миграция и безопасное восстановление.

**Автор (X):** [@shngshngln86211](https://x.com/shngshngln86211)

## Ключевые возможности

- **Полноценный Git-native поток**: встроены `git init`, `push`, `pull` и local-first `merge`.
- **Точная настройка области бэкапа**: `--include/--exclude`, `--ignore-paths`, `--workspace-include-globs`.
- **Встроенная sanitization секретов**: `sanitize` включен по умолчанию, секреты заменяются плейсхолдерами, после восстановления можно сгенерировать env-скрипты.
- **Гибкие стратегии восстановления**: `overwrite`, `skip`, `merge` + безопасные defaults (`--dry-run`, snapshot до восстановления, сохранение локального gateway token).

## Установка

### Установка в одну команду (GitHub Releases)

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash
```

Установка конкретной версии:

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash -s -- v0.1.1
```

Путь по умолчанию: `~/.local/bin/clawsync` (можно изменить через `CLAWSYNC_INSTALL_DIR`).

### Локальная установка для разработки

```bash
npm install
npm run build
npm link
clawsync --help
```

## Рекомендуемый workflow

1) Инициализируйте Git backend:

```bash
clawsync git init --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo
```

2) Опционально проверьте pack:

```bash
clawsync pack --dry-run
clawsync pack
```

3) Выполните push бэкапа:

```bash
clawsync push --repo-dir ~/.clawsync-repo
```

4) Pull и восстановление:

```bash
clawsync pull --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

5) Local-first merge:

```bash
clawsync merge --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

## Справочник команд

Для всех команд доступен `--help`:

```bash
clawsync <command> --help
```

### Глобальные опции (где применимо)

- `--version`
- `--state-dir <path>`
- `--config <path>`
- `--include <list>`
- `--exclude <list>`
- `--ignore-paths <list>`
- `--workspace-include-globs <list>`
- `--no-sanitize`

### `clawsync git init`

Инициализирует/обновляет локальный Git-репозиторий для `clawsync push`.

- `--repo-url <url>` (обязательно)
- `--repo-dir <path>` (по умолчанию `~/.clawsync-repo`)
- `--branch <name>` (по умолчанию `main`)

### `clawsync git prune-branches`

Удаляет старые удаленные ветки `clawsync_YYYYMMDD` старше заданного количества дней.

- `--repo-dir <path>`: путь к локальному репозиторию
- `--repo-url <url>`: удаленный URL (опционально при необходимости инициализации)
- `--keep-days <days>`: сохранять ветки за последние N дней (по умолчанию `30`)
- `--dry-run`: только предпросмотр без удаления
- `--yes`: требуется для фактического удаления удаленных веток

Пример:

```bash
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --dry-run
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --yes
```

### `clawsync pack`

Создает `tar.gz` архив из выбранных файлов состояния.

- `--out <dir>`
- `--dry-run`

### `clawsync profile full-migrate`

Создает полный локальный миграционный архив (без push в Git).

- включает: `config,workspace,credentials,sessions,devices,identity,channels`
- `workspace/` включается полностью по умолчанию
- путь по умолчанию: `<state-dir>/migrations`
- по умолчанию `sanitize` выключен (`--sanitize` для включения)
- поддерживает `--dry-run`

### `clawsync push`

Делает pack и затем push в Git backend.

- `--repo-dir <path>`
- `--branch <name>`
- `--keep <count>`
- `--dry-run`
- `--reuse-message-channel <mode>`: `yes|no`

Если branch не указан, используется `clawsync_YYYYMMDD`.

### `clawsync pull`

Забирает данные из Git и распаковывает в локальный state.

- `--repo-url <url>`
- `--repo-dir <path>`
- `--branch <name>` (по умолчанию `main`)
- `--state-dir <path>`
- `--strategy <mode>`: `overwrite|skip|merge`
- `--env-script-dir <path>`
- `--dry-run`
- `--yes`
- `--no-pre-snapshot`
- `--overwrite-gateway-token`

После восстановления (`unpack` / `pull` / `merge`):

- при отсутствии env-переменных выводится точная команда `source ".../env-export.sh"`
- если env уже есть, автоматически выполняется post-restore проверка (`openclaw gateway status` и напоминания)

### `clawsync merge`

Те же source-опции, что и у `pull`, но всегда local-first merge.

### `clawsync unpack`

Восстановление из локального архива.

- `--from <path>` (обязательно)
- `--strategy <mode>`: `overwrite|skip|merge`
- `--dry-run`, `--yes`, `--no-pre-snapshot`, `--overwrite-gateway-token`
- `--env-script-dir <path>`

### `clawsync serve`

HTTP-сервер локальных архивов с token-валидацией и встроенным web UI.

- `--token <secret>` (обязательно)
- `--port <port>` (по умолчанию `7373`)
- `--dir <path>` (по умолчанию `<state-dir>/migrations`)
- `--state-dir <path>`
- `--strategy <mode>`
- `--env-script-dir <path>`
- `--overwrite-gateway-token`

Эндпоинты:

- `GET /health`
- `GET /`
- `GET /archives`
- `GET /download/<filename>`
- `POST /upload`
- `POST /backup`
- `POST /restore/<filename>?dry_run=1|confirm=1`

### `clawsync schedule install`

Устанавливает/обновляет управляемый cron для периодического `clawsync push`.

- `--every <interval>` (обязательно): `30m`, `2h`, `1d`
- Git-опции: `--repo-dir`, `--branch`, `--keep`
- также: `--ignore-paths`, `--workspace-include-globs`, `--reuse-message-channel`

## Опциональный файл конфигурации

Путь по умолчанию: `~/.openclaw/clawsync.json`

```json
{
  "stateDir": "~/.openclaw",
  "include": ["config", "workspace"],
  "exclude": ["credentials", "sessions", "devices", "identity", "channels", "tools", "media"],
  "strategy": "overwrite",
  "sanitize": true
}
```

CLI-флаги имеют приоритет над config.

## Примечания по безопасности

- `credentials` и `.env` могут содержать секреты
- для чувствительных данных используйте приватные Git-репозитории
- по возможности исключайте `credentials`
- для автоматических бэкапов оставляйте `sanitize` включенным
- сгенерированные env-скрипты содержат секреты в открытом виде, храните их только локально
