import http from "node:http";
import path from "node:path";
import fs from "fs-extra";

export interface ArchiveServerOptions {
  token: string;
  port: number;
  archiveDir: string;
}

interface ArchiveItem {
  filename: string;
  size: number;
  createdAt: string;
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
        writeJson(res, 200, {
          service: "clawsync-serve",
          archiveDir: options.archiveDir,
          endpoints: ["/archives", "/download/:filename", "/health"],
        });
        return;
      }

      if (method === "GET" && pathname === "/archives") {
        const archives = await listArchives(options.archiveDir);
        writeJson(res, 200, {
          archives: archives.map((item) => ({
            ...item,
            downloadUrl: `/download/${encodeURIComponent(item.filename)}?token=${options.token}`,
          })),
        });
        return;
      }

      if (method === "GET" && pathname.startsWith("/download/")) {
        const filename = path.basename(decodeURIComponent(pathname.slice("/download/".length)));
        if (!filename.endsWith(".tar.gz")) {
          writeJson(res, 400, { error: "only .tar.gz files supported" });
          return;
        }
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
