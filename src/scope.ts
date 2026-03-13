import fs from "fs-extra";
import path from "node:path";
import type { ScopeEntry, SyncComponent, SyncConfig } from "./types.js";

const COMPONENT_PATHS: Record<SyncComponent, string[]> = {
  config: ["openclaw.json", ".env"],
  workspace: ["workspace"],
  credentials: ["credentials"],
  sessions: ["sessions", "agents"],
  devices: ["devices"],
  identity: ["identity"],
  channels: ["telegram", "whatsapp", "signal", "discord"],
  tools: ["tools"],
  media: ["media"],
};

export function resolveEntries(config: SyncConfig): ScopeEntry[] {
  const set = new Set<SyncComponent>(config.include);
  for (const item of config.exclude) set.delete(item);
  const chosen = [...set];

  const entries: ScopeEntry[] = [];
  for (const component of chosen) {
    for (const relPath of COMPONENT_PATHS[component]) {
      entries.push({ component, relPath });
    }
  }
  return entries;
}

export async function resolveExistingPaths(config: SyncConfig): Promise<ScopeEntry[]> {
  const entries = resolveEntries(config);
  const existing: ScopeEntry[] = [];
  for (const entry of entries) {
    const full = path.join(config.stateDir, entry.relPath);
    if (await fs.pathExists(full)) existing.push(entry);
  }
  return existing;
}
