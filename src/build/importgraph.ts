import { dirname, join } from "node:path";
import { normPath, type Ownership } from "./shared-edit";

/**
 * The bridge to existing codebases.
 *
 * Greenfield decomposition *invents* the dependency graph: the model declares each
 * task's files and `dependsOn`. But an existing repo already HAS its graph — in the
 * import edges between files. So for brownfield we don't invent it, we **extract**
 * it, and feed it into the exact same shared-edit machinery: the ownership map, the
 * transitive dependents, the ripple. Nothing downstream changes; only the source of
 * the graph does (model-declared → statically-extracted).
 *
 * This is a lightweight *lexical* import extractor, not a full TS parser — it reads
 * `import … from`, bare `import`, dynamic `import()`, and `require()` specifiers and
 * resolves the relative ones to repo files. Path aliases and re-export gymnastics
 * are out of scope (they degrade to "edge not found", never a wrong edge).
 */

export type ImportGraph = Map<string, Set<string>>; // file → the repo files it imports

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Extract every module specifier a source file references (deduped, in first-seen order). */
export function parseImports(source: string): string[] {
  const src = stripComments(source);
  const spec = `['"]([^'"\\n]+)['"]`;
  const patterns = [
    new RegExp(`\\bfrom\\s+${spec}`, "g"), // import … from "x"  /  export … from "x"
    new RegExp(`\\bimport\\s+${spec}`, "g"), // side-effect: import "x"
    new RegExp(`\\bimport\\s*\\(\\s*${spec}`, "g"), // dynamic: import("x")
    new RegExp(`\\brequire\\s*\\(\\s*${spec}`, "g"), // cjs: require("x")
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const s = m[1]!;
      if (!seen.has(s)) (seen.add(s), out.push(s));
    }
  }
  return out;
}

/**
 * Resolve a specifier imported *from* `fromFile` to a repo-relative file path, or
 * null if it's external (a bare package) or can't be resolved to a known file.
 */
export function resolveSpecifier(fromFile: string, specifier: string, files: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null; // bare package / alias → external
  const base = normPath(join(dirname(normPath(fromFile)), specifier));
  for (const ext of RESOLVE_EXTS) {
    const cand = normPath(base + ext);
    if (files.has(cand)) return cand;
  }
  for (const ext of RESOLVE_EXTS.slice(1)) {
    const cand = normPath(join(base, "index" + ext));
    if (files.has(cand)) return cand;
  }
  return null;
}

/** Build the intra-repo import graph from a map of repo file → source text. */
export function buildImportGraph(sources: Record<string, string> | Map<string, string>): ImportGraph {
  const entries = sources instanceof Map ? [...sources] : Object.entries(sources);
  const files = new Set(entries.map(([f]) => normPath(f)));
  const graph: ImportGraph = new Map();
  for (const f of files) graph.set(f, new Set());
  for (const [rawFile, source] of entries) {
    const file = normPath(rawFile);
    for (const spec of parseImports(source)) {
      const target = resolveSpecifier(file, spec, files);
      if (target && target !== file) graph.get(file)!.add(target);
    }
  }
  return graph;
}

/**
 * For each file, the transitive set of files that (directly or indirectly) import
 * it — i.e. everything that must be re-verified if that file changes. This is the
 * reverse-transitive closure of the import graph.
 */
export function transitiveImporters(graph: ImportGraph): Map<string, string[]> {
  const rev = new Map<string, Set<string>>(); // imported → direct importers
  for (const f of graph.keys()) rev.set(f, new Set());
  for (const [importer, imported] of graph) {
    for (const dep of imported) (rev.get(dep) ?? rev.set(dep, new Set()).get(dep)!).add(importer);
  }
  const out = new Map<string, string[]>();
  for (const f of graph.keys()) {
    const seen = new Set<string>();
    const stack = [...(rev.get(f) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of rev.get(cur) ?? []) stack.push(next);
    }
    out.set(f, [...seen].sort());
  }
  return out;
}

/** All files that transitively import `file` (who breaks if it changes). */
export function importersOf(graph: ImportGraph, file: string): string[] {
  return transitiveImporters(graph).get(normPath(file)) ?? [];
}

/**
 * Remove `//` line and block comments while preserving string/template literals
 * (so a `"http://…"` URL inside a string doesn't get truncated as a comment, and
 * the specifiers we need to extract stay intact). A small char-level state machine.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let quote = ""; // current string delimiter: ' " `  (empty = not in a string)
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        if (i + 1 < n) out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = "";
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Map each repo file to a pseudo-owner equal to itself — for a repo with no task plan yet. */
export function identityOwners(files: Iterable<string>): Map<string, string> {
  return new Map([...files].map((f) => [normPath(f), normPath(f)]));
}

/**
 * Produce the standard {@link Ownership} — the very structure the shared-edit
 * coordinator consumes — from a real import graph plus a file→owner mapping.
 *
 * The task-level dependents are computed through the *actual* import edges: if a
 * file owned by task A imports a file owned by task B, then A depends on B, so a
 * change to B's file ripples to A. A file is "shared" when something owned by a
 * different owner imports it (cross-boundary surface). Pass {@link identityOwners}
 * to treat every file as its own owner (pure file-level ripple, no task plan).
 */
export function ownershipFromImports(fileOwners: Map<string, string>, graph: ImportGraph): Ownership {
  const owner = new Map([...fileOwners].map(([f, o]) => [normPath(f), o]));
  const shared = new Set<string>();
  const taskRev = new Map<string, Set<string>>(); // ownerB → owners that depend on B

  for (const [importerFile, importedFiles] of graph) {
    const importerOwner = owner.get(normPath(importerFile));
    for (const importedFile of importedFiles) {
      const importedOwner = owner.get(normPath(importedFile));
      if (importedOwner === undefined || importerOwner === undefined) continue;
      if (importerOwner === importedOwner) continue; // same owner → not a shared boundary
      shared.add(normPath(importedFile));
      (taskRev.get(importedOwner) ?? taskRev.set(importedOwner, new Set()).get(importedOwner)!).add(importerOwner);
    }
  }

  // transitive closure over owner-level reverse edges
  const dependents = new Map<string, string[]>();
  for (const o of new Set(owner.values())) {
    const seen = new Set<string>();
    const stack = [...(taskRev.get(o) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of taskRev.get(cur) ?? []) stack.push(next);
    }
    dependents.set(o, [...seen].sort());
  }

  return { owner, shared, dependents };
}
