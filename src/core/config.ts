// pi-fovea configuration. Mirrors pi-fabric's two-scope model: a global file
// under the pi agent dir and a trusted project override beneath pi's
// configurable project resource directory. Settings merge over
// defaults; the FOVEA_TURN_SYNC=off environment variable always wins, the
// same way PI_FABRIC_* overrides win over stored fabric config.

import { configDirName } from "./agent-dir.js";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const SYNC_MODES = ["enabled", "hidden", "disabled"] as const;
type SyncMode = (typeof SYNC_MODES)[number];
export const SYNC_SCOPES = ["session", "repository"] as const;
type SyncScope = (typeof SYNC_SCOPES)[number];

interface FoveaSyncConfig {
  /** Continuous sync delivery: visible, model-only, or fully disabled. */
  mode: SyncMode;
  /** Session-local logical directories by default; repository restores broad steering. */
  scope: SyncScope;
  /** Token budget for proactive model steering context. */
  budget: number;
  /** Also send a tiny model-visible ack on clean turns (default false: silent green). */
  ackClean: boolean;
  /** Total surprise — channel-adjusted cascade mass above the session heat
   * memory — that justifies proactive model steering on warmth alone.
   * Route and deletion signals always steer regardless. */
  steerThreshold: number;
  /** Push (default): red syncs embed a budgeted focus preview of the top drift
   * target. Pull: the update ends in a Next: advisory the model may follow. */
  pushFocus: boolean;
}

const GREP_MODES = ["off", "replace", "augment"] as const;
type GrepMode = (typeof GREP_MODES)[number];

interface FoveaToolsConfig {
  /** Budget applied when a fovea_* tool call omits maxTokens. */
  defaultBudget: number;
  /** Grep integration: "off" leaves pi's native grep untouched; "replace"
   * installs the takeover where bare symbol queries navigate the graph
   * instead of returning matching lines; "augment" (default) keeps native
   * grep always and appends a Fovea graph section to symbol-query results,
   * which also reaches pi.grep calls inside fabric_exec. */
  grepMode: GrepMode;
  /** Token budget for the graph section appended in augment mode. */
  grepAugmentBudget: number;
}

export interface FoveaConfig {
  sync: FoveaSyncConfig;
  tools: FoveaToolsConfig;
}

export const DEFAULT_FOVEA_CONFIG: FoveaConfig = {
  sync: {
    mode: "enabled",
    scope: "session",
    budget: 512,
    ackClean: false,
    // Masses are heat units leaked outside the changed files (1 unit seeded
    // per changed file), discounted by channel. Measured: a central fixture
    // semantic edit (tests/fixtures/mini server/users.go) totals ≈0.077
    // adjusted; a pair of weak shared-literal/co-change warm-ups ≈0.01–0.03;
    // one strong call/import neighbor on a 350-node repo ≈0.19.
    steerThreshold: 0.15,
    pushFocus: true,
  },
  tools: {
    defaultBudget: 512,
    grepMode: "augment",
    grepAugmentBudget: 512,
  },
};

export type FoveaConfigScope = "global" | "project";

export interface FoveaConfigScopes {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  /**
   * Explicit save scope from the settings UI (Ctrl+G). Defaults to project
   * when trusted, global otherwise; saveFoveaConfig rejects a project save
   * for an untrusted project.
   */
  scope?: FoveaConfigScope;
}

export const globalFoveaConfigPath = (agentDir: string): string => path.join(agentDir, "fovea.json");
export const projectFoveaConfigPath = (cwd: string): string => path.join(cwd, configDirName, "fovea.json");

const BOUNDS: Record<string, [number, number]> = {
  "sync.budget": [128, 8192],
  "tools.defaultBudget": [256, 16000],
  "tools.grepAugmentBudget": [256, 8192],
  "sync.steerThreshold": [0.02, 8],
};

const clamp = (id: string, value: number): number => {
  const [lo, hi] = BOUNDS[id] ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  return Math.min(hi, Math.max(lo, Math.round(value)));
};

const boolValue = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const enumValue = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  typeof value === "string" && values.includes(value as T) ? value as T : fallback;

const intValue = (id: string, value: unknown, fallback: number): number =>
  clamp(id, typeof value === "number" && Number.isFinite(value) ? value : fallback);

const floatValue = (id: string, value: unknown, fallback: number): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const [lo, hi] = BOUNDS[id] ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  return Math.min(hi, Math.max(lo, n));
};

const applyPartial = (base: FoveaConfig, partial: unknown): FoveaConfig => {
  if (typeof partial !== "object" || partial === null || Array.isArray(partial)) return base;
  const src = partial as Record<string, unknown>;
  const sync = (typeof src.sync === "object" && src.sync !== null ? src.sync : {}) as Record<string, unknown>;
  const tools = (typeof src.tools === "object" && src.tools !== null ? src.tools : {}) as Record<string, unknown>;
  return {
    sync: {
      // Legacy `enabled` booleans map to visible/disabled. An explicit mode wins.
      mode: enumValue(
        sync.mode,
        SYNC_MODES,
        typeof sync.enabled === "boolean" ? (sync.enabled ? "enabled" : "disabled") : base.sync.mode,
      ),
      scope: enumValue(sync.scope, SYNC_SCOPES, base.sync.scope),
      budget: intValue("sync.budget", sync.budget, base.sync.budget),
      ackClean: boolValue(sync.ackClean, base.sync.ackClean),
      steerThreshold: floatValue("sync.steerThreshold", sync.steerThreshold, base.sync.steerThreshold),
      pushFocus: boolValue(sync.pushFocus, base.sync.pushFocus),
    },
    tools: {
      defaultBudget: intValue("tools.defaultBudget", tools.defaultBudget, base.tools.defaultBudget),
      // Legacy `replaceGrep` (v0.10): true -> "replace", false -> "off". An
      // explicit `grepMode` always wins over the legacy key.
      grepMode: enumValue(
        tools.grepMode,
        GREP_MODES,
        typeof tools.replaceGrep === "boolean" ? (tools.replaceGrep ? "replace" : "off") : base.tools.grepMode,
      ),
      grepAugmentBudget: intValue("tools.grepAugmentBudget", tools.grepAugmentBudget, base.tools.grepAugmentBudget),
    },
  };
};

const readConfigFile = (file: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const resolveFoveaConfig = (
  scopes: FoveaConfigScopes,
  includeProject: boolean,
): FoveaConfig => {
  let config = applyPartial(DEFAULT_FOVEA_CONFIG, readConfigFile(globalFoveaConfigPath(scopes.agentDir)));
  if (includeProject) {
    config = applyPartial(config, readConfigFile(projectFoveaConfigPath(scopes.cwd)));
  }
  // Environment override mirrors pi-fabric's PI_* precedence over stored values.
  const off = process.env.FOVEA_TURN_SYNC;
  if (off === "off" || off === "0" || off === "false") config = { ...config, sync: { ...config.sync, mode: "disabled" } };
  return config;
};

export const loadFoveaConfigForScope = (
  scopes: FoveaConfigScopes,
  scope: FoveaConfigScope,
): FoveaConfig => {
  if (scope === "project" && !scopes.projectTrusted) {
    throw new Error("Cannot load project Fovea configuration for an untrusted project");
  }
  return resolveFoveaConfig(scopes, scope === "project");
};

export const loadFoveaConfig = (scopes: FoveaConfigScopes): FoveaConfig =>
  resolveFoveaConfig(scopes, scopes.projectTrusted);

const mergeDeep = (existing: Record<string, unknown>, partial: Record<string, unknown>): Record<string, unknown> => {
  const out = { ...existing };
  for (const [key, value] of Object.entries(partial)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)
        && typeof out[key] === "object" && out[key] !== null) {
      out[key] = mergeDeep(out[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
};

export const saveFoveaConfig = (
  scopes: FoveaConfigScopes,
  partial: Record<string, unknown>,
): { scope: FoveaConfigScope; path: string } => {
  const scope = scopes.scope ?? (scopes.projectTrusted ? "project" : "global");
  if (scope === "project" && !scopes.projectTrusted) {
    throw new Error("Cannot save project Fovea configuration for an untrusted project");
  }
  const targetPath = scope === "project"
    ? projectFoveaConfigPath(scopes.cwd)
    : globalFoveaConfigPath(scopes.agentDir);
  const merged = mergeDeep(readConfigFile(targetPath), partial);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(merged, null, 2) + "\n");
    fs.renameSync(tmp, targetPath);
  } finally {
    const written = fs.fstatSync(fd);
    fs.closeSync(fd);
    try {
      const current = fs.lstatSync(tmp);
      if (current.isFile() && current.dev === written.dev && current.ino === written.ino
        && current.uid === written.uid && current.size === written.size && current.mtimeMs === written.mtimeMs
        && current.ctimeMs === written.ctimeMs) fs.unlinkSync(tmp);
    } catch { /* our staging file may already have been renamed */ }
  }
  return { scope, path: targetPath };
};

/** Dotted-id helper used by the settings UI -> saveFoveaConfig partials. */
export const buildPartialFromId = (id: string, value: unknown): Record<string, unknown> => {
  const segments = id.split(".");
  const root: Record<string, unknown> = {};
  let current = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next: Record<string, unknown> = {};
    current[segments[i]!] = next;
    current = next;
  }
  current[segments[segments.length - 1]!] = value;
  return root;
};
