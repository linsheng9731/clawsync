#!/usr/bin/env bash
set -euo pipefail

REPO="${CLAWSYNC_GH_REPO:-linsheng9731/clawsync}"
VERSION="${1:-latest}"
INSTALL_DIR="${CLAWSYNC_INSTALL_DIR:-$HOME/.local/bin}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

normalize_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    Darwin) echo "macos" ;;
    *)
      echo "unsupported operating system: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

normalize_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)
      echo "unsupported architecture: $(uname -m)" >&2
      echo "currently supported: x64, arm64" >&2
      exit 1
      ;;
  esac
}

need_cmd curl
need_cmd tar
need_cmd install

OS="$(normalize_os)"
ARCH="$(normalize_arch)"

if [[ "$VERSION" == "latest" ]]; then
  VERSION_LABEL="latest"
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/clawsync-${VERSION_LABEL}-${OS}-${ARCH}.tar.gz"
else
  TAG="${VERSION#v}"
  VERSION_LABEL="${TAG}"
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${TAG}/clawsync-${VERSION_LABEL}-${OS}-${ARCH}.tar.gz"
fi

TMP_DIR="$(mktemp -d)"
ARCHIVE_PATH="${TMP_DIR}/clawsync.tar.gz"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ${DOWNLOAD_URL}"
curl -fL "$DOWNLOAD_URL" -o "$ARCHIVE_PATH"

tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR"

mkdir -p "$INSTALL_DIR"
install -m 755 "${TMP_DIR}/clawsync" "${INSTALL_DIR}/clawsync"

echo "Installed clawsync to ${INSTALL_DIR}/clawsync"
echo "If needed, add to PATH: export PATH=\"${INSTALL_DIR}:\$PATH\""
