// Per-repo, per-conversation state. Disclosure belongs to one focus key:
// repeated focus preserves its seed/direct nucleus and suppresses seen
// periphery, while a new seed/scope resets to sharp context. Cached Chebyshev
// vectors keep dwell cheap across wider timescales within that focus.

import { isAbsolute, relative, resolve, sep } from "node:path";
import { ROOT_CACHE_LIMIT } from "./asyncutil.js";
import type { NodeKind } from "./types.js";

interface FocusScope {
  path?: string;
  language?: string;
  kind?: NodeKind;
}

export interface FoveaSession {
  root: string;
  t: number;
  seeds: number[];
  seedNote: string;
  /** Ordered weighted graph generation that owns seeds and Chebyshev vectors. */
  generation: string;
  focusKey: string;
  scope: FocusScope;
  disclosed: Set<string>;
  /** Top-level logical directories/files this conversation deliberately entered. */
  syncScopes: Set<string>;
  tk: Float64Array[];
  tkKey: string;
}

export const FOCUS_T0 = 2;

const sessions = new Map<string, FoveaSession>();

export const getSession = (root: string): FoveaSession => {
  const hit = sessions.get(root);
  if (hit) {
    sessions.delete(root);
    sessions.set(root, hit);
    return hit;
  }
  const s: FoveaSession = {
    root,
    t: FOCUS_T0,
    seeds: [],
    seedNote: "",
    generation: "",
    focusKey: "",
    scope: {},
    disclosed: new Set<string>(),
    syncScopes: new Set<string>(),
    tk: [],
    tkKey: "",
  };
  sessions.set(root, s);
  while (sessions.size > ROOT_CACHE_LIMIT) {
    const oldest = sessions.keys().next().value!;
    sessions.delete(oldest);
  }
  return s;
};

const repoRelativePath = (root: string, input: string): string | undefined => {
  const raw = input.startsWith("@") ? input.slice(1) : input;
  const rel = relative(resolve(root), resolve(root, raw));
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
};

/** A shared-root session treats each top-level child as a logical workspace.
 * Root files remain exact scopes, while any descendant maps to its first path
 * segment. This keeps umbrella indexing broad without letting sibling task
 * directories enter the active conversation. */
export const syncScopeForPath = (root: string, input: string): string | undefined => {
  const rel = repoRelativePath(root, input);
  if (!rel) return undefined;
  const slash = rel.indexOf("/");
  return slash < 0 ? rel : rel.slice(0, slash);
};

export const observeSessionPaths = (root: string, paths: readonly string[]): string[] => {
  const session = getSession(root);
  for (const path of paths) {
    const scope = syncScopeForPath(root, path);
    if (scope) session.syncScopes.add(scope);
  }
  return [...session.syncScopes].sort();
};

/** Drop index-addressed focus state while preserving session attention. */
export const clearSessionFocus = (session: FoveaSession): void => {
  session.t = FOCUS_T0;
  session.seeds = [];
  session.seedNote = "";
  session.generation = "";
  session.focusKey = "";
  session.scope = {};
  session.disclosed.clear();
  session.tk = [];
  session.tkKey = "";
};

// `/new` and friends: same repo, fresh eyes.
export const resetSessions = (): void => {
  // A fresh conversation cannot reuse disclosure or Chebyshev vectors; drop
  // the entries outright so large Float64Array stacks become collectible.
  sessions.clear();
};
