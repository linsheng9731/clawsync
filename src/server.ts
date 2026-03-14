import http from "node:http";
import path from "node:path";
import fs from "fs-extra";
import { packState, readArchiveManifest, unpackState } from "./archive.js";
import type { SyncConfig, UnpackStrategy } from "./types.js";

export interface ArchiveServerOptions {
  token: string;
  port: number;
  archiveDir: string;
  backupConfig?: SyncConfig;
  restoreStateDir?: string;
  restoreStrategy?: UnpackStrategy;
  envScriptDir?: string;
  preserveGatewayToken?: boolean;
}

interface ArchiveItem {
  filename: string;
  size: number;
  createdAt: string;
}

interface ParsedMultipart {
  filename: string;
  data: Buffer;
}

function parseRequestUrl(url: string | undefined): URL {
  return new URL(url ?? "/", "http://localhost");
}

function getTokenFromRequest(req: http.IncomingMessage): string {
  const parsed = parseRequestUrl(req.url);
  const queryToken = parsed.searchParams.get("token") ?? "";
  if (queryToken) return queryToken;
  const auth = `${req.headers.authorization ?? ""}`.trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return auth;
}

function writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function rejectUnauthorized(res: http.ServerResponse): void {
  writeJson(res, 401, {
    error: "unauthorized",
    hint: "pass ?token=... or Authorization: Bearer ...",
  });
}

function getRemoteAddress(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? "";
}

function isLocalhostRequest(req: http.IncomingMessage): boolean {
  const ip = getRemoteAddress(req);
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function listArchives(archiveDir: string): Promise<ArchiveItem[]> {
  await fs.ensureDir(archiveDir);
  const names = await fs.readdir(archiveDir);
  const items: ArchiveItem[] = [];
  for (const name of names) {
    if (!name.endsWith(".tar.gz")) continue;
    const fullPath = path.join(archiveDir, name);
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) continue;
    items.push({
      filename: name,
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
    });
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipartBody(req: http.IncomingMessage, body: Buffer): ParsedMultipart {
  const contentType = `${req.headers["content-type"] ?? ""}`;
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) {
    throw new Error("invalid multipart request: missing boundary");
  }
  const boundary = boundaryMatch[1];
  const bodyText = body.toString("binary");
  const headerEnd = bodyText.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    throw new Error("invalid multipart request: missing header separator");
  }
  const headerText = bodyText.slice(0, headerEnd);
  const filenameMatch = headerText.match(/filename="([^"]+)"/);
  if (!filenameMatch) {
    throw new Error("invalid multipart request: missing filename");
  }
  const filename = path.basename(filenameMatch[1]);
  const payloadStart = headerEnd + 4;
  const endMarker = `\r\n--${boundary}`;
  const payloadEnd = bodyText.indexOf(endMarker, payloadStart);
  const fileData = payloadEnd >= 0 ? body.slice(payloadStart, payloadEnd) : body.slice(payloadStart);
  return { filename, data: fileData };
}

function sanitizeFilename(input: string): string {
  return path.basename(decodeURIComponent(input));
}

function ensureArchiveFilename(filename: string): void {
  if (!filename.endsWith(".tar.gz")) {
    throw new Error("only .tar.gz files supported");
  }
}

function renderUiHtml(token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>clawsync serve</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #0f1117; color: #e5e7eb; }
    main { max-width: 980px; margin: 0 auto; padding: 24px; }
    .card { background: #1a1d29; border: 1px solid #2a3042; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
    h1 { margin: 0 0 8px 0; font-size: 22px; }
    h2 { margin: 0 0 10px 0; font-size: 16px; color: #93c5fd; }
    button, .btn-link { border: 0; border-radius: 8px; background: #2563eb; color: #fff; padding: 8px 12px; cursor: pointer; text-decoration: none; font-size: 14px; }
    button.danger { background: #dc2626; }
    button.secondary { background: #334155; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #2a3042; font-size: 14px; }
    .status { margin-top: 12px; padding: 10px; border-radius: 8px; background: #1e293b; white-space: pre-wrap; }
    .hidden { display: none; }
    .muted { color: #94a3b8; font-size: 13px; }
    .row-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  </style>
</head>
<body>
  <main>
    <h1>clawsync serve</h1>
    <p class="muted">Token protected archive service with upload/download and localhost backup/restore.</p>
    <div id="remoteNotice" class="card hidden">
      <strong>Remote access mode:</strong> backup/restore actions are disabled and can only be run from localhost.
    </div>
    <div id="backupCard" class="card">
      <h2>Create backup</h2>
      <button id="backupBtn">Create backup now</button>
      <div id="backupStatus" class="status hidden"></div>
    </div>
    <div class="card">
      <h2>Upload archive</h2>
      <input type="file" id="fileInput" accept=".tar.gz" />
      <button id="uploadBtn" class="secondary">Upload</button>
      <div id="uploadStatus" class="status hidden"></div>
    </div>
    <div class="card">
      <h2>Archives</h2>
      <table>
        <thead>
          <tr><th>Filename</th><th>Size</th><th>Created</th><th>Actions</th></tr>
        </thead>
        <tbody id="archiveRows">
          <tr><td colspan="4" class="muted">Loading...</td></tr>
        </tbody>
      </table>
    </div>
  </main>
  <script>
    const TOKEN = ${JSON.stringify(token)};
    const headers = { Authorization: "Bearer " + TOKEN };
    const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";

    function showStatus(id, message, ok = true) {
      const el = document.getElementById(id);
      el.textContent = message;
      el.style.background = ok ? "#14532d" : "#7f1d1d";
      el.classList.remove("hidden");
    }

    async function listArchives() {
      const res = await fetch("/archives", { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "list archives failed");
      return data.archives || [];
    }

    function renderRows(archives) {
      const body = document.getElementById("archiveRows");
      if (!archives.length) {
        body.innerHTML = '<tr><td colspan="4" class="muted">No archives found.</td></tr>';
        return;
      }
      body.innerHTML = "";
      for (const item of archives) {
        const tr = document.createElement("tr");
        const downloadUrl = "/download/" + encodeURIComponent(item.filename) + "?token=" + encodeURIComponent(TOKEN);
        tr.innerHTML = \`
          <td>\${item.filename}</td>
          <td>\${item.sizeHuman || item.size}</td>
          <td>\${new Date(item.createdAt).toLocaleString()}</td>
          <td>
            <div class="row-actions">
              <a class="btn-link secondary" href="\${downloadUrl}">Download</a>
              <button class="secondary" data-action="dry-run" data-name="\${item.filename}">Dry-run restore</button>
              <button class="danger" data-action="restore" data-name="\${item.filename}">Restore</button>
            </div>
          </td>
        \`;
        body.appendChild(tr);
      }
      if (!isLocal) {
        body.querySelectorAll("button").forEach((btn) => {
          btn.disabled = true;
          btn.title = "localhost only";
        });
      }
      body.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const filename = btn.dataset.name;
          const action = btn.dataset.action;
          try {
            if (action === "restore") {
              const typed = prompt("Type YES to confirm restore: " + filename);
              if (typed !== "YES") return;
              await callRestore(filename, false);
              showStatus("backupStatus", "Restore completed: " + filename, true);
            } else {
              await callRestore(filename, true);
              showStatus("backupStatus", "Dry-run completed: " + filename, true);
            }
          } catch (err) {
            showStatus("backupStatus", String(err), false);
          }
        });
      });
    }

    async function refreshRows() {
      const archives = await listArchives();
      renderRows(archives);
    }

    async function callRestore(filename, dryRun) {
      const params = new URLSearchParams();
      if (dryRun) params.set("dry_run", "1");
      else params.set("confirm", "1");
      const res = await fetch("/restore/" + encodeURIComponent(filename) + "?" + params.toString(), {
        method: "POST",
        headers,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "restore failed");
      return data;
    }

    document.getElementById("backupBtn").addEventListener("click", async () => {
      try {
        const res = await fetch("/backup", { method: "POST", headers });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "backup failed");
        showStatus("backupStatus", "Backup created: " + data.filename + " (" + (data.sizeHuman || data.size) + ")", true);
        await refreshRows();
      } catch (err) {
        showStatus("backupStatus", String(err), false);
      }
    });

    document.getElementById("uploadBtn").addEventListener("click", async () => {
      const fileInput = document.getElementById("fileInput");
      const file = fileInput.files[0];
      if (!file) {
        showStatus("uploadStatus", "Choose a .tar.gz file first.", false);
        return;
      }
      try {
        const formData = new FormData();
        formData.append("archive", file);
        const res = await fetch("/upload", { method: "POST", headers, body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "upload failed");
        showStatus("uploadStatus", "Upload completed: " + data.filename, true);
        await refreshRows();
      } catch (err) {
        showStatus("uploadStatus", String(err), false);
      }
    });

    if (!isLocal) {
      document.getElementById("remoteNotice").classList.remove("hidden");
      document.getElementById("backupCard").classList.add("hidden");
    }

    refreshRows().catch((err) => {
      showStatus("backupStatus", String(err), false);
    });
  </script>
</body>
</html>`;
}

export async function runArchiveServer(options: ArchiveServerOptions): Promise<void> {
  if (!options.token.trim()) {
    throw new Error("serve requires non-empty --token");
  }
  await fs.ensureDir(options.archiveDir);

  const server = http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const parsed = parseRequestUrl(req.url);
      const pathname = parsed.pathname;

      if (method === "GET" && pathname === "/health") {
        writeJson(res, 200, { status: "ok", service: "clawsync-serve" });
        return;
      }

      const token = getTokenFromRequest(req);
      if (token !== options.token) {
        rejectUnauthorized(res);
        return;
      }

      if (method === "GET" && pathname === "/") {
        const html = renderUiHtml(options.token);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(html);
        return;
      }

      if (method === "GET" && pathname === "/archives") {
        const archives = await listArchives(options.archiveDir);
        writeJson(res, 200, {
          archives: archives.map((item) => ({
            ...item,
            sizeHuman: formatBytes(item.size),
            downloadUrl: `/download/${encodeURIComponent(item.filename)}?token=${options.token}`,
          })),
        });
        return;
      }

      if (method === "POST" && pathname === "/upload") {
        const body = await readRequestBody(req);
        const parsedMultipart = parseMultipartBody(req, body);
        const filename = sanitizeFilename(parsedMultipart.filename);
        ensureArchiveFilename(filename);
        const filePath = path.join(options.archiveDir, filename);
        await fs.writeFile(filePath, parsedMultipart.data);
        await fs.chmod(filePath, 0o600);
        writeJson(res, 200, {
          message: "upload completed",
          filename,
          size: parsedMultipart.data.length,
          sizeHuman: formatBytes(parsedMultipart.data.length),
        });
        return;
      }

      if (method === "POST" && pathname === "/backup") {
        if (!isLocalhostRequest(req)) {
          writeJson(res, 403, {
            error: "backup is localhost-only",
            hint: "run this endpoint from localhost or run clawsync pack manually",
          });
          return;
        }
        if (!options.backupConfig) {
          writeJson(res, 501, { error: "backup is not configured for this serve session" });
          return;
        }
        const backupResult = await packState(options.backupConfig, options.archiveDir);
        const stat = await fs.stat(backupResult.archivePath);
        writeJson(res, 200, {
          message: "backup created",
          filename: path.basename(backupResult.archivePath),
          archivePath: backupResult.archivePath,
          size: stat.size,
          sizeHuman: formatBytes(stat.size),
          files: backupResult.manifest.files.length,
        });
        return;
      }

      if (method === "POST" && pathname.startsWith("/restore/")) {
        if (!isLocalhostRequest(req)) {
          writeJson(res, 403, {
            error: "restore is localhost-only",
            hint: "download archive and run clawsync unpack on the same machine",
          });
          return;
        }
        if (!options.restoreStateDir) {
          writeJson(res, 501, { error: "restore is not configured for this serve session" });
          return;
        }
        const filename = sanitizeFilename(pathname.slice("/restore/".length));
        ensureArchiveFilename(filename);
        const filePath = path.join(options.archiveDir, filename);
        if (!(await fs.pathExists(filePath))) {
          writeJson(res, 404, { error: "archive not found" });
          return;
        }
        const dryRun = parsed.searchParams.get("dry_run") === "1";
        const confirm = parsed.searchParams.get("confirm") === "1";
        const strategy = (parsed.searchParams.get("strategy") as UnpackStrategy | null) ?? options.restoreStrategy ?? "overwrite";
        if (!["overwrite", "skip", "merge"].includes(strategy)) {
          writeJson(res, 400, { error: "invalid strategy. allowed: overwrite|skip|merge" });
          return;
        }
        if (dryRun) {
          const manifest = await readArchiveManifest(filePath);
          writeJson(res, 200, {
            message: "dry run complete",
            dryRun: true,
            strategy,
            files: manifest.files.length,
            sanitized: manifest.sanitized,
          });
          return;
        }
        if (!confirm) {
          writeJson(res, 400, { error: "restore requires ?confirm=1 (or use ?dry_run=1 first)" });
          return;
        }
        const restoreResult = await unpackState(
          filePath,
          options.restoreStateDir,
          strategy,
          options.envScriptDir,
          { preserveGatewayToken: options.preserveGatewayToken ?? true },
        );
        writeJson(res, 200, {
          message: "restore complete",
          dryRun: false,
          strategy,
          files: restoreResult.manifest.files.length,
          mergeReport: restoreResult.mergeReport,
          gatewayToken: (options.preserveGatewayToken ?? true) ? "preserved-local" : "restored-from-backup",
        });
        return;
      }

      if (method === "GET" && pathname.startsWith("/download/")) {
        const filename = sanitizeFilename(pathname.slice("/download/".length));
        ensureArchiveFilename(filename);
        const fullPath = path.join(options.archiveDir, filename);
        if (!(await fs.pathExists(fullPath))) {
          writeJson(res, 404, { error: "archive not found" });
          return;
        }
        const stat = await fs.stat(fullPath);
        res.writeHead(200, {
          "content-type": "application/gzip",
          "content-length": stat.size,
          "content-disposition": `attachment; filename="${filename}"`,
        });
        fs.createReadStream(fullPath).pipe(res);
        return;
      }

      writeJson(res, 404, { error: "not found" });
    })().catch((error) => {
      writeJson(res, 500, { error: (error as Error).message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log(`serve started on http://localhost:${options.port}/?token=${options.token}`);
  console.log(`archive dir: ${options.archiveDir}`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
