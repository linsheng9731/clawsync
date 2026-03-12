import path from "node:path";
import fs from "fs-extra";
import JSON5 from "json5";
import type { SanitizeResult } from "./types.js";

const SENSITIVE_KEY_PATTERNS = [
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "privatekey",
  "private_key",
  "clientsecret",
  "client_secret",
];

const SENSITIVE_VALUE_PATTERNS = [
  /^sk-[a-z0-9]/i,
  /^ghp_[a-z0-9]/i,
  /^xox[baprs]-/i,
  /^aiza[0-9a-z_-]+/i,
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(pattern.replace(/[^a-z0-9]/g, "")));
}

function isSensitiveValue(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (v.startsWith("${") && v.endsWith("}")) return false;
  return SENSITIVE_VALUE_PATTERNS.some((re) => re.test(v));
}

function toEnvName(input: string): string {
  const normalized = input
    .replace(/[.\[\]"]/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `CLAWSYNC_${normalized || "SECRET"}`;
}

function ensureUniqueEnvName(base: string, envMap: Record<string, string>, value: string): string {
  if (!(base in envMap) || envMap[base] === value) return base;
  let idx = 2;
  while (`${base}_${idx}` in envMap && envMap[`${base}_${idx}`] !== value) {
    idx += 1;
  }
  return `${base}_${idx}`;
}

function sanitizeJsonObject(node: unknown, objectPath: string, envMap: Record<string, string>): unknown {
  if (Array.isArray(node)) {
    return node.map((item, idx) => sanitizeJsonObject(item, `${objectPath}[${idx}]`, envMap));
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const keyPath = objectPath ? `${objectPath}.${key}` : key;
      if (typeof value === "string" && (isSensitiveKey(key) || isSensitiveValue(value))) {
        const envName = ensureUniqueEnvName(toEnvName(keyPath), envMap, value);
        envMap[envName] = value;
        out[key] = `\${${envName}}`;
      } else {
        out[key] = sanitizeJsonObject(value, keyPath, envMap);
      }
    }
    return out;
  }
  return node;
}

function splitEnvLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const eq = line.indexOf("=");
  if (eq <= 0) return undefined;
  const key = line.slice(0, eq).trim();
  const rawValue = line.slice(eq + 1).trim();
  const value = rawValue.replace(/^['"]|['"]$/g, "");
  return { key, value };
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, "'\"'\"'");
}

async function sanitizeEnvFile(filePath: string, envMap: Record<string, string>): Promise<boolean> {
  const content = await fs.readFile(filePath, "utf8");
  let changed = false;
  const outputLines = content.split(/\r?\n/).map((line) => {
    const parsed = splitEnvLine(line);
    if (!parsed) return line;
    const { key, value } = parsed;
    if (!isSensitiveKey(key) && !isSensitiveValue(value)) return line;

    const envName = ensureUniqueEnvName(toEnvName(key), envMap, value);
    envMap[envName] = value;
    changed = true;
    return `${key}=\${${envName}}`;
  });
  if (changed) {
    await fs.writeFile(filePath, `${outputLines.join("\n")}\n`, "utf8");
  }
  return changed;
}

async function sanitizeJsonFile(filePath: string, envMap: Record<string, string>): Promise<boolean> {
  const content = await fs.readFile(filePath, "utf8");
  const parsed = JSON5.parse(content) as unknown;
  const before = JSON.stringify(parsed);
  const sanitized = sanitizeJsonObject(parsed, "", envMap);
  const after = JSON.stringify(sanitized);
  if (before === after) return false;
  await fs.writeFile(filePath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  return true;
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  if (!(await fs.pathExists(rootDir))) return [];
  const out: string[] = [];
  const entries = await fs.readdir(rootDir);
  for (const entry of entries) {
    const full = path.join(rootDir, entry);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

async function sanitizeWorkspaceConfigs(payloadDir: string, envMap: Record<string, string>): Promise<boolean> {
  const workspaceDir = path.join(payloadDir, "workspace");
  const files = await listFilesRecursive(workspaceDir);
  const candidates = files.filter((f) => /\.(json|ya?ml|toml|env)$/i.test(f));
  let changed = false;
  for (const file of candidates) {
    if (file.endsWith(".json")) {
      try {
        changed = (await sanitizeJsonFile(file, envMap)) || changed;
      } catch {
        // Keep best-effort behavior for non-JSON payloads.
      }
    } else if (file.endsWith(".env")) {
      changed = (await sanitizeEnvFile(file, envMap)) || changed;
    }
  }
  return changed;
}

export async function sanitizeStagingPayload(payloadDir: string): Promise<SanitizeResult> {
  const envMap: Record<string, string> = {};
  let changed = false;

  const openclawConfigPath = path.join(payloadDir, "openclaw.json");
  if (await fs.pathExists(openclawConfigPath)) {
    changed = (await sanitizeJsonFile(openclawConfigPath, envMap)) || changed;
  }

  const globalEnvPath = path.join(payloadDir, ".env");
  if (await fs.pathExists(globalEnvPath)) {
    changed = (await sanitizeEnvFile(globalEnvPath, envMap)) || changed;
  }

  changed = (await sanitizeWorkspaceConfigs(payloadDir, envMap)) || changed;

  return {
    sanitized: changed,
    envMap,
  };
}

export function toPosixScript(envMap: Record<string, string>): string {
  const lines = [
    "#!/usr/bin/env bash",
    "# Generated by clawsync. Contains secrets. Do not commit.",
  ];
  for (const [key, value] of Object.entries(envMap)) {
    lines.push(`export ${key}='${escapeSingleQuotes(value)}'`);
  }
  lines.push('echo "Environment loaded."');
  return `${lines.join("\n")}\n`;
}

export function toPowerShellScript(envMap: Record<string, string>): string {
  const lines = [
    "# Generated by clawsync. Contains secrets. Do not commit.",
  ];
  for (const [key, value] of Object.entries(envMap)) {
    const escaped = value.replace(/'/g, "''");
    lines.push(`$env:${key} = '${escaped}'`);
  }
  lines.push('Write-Output "Environment loaded."');
  return `${lines.join("\n")}\n`;
}

export function toCmdScript(envMap: Record<string, string>): string {
  const lines = [
    "@echo off",
    "REM Generated by clawsync. Contains secrets. Do not commit.",
  ];
  for (const [key, value] of Object.entries(envMap)) {
    const escaped = value
      .replace(/\^/g, "^^")
      .replace(/&/g, "^&")
      .replace(/\|/g, "^|")
      .replace(/</g, "^<")
      .replace(/>/g, "^>");
    lines.push(`set ${key}=${escaped}`);
  }
  lines.push("echo Environment loaded.");
  return `${lines.join("\n")}\n`;
}
