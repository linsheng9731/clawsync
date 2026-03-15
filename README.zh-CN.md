[English](README.md) | [中文](README.zh-CN.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [Italiano](README.it.md) | [Español](README.es.md)

# clawsync（中文）

使用 Git-first 工作流同步 OpenClaw 状态，并支持本地打包、迁移与安全恢复。

**作者 (X):** [@shngshngln86211](https://x.com/shngshngln86211)

## 功能亮点

- **更完整的 Git 原生流程**：内置 `git init`、`push`、`pull`、本地优先 `merge`，通过分支完成可追溯的备份/恢复。
- **细粒度备份范围控制**：可用 `--include/--exclude` 选择组件，`--ignore-paths` 跳过路径，`--workspace-include-globs` 额外收集工作区文件。
- **内置敏感信息脱敏管道**：默认启用 `sanitize`，将密钥替换为占位符，并在恢复后生成 env 恢复脚本。
- **更丰富的恢复策略**：支持 `overwrite`、`skip`、`merge`，并默认提供恢复安全机制（`--dry-run`、恢复前快照、本地 gateway token 保留）。

## 安装

### 一键安装（GitHub Releases）

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash
```

安装指定版本：

```bash
curl -fsSL "https://raw.githubusercontent.com/linsheng9731/clawsync/main/scripts/install.sh" | CLAWSYNC_GH_REPO="linsheng9731/clawsync" bash -s -- v0.1.1
```

默认安装路径：`~/.local/bin/clawsync`（可通过 `CLAWSYNC_INSTALL_DIR` 覆盖）。

### 本地开发安装

```bash
npm install
npm run build
npm link
clawsync --help
```

## 推荐工作流

1) 首次初始化 Git 后端：

```bash
clawsync git init --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo
```

2) 可选打包检查：

```bash
clawsync pack --dry-run
clawsync pack
```

3) 推送备份：

```bash
clawsync push --repo-dir ~/.clawsync-repo
```

4) 拉取并恢复：

```bash
clawsync pull --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

5) 本地优先合并：

```bash
clawsync merge --repo-url git@github.com:your-org/your-openclaw-backup.git --repo-dir ~/.clawsync-repo --branch clawsync_20260313
```

## 命令参考

所有命令都支持 `--help`：

```bash
clawsync <command> --help
```

### 全局参数（按命令适用）

- `--version`：输出当前 clawsync 版本
- `--state-dir <path>`：OpenClaw 状态目录（默认 `~/.openclaw` 或 `OPENCLAW_STATE_DIR`）
- `--config <path>`：自定义配置文件路径
- `--include <list>`：逗号分隔的包含组件（`config,workspace,credentials,sessions,devices,identity,channels,tools,media`）
- `--exclude <list>`：逗号分隔的排除组件
- `--ignore-paths <list>`：逗号分隔的相对路径忽略列表
- `--workspace-include-globs <list>`：额外包含工作区文件/目录
- `--no-sanitize`：关闭敏感信息占位替换

### `clawsync git init`

初始化或更新 `clawsync push` 使用的本地 Git 仓库。

- `--repo-url <url>`（必填）：作为 `origin` 的远程 Git 地址
- `--repo-dir <path>`：本地仓库路径（默认 `~/.clawsync-repo`）
- `--branch <name>`：初始检出分支（默认 `main`）

### `clawsync git prune-branches`

按保留天数清理远端中历史 `clawsync_YYYYMMDD` 分支。

- `--repo-dir <path>`：本地仓库路径
- `--repo-url <url>`：远端地址（本地仓库未初始化时可选）
- `--keep-days <days>`：仅保留最近 N 天分支（默认 `30`）
- `--dry-run`：仅预览将被删除的分支
- `--yes`：确认执行删除（不带 `--dry-run` 时必填）

示例：

```bash
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --dry-run
clawsync git prune-branches --repo-dir ~/.clawsync-repo --keep-days 30 --yes
```

### `clawsync pack`

将选定状态文件打包为 `tar.gz`。

- `--out <dir>`：输出目录（不填则使用临时目录 `/tmp/clawsync-*`）
- `--dry-run`：仅预览文件与脱敏结果，不写归档

说明：除非显式设置 `--out ~/.clawsync-repo/archives`，`pack` 不会写入 `~/.clawsync-repo`。  
输出预览会压缩到最多 3 层目录、最多 10 行。

### `clawsync profile full-migrate`

生成仅本地使用的完整迁移包（不会推送到 Git）。

- 包含范围：`config,workspace,credentials,sessions,devices,identity,channels`
- 工作区范围：默认完整包含 `workspace/`（含业务/项目文件）
- 默认输出：`<state-dir>/migrations`
- 默认 `sanitize: off`（可用 `--sanitize` 开启）
- 支持 `--dry-run`

### `clawsync push`

先打包，再推送到 Git 后端。

- `--repo-dir <path>`：本地 Git 仓库路径
- `--branch <name>`：目标分支
- `--keep <count>`：推送后在仓库中仅保留最近 N 个归档（归档保留策略）
- `--dry-run`：预览推送目标与选择范围
- `--reuse-message-channel <mode>`：`yes|no`

未指定分支时，默认：`clawsync_YYYYMMDD`（例如 `clawsync_20260313`）。

### `clawsync pull`

从 Git 拉取并解包到本地状态目录。

- `--repo-url <url>`：远程 Git 地址（`repo-dir` 已配置 `origin` 时可省略）
- `--repo-dir <path>`：本地 Git 仓库路径
- `--branch <name>`：来源分支（默认 `main`）
- `--state-dir <path>`：目标状态目录
- `--strategy <mode>`：`overwrite|skip|merge`
- `--env-script-dir <path>`：env 恢复脚本输出路径
- `--dry-run`：仅预览恢复计划，不写入
- `--yes`：跳过高风险交互确认
- `--no-pre-snapshot`：关闭自动恢复前快照
- `--overwrite-gateway-token`：使用备份 token 覆盖本地 token（默认会保留本地 token）

恢复后（`unpack` / `pull` / `merge`）：

- 若当前 shell 缺少脱敏后的必需 env，CLI 会输出精确的 `source ".../env-export.sh"` 命令
- 若必需 env 已存在，CLI 会自动执行恢复后检查：
  - `openclaw gateway status`
  - channel 重连提醒
  - 必要时提示执行 Telegram `/start`

### `clawsync merge`

与 `pull` 使用同样的源参数，但始终采用本地优先合并。

`unpack` / `pull` / `merge` 的默认恢复安全策略：

- 高风险恢复会要求确认
- 建议先执行 `--dry-run`
- 默认在 `/tmp` 生成恢复前快照
- 默认保留本地 `gateway.auth.token`

### `clawsync unpack`

从本地归档恢复，安全参数与 `pull` 一致：

- `--from <path>`（必填）：本地归档路径
- `--strategy <mode>`：`overwrite|skip|merge`
- `--dry-run`、`--yes`、`--no-pre-snapshot`、`--overwrite-gateway-token`
- `--env-script-dir <path>`

### `clawsync serve`

通过 HTTP 提供本地归档服务，包含 token 校验与内置 Web UI。

- `--token <secret>`（必填）：访问 token
- `--port <port>`：服务端口（默认 `7373`）
- `--dir <path>`：归档目录（默认 `<state-dir>/migrations`）
- `--state-dir <path>`：当未设置 `--dir` 时用于推导默认目录
- `--strategy <mode>`：`/restore` 默认恢复策略（`overwrite|skip|merge`）
- `--env-script-dir <path>`：恢复后 env 脚本输出目录
- `--overwrite-gateway-token`：`/restore` 时使用备份 token 覆盖本地 token
- `/backup` 同时支持 `pack/push` 的打包范围参数（如 `--include`、`--exclude`、`--ignore-paths`）

接口：

- `GET /health`：健康检查（无需 token）
- `GET /`：简易 Web UI（需要 token）
- `GET /archives`：归档列表（需要 token）
- `GET /download/<filename>`：下载归档（需要 token）
- `POST /upload`：上传归档（需要 token）
- `POST /backup`：创建归档（需要 token，仅 localhost）
- `POST /restore/<filename>?dry_run=1|confirm=1`：恢复归档（需要 token，仅 localhost）

示例：

```bash
clawsync serve --token "your-secret-token" --port 7373
curl "http://127.0.0.1:7373/archives?token=your-secret-token"
```

### `clawsync schedule install`

安装或更新托管 cron 任务，定期执行 `clawsync push`。

- `--every <interval>`（必填）：`30m`、`2h`、`1d`
- Git 相关参数：`--repo-dir`、`--branch`、`--keep`
- 也支持 `--ignore-paths`、`--workspace-include-globs`、`--reuse-message-channel`

执行 `schedule install` 前，请先运行 `clawsync git init --repo-url ...`。

## 可选配置文件

默认配置路径：`~/.openclaw/clawsync.json`

```json
{
  "stateDir": "~/.openclaw",
  "include": ["config", "workspace"],
  "exclude": ["credentials", "sessions", "devices", "identity", "channels", "tools", "media"],
  "strategy": "overwrite",
  "sanitize": true
}
```

命令行参数优先级高于配置文件。

## 安全说明

- `credentials` 与 `.env` 可能包含敏感信息
- 同步敏感内容时请使用私有 Git 远程仓库
- 非必须时建议排除 `credentials`
- 自动化备份建议保持 `sanitize` 开启
- 生成的 env 脚本包含明文密钥，应仅本地保存
