export type SyncComponent =
  | "config"
  | "workspace"
  | "credentials"
  | "sessions"
  | "devices"
  | "identity"
  | "channels"
  | "tools"
  | "media";

export interface SyncConfig {
  stateDir: string;
  include: SyncComponent[];
  exclude: SyncComponent[];
  ignorePaths: string[];
  workspaceIncludeGlobs: string[];
  includeAllWorkspaceFiles: boolean;
  strategy: UnpackStrategy;
  format: "tar";
  sanitize: boolean;
}

export type UnpackStrategy = "overwrite" | "skip" | "merge";

export interface ScopeEntry {
  component: SyncComponent;
  relPath: string;
}

export interface Manifest {
  createdAt: string;
  stateDir: string;
  include: SyncComponent[];
  exclude: SyncComponent[];
  ignorePaths?: string[];
  workspaceIncludeGlobs?: string[];
  files: string[];
  sanitized: boolean;
  envVars: string[];
  envScriptRelativePaths?: string[];
}

export interface MergeConflictItem {
  path: string;
  reason: "content-different" | "type-mismatch" | "unreadable";
}

export interface MergeReport {
  strategy: "merge";
  totalFiles: number;
  mergedNewFiles: number;
  keptLocalFiles: number;
  conflicts: MergeConflictItem[];
}

export interface UnpackResult {
  manifest: Manifest;
  mergeReport?: MergeReport;
}

export interface SanitizeResult {
  sanitized: boolean;
  envMap: Record<string, string>;
}

export interface CronJobStatus {
  installed: boolean;
  cronExpression?: string;
  command?: string;
  rawLine?: string;
}
