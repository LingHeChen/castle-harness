import { test, expect } from "bun:test";
import {
  parseImports,
  resolveSpecifier,
  buildImportGraph,
  transitiveImporters,
  importersOf,
  identityOwners,
  ownershipFromImports,
} from "./build/importgraph";
import { classifyPath, dependentsOfPath } from "./build/shared-edit";

test("parseImports catches from / bare / dynamic / require, and ignores comments", () => {
  const src = `
    import { a } from "./a";
    import "./side-effect";
    export { b } from "./b";
    const c = await import("./c");
    const d = require("./d");
    import ext from "leftpad";
    // import { z } from "./commented-out";
    /* export { y } from "./block-comment"; */
    const url = "http://example.com/not-a-comment"; import { e } from "./e";
  `;
  expect(parseImports(src).sort()).toEqual(["./a", "./b", "./c", "./d", "./e", "./side-effect", "leftpad"]);
});

test("resolveSpecifier resolves relative specifiers to repo files (ext + index), externals → null", () => {
  const files = new Set(["src/a.ts", "src/b/index.ts", "src/c.tsx"]);
  expect(resolveSpecifier("src/main.ts", "./a", files)).toBe("src/a.ts");
  expect(resolveSpecifier("src/main.ts", "./b", files)).toBe("src/b/index.ts"); // directory → index
  expect(resolveSpecifier("src/main.ts", "./c", files)).toBe("src/c.tsx");
  expect(resolveSpecifier("src/main.ts", "./a.ts", files)).toBe("src/a.ts"); // explicit ext
  expect(resolveSpecifier("src/nested/x.ts", "../a", files)).toBe("src/a.ts"); // parent-relative
  expect(resolveSpecifier("src/main.ts", "react", files)).toBeNull(); // external
  expect(resolveSpecifier("src/main.ts", "./missing", files)).toBeNull();
});

test("buildImportGraph keeps only intra-repo edges", () => {
  const g = buildImportGraph({
    "types.ts": `export type T = number;`,
    "store.ts": `import type { T } from "./types"; import _ from "lodash";`,
    "api.ts": `import { store } from "./store"; import { T } from "./types";`,
  });
  expect([...g.get("store.ts")!]).toEqual(["types.ts"]); // lodash dropped
  expect([...g.get("api.ts")!].sort()).toEqual(["store.ts", "types.ts"]);
  expect([...g.get("types.ts")!]).toEqual([]);
});

test("transitiveImporters is the reverse-transitive closure", () => {
  // types ← store ← api  (api imports store imports types)
  const g = buildImportGraph({
    "types.ts": ``,
    "store.ts": `import "./types";`,
    "api.ts": `import "./store";`,
  });
  expect(transitiveImporters(g).get("types.ts")).toEqual(["api.ts", "store.ts"]); // both, transitively
  expect(importersOf(g, "store.ts")).toEqual(["api.ts"]);
  expect(importersOf(g, "api.ts")).toEqual([]);
});

test("ownershipFromImports (identity owners) → file-level ripple that plugs into the coordinator", () => {
  const sources = {
    "types.ts": ``,
    "store.ts": `import "./types";`,
    "api.ts": `import "./store";`,
  };
  const g = buildImportGraph(sources);
  const own = ownershipFromImports(identityOwners(Object.keys(sources)), g);

  // types.ts is imported across boundaries → shared surface
  expect(own.shared.has("types.ts")).toBe(true);
  expect(own.shared.has("api.ts")).toBe(false); // nothing imports the leaf

  // the SAME functions the shared-edit guard/coordinator use now work on real imports:
  // editing types.ts (owned by "types.ts") ripples to everything that imports it.
  expect(dependentsOfPath(own, "types.ts")).toEqual(["api.ts", "store.ts"]);
  // an agent that doesn't own types.ts writing it is classified "shared" → coordinated
  expect(classifyPath(own, "api.ts", "types.ts")).toEqual({ kind: "shared", owner: "types.ts", contract: true });
  // the file's own owner writing it is fine
  expect(classifyPath(own, "types.ts", "types.ts")).toEqual({ kind: "own" });
});

test("ownershipFromImports (task owners) → task-level dependents via real edges", () => {
  // a change set: task 'model' owns types.ts + store.ts; task 'http' owns api.ts
  const sources = {
    "types.ts": ``,
    "store.ts": `import "./types";`,
    "api.ts": `import "./store";`,
  };
  const g = buildImportGraph(sources);
  const owners = new Map([
    ["types.ts", "model"],
    ["store.ts", "model"],
    ["api.ts", "http"],
  ]);
  const own = ownershipFromImports(owners, g);

  // store.ts is imported by api.ts (owned by 'http') → cross-boundary shared; types.ts is
  // only imported within 'model' → NOT a shared boundary.
  expect(own.shared.has("store.ts")).toBe(true);
  expect(own.shared.has("types.ts")).toBe(false);

  // changing anything 'model' owns ripples to 'http'; 'http' has no dependents
  expect(own.dependents.get("model")).toEqual(["http"]);
  expect(own.dependents.get("http")).toEqual([]);
  expect(dependentsOfPath(own, "store.ts")).toEqual(["http"]);
});
