import { normalize } from "node:path";
import type { SharedEditSize } from "./events";
import type { Task } from "./schemas";

/**
 * The shared-edit protocol — the pure core.
 *
 * castle's parallel development assumes each task owns a disjoint set of files.
 * Contract-first makes that true for the shared surface (a contract task is the
 * sole owner of its files). This module is the seam that *enforces* single
 * ownership at build time: given the plan, it answers "who owns this path?", "is
 * this dev agent allowed to write it directly?", and "if this shared file changes,
 * whose code must be re-verified?". The stateful coordination (serialize the
 * write, apply it, drive the ripple) lives in SharedEditCoordinator; everything
 * here is a pure function so it can be reasoned about and tested in isolation.
 */

export type Ownership = {
  /** file (normalized) → the id of the single task that owns it */
  owner: Map<string, string>;
  /** files owned by a contract task — shared surface, off-limits to raw edits */
  shared: Set<string>;
  /** taskId → its transitive dependents (tasks that must be re-verified if it changes) */
  dependents: Map<string, string[]>;
};

/** How a dev agent's write to a path is classified against the ownership map. */
export type PathClass =
  | { kind: "own" } // the writing task owns this file — allow the raw write
  | { kind: "new" } // nobody owns it yet — allow (the task is creating a new file)
  | { kind: "shared"; owner: string; contract: boolean }; // owned by someone else — coordinate

/** Normalize a path so "./a/b.ts", "a/b.ts" and "a//b.ts" compare equal. */
export function normPath(p: string): string {
  return normalize(p).replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Build the ownership map from the planned tasks. Every declared file maps to the
 * single task that declared it; contract-owned files are also flagged shared.
 * (After {@link applyContracts}, files have exactly one owner, so the last-writer
 * fallback here only matters for a hand-edited plan with an accidental overlap —
 * we keep it deterministic: first declarer wins.)
 */
export function buildOwnership(tasks: Task[]): Ownership {
  const owner = new Map<string, string>();
  const shared = new Set<string>();
  for (const t of tasks) {
    for (const f of t.files) {
      const p = normPath(f);
      if (!owner.has(p)) owner.set(p, t.id); // first declarer wins → deterministic
      if (t.kind === "contract") shared.add(p);
    }
  }
  return { owner, shared, dependents: transitiveDependents(tasks) };
}

/** Classify a write to `path` by the task `taskId`, against the ownership map. */
export function classifyPath(own: Ownership, taskId: string, path: string): PathClass {
  const p = normPath(path);
  const holder = own.owner.get(p);
  if (holder === undefined) return { kind: "new" };
  if (holder === taskId) return { kind: "own" };
  return { kind: "shared", owner: holder, contract: own.shared.has(p) };
}

/**
 * The tasks that must be re-verified when `path` changes: the transitive
 * dependents of whoever owns it (a task importing the changed file, or importing
 * something that does). Excludes the owner itself.
 */
export function dependentsOfPath(own: Ownership, path: string): string[] {
  const holder = own.owner.get(normPath(path));
  if (holder === undefined) return [];
  return own.dependents.get(holder) ?? [];
}

/**
 * Classify the magnitude of a shared change from its before/after text — a
 * first-pass placement on the coordination spectrum at interception time. A
 * "break" is only *confirmed* later, when a dependent's acceptance actually fails
 * during the ripple; here we distinguish a trivial tweak (auto-merge) from a
 * change big enough that dependents should be re-verified, from a rewrite large
 * enough to consider replanning.
 */
export function editMagnitude(before: string, after: string): SharedEditSize {
  const changed = lineDiffCount(before, after);
  const total = Math.max(splitLines(before).length, splitLines(after).length, 1);
  const ratio = changed / total;
  if (changed === 0) return "small";
  if (changed <= 3 && ratio < 0.25) return "small";
  if (changed >= 40 || ratio >= 0.75) return "large";
  return "medium";
}

/** Number of lines that differ between two texts (added + removed), order-insensitive. */
function lineDiffCount(before: string, after: string): number {
  const b = bag(splitLines(before));
  const a = bag(splitLines(after));
  let diff = 0;
  for (const [line, n] of a) diff += Math.max(0, n - (b.get(line) ?? 0));
  for (const [line, n] of b) diff += Math.max(0, n - (a.get(line) ?? 0));
  return diff;
}

function bag(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

function splitLines(text: string): string[] {
  return text.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

/** taskId → all tasks that (transitively) depend on it, in stable id order. */
function transitiveDependents(tasks: Task[]): Map<string, string[]> {
  // direct reverse edges: dep -> [tasks that depend on dep]
  const rev = new Map<string, Set<string>>();
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      (rev.get(d) ?? rev.set(d, new Set()).get(d)!).add(t.id);
    }
  }
  const out = new Map<string, string[]>();
  for (const t of tasks) {
    const seen = new Set<string>();
    const stack = [...(rev.get(t.id) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of rev.get(cur) ?? []) stack.push(next);
    }
    out.set(t.id, [...seen].sort());
  }
  return out;
}
