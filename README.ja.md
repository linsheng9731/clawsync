[English](README.md) | [中文](README.zh-CN.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [Italiano](README.it.md) | [Español](README.es.md)

# clawsync（日本語）

OpenClaw の状態を Git-first ワークフローで同期し、ローカルアーカイブ、移行、安全な復元を実現します。

**作者 (X):** [@shngshngln86211](https://x.com/shngshngln86211)

## 主な機能

- **Git ネイティブな運用**: `git init`、`push`、`pull`、ローカル優先の `merge` を標準搭載。
- **きめ細かいバックアップ範囲制御**: `--include/--exclude`、`--ignore-paths`、`--workspace-include-globs` をサポート。
- **機密情報のサニタイズ**: `sanitize` は既定で有効。秘密情報をプレースホルダー化し、復元後の env 復旧スクリプトも生成。
- **柔軟な復元戦略**: `overwrite`、`skip`、`merge` に対応。`--dry-run`、復元前スナップショット、ローカル gateway token 保持を既定で提供。

## インストール

### ワンコマンドインストール（GitHub Releases）

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash
```

特定バージョンをインストール:

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash -s -- v0.1.1
```

既定のインストール先: `~/.local/bin/clawsync`（`CLAWSYNC_INSTALL_DIR` で変更可能）。

### ローカル開発環境でのインストール

```bash
npm install
npm run build
npm link
clawsync --help
```

## 推奨ワークフロー

1) まず Git バックエンドを初期化:

```bash
clawsync git init --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo
```

2) 任意でパッケージ内容を確認:

```bash
clawsync pack --dry-run
clawsync pack
```

3) バックアップを push:

```bash
clawsync push --repo-dir ~/.clawsync-repo
```

4) pull して復元:

```bash
clawsync pull --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

5) ローカル優先 merge:

```bash
clawsync merge --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

## コマンドリファレンス

すべてのコマンドで `--help` を利用できます:

```bash
clawsync <command> --help
```

### グローバルオプション（該当コマンドのみ）

- `--version`: 現在の clawsync バージョンを表示
- `--state-dir <path>`: OpenClaw state ディレクトリ（既定: `~/.openclaw` または `OPENCLAW_STATE_DIR`）
- `--config <path>`: カスタム設定ファイル
- `--include <list>`: 追加するコンポーネント（`config,workspace,credentials,sessions,devices,identity,channels,tools,media`）
- `--exclude <list>`: 除外するコンポーネント
- `--ignore-paths <list>`: 除外する相対パス
- `--workspace-include-globs <list>`: 追加で含める workspace ファイル/フォルダ
- `--no-sanitize`: 秘密情報の置換を無効化

### `clawsync git init`

`clawsync push` で使うローカル Git リポジトリを初期化/更新します。

- `--repo-url <url>`（必須）: `origin` に設定するリモート URL
- `--repo-dir <path>`: ローカル repo パス（既定: `~/.clawsync-repo`）
- `--branch <name>`: 初期チェックアウトブランチ（既定: `main`）

### `clawsync git prune-branches`

リモートの古い `clawsync_YYYYMMDD` バックアップブランチを削除します。

- `--repo-dir <path>`
- `--repo-url <url>`: リモート URL（オプション、repo 初期化が必要な場合）
- `--keep-days <days>`: 直近 N 日以内のブランチを保持（既定: `30`）
- `--dry-run`: 削除候補を表示（実際には削除しない）
- `--yes`: 実際に削除するには必須

例:

```bash
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --dry-run
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --yes
```

### `clawsync pack`

選択された state ファイルから `tar.gz` アーカイブを作成します。

- `--out <dir>`: 出力先（未指定時は `/tmp/clawsync-*`）
- `--dry-run`: 書き込みなしで対象/サニタイズ結果を表示

### `clawsync profile full-migrate`

Git へ push しないローカル専用の完全移行アーカイブを作成します。

- includes: `config,workspace,credentials,sessions,devices,identity,channels`
- workspace は既定で全量収集（業務/プロジェクトファイルを含む）
- 既定出力: `<state-dir>/migrations`
- 既定 `sanitize: off`（`--sanitize` で有効化）
- `--dry-run` 対応

### `clawsync push`

pack 後に Git バックエンドへ push します。

- `--repo-dir <path>`
- `--branch <name>`
- `--keep <count>`: push 後に保持する最新アーカイブ数
- `--dry-run`
- `--reuse-message-channel <mode>`: `yes|no`

ブランチ省略時は `clawsync_YYYYMMDD` を使用します。

### `clawsync pull`

Git から取得し、ローカル state に展開します。

- `--repo-url <url>`
- `--repo-dir <path>`
- `--branch <name>`（既定: `main`）
- `--state-dir <path>`
- `--strategy <mode>`: `overwrite|skip|merge`
- `--env-script-dir <path>`
- `--dry-run`
- `--yes`
- `--no-pre-snapshot`
- `--overwrite-gateway-token`

復元後（`unpack` / `pull` / `merge`）:

- 必須 env が不足している場合、`source ".../env-export.sh"` コマンドを表示
- env が揃っている場合、`openclaw gateway status` などの復元後チェックを自動実行

### `clawsync merge`

`pull` と同じソース指定ですが、常にローカル優先マージを行います。

### `clawsync unpack`

ローカルアーカイブから復元します。

- `--from <path>`（必須）
- `--strategy <mode>`: `overwrite|skip|merge`
- `--dry-run`, `--yes`, `--no-pre-snapshot`, `--overwrite-gateway-token`
- `--env-script-dir <path>`

### `clawsync serve`

トークン認証付きでローカルアーカイブを HTTP 配信し、簡易 Web UI も提供します。

- `--token <secret>`（必須）
- `--port <port>`（既定: `7373`）
- `--dir <path>`（既定: `<state-dir>/migrations`）
- `--state-dir <path>`
- `--strategy <mode>`: `/restore` の既定戦略
- `--env-script-dir <path>`
- `--overwrite-gateway-token`

主なエンドポイント:

- `GET /health`
- `GET /`
- `GET /archives`
- `GET /download/<filename>`
- `POST /upload`
- `POST /backup`
- `POST /restore/<filename>?dry_run=1|confirm=1`

### `clawsync schedule install`

定期 `clawsync push` 用の管理 cron をインストール/更新します。

- `--every <interval>`（必須）: `30m`, `2h`, `1d`
- Git 関連: `--repo-dir`, `--branch`, `--keep`
- 追加: `--ignore-paths`, `--workspace-include-globs`, `--reuse-message-channel`

## オプション設定ファイル

既定パス: `~/.openclaw/clawsync.json`

```json
{
  "stateDir": "~/.openclaw",
  "include": ["config", "workspace"],
  "exclude": ["credentials", "sessions", "devices", "identity", "channels", "tools", "media"],
  "strategy": "overwrite",
  "sanitize": true
}
```

CLI フラグが設定ファイルより優先されます。

## セキュリティ注意

- `credentials` や `.env` に秘密情報が含まれる可能性があります
- 機密を扱う場合、Git リモートは必ず非公開にしてください
- 必要な場合を除き `credentials` の除外を推奨します
- 自動バックアップでは `sanitize` を有効のままにしてください
- 生成される env スクリプトは平文秘密情報を含むためローカル管理に限定してください
