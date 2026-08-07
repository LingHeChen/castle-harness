import { test, expect } from "bun:test";
import { buildOwnership, classifyPath, dependentsOfPath, editMagnitude, normPath } from "./build/shared-edit";
import type { Task } from "./build/schemas";

const task = (id: string, files: string[], dependsOn: string[] = [], kind: "contract" | "feature" = "feature"): Task => ({
  id,
  title: id,
  description: id,
  acceptanceCriteria: ["ok"],
  files,
  dependsOn,
  kind,
});

// order (contract) ← cart, checkout ← report
const plan: Task[] = [
  task("order", ["order.ts"], [], "contract"),
  task("cart", ["cart.ts"], ["order"]),
  task("checkout", ["checkout.ts"], ["order"]),
  task("report", ["report.ts"], ["checkout"]),
];

test("normPath makes equivalent paths compare equal", () => {
  expect(normPath("./a/b.ts")).toBe("a/b.ts");
  expect(normPath("a//b.ts")).toBe("a/b.ts");
  expect(normPath("/a/b.ts")).toBe("a/b.ts");
});

test("buildOwnership maps each file to one owner and flags contract files shared", () => {
  const own = buildOwnership(plan);
  expect(own.owner.get("order.ts")).toBe("order");
  expect(own.owner.get("cart.ts")).toBe("cart");
  expect(own.shared.has("order.ts")).toBe(true);
  expect(own.shared.has("cart.ts")).toBe(false);
});

test("classifyPath distinguishes own / new / shared, and marks contract files", () => {
  const own = buildOwnership(plan);
  expect(classifyPath(own, "cart", "cart.ts")).toEqual({ kind: "own" });
  expect(classifyPath(own, "cart", "brand-new.ts")).toEqual({ kind: "new" });
  expect(classifyPath(own, "cart", "order.ts")).toEqual({ kind: "shared", owner: "order", contract: true });
  // a non-contract file owned by another task is still "shared" (coordinate), just not a contract
  expect(classifyPath(own, "cart", "checkout.ts")).toEqual({ kind: "shared", owner: "checkout", contract: false });
});

test("dependentsOfPath returns the transitive dependents that must be re-verified", () => {
  const own = buildOwnership(plan);
  // everything depends (transitively) on the order contract
  expect(dependentsOfPath(own, "order.ts")).toEqual(["cart", "checkout", "report"]);
  // report depends on checkout → changing checkout ripples to report only
  expect(dependentsOfPath(own, "checkout.ts")).toEqual(["report"]);
  // report has no dependents
  expect(dependentsOfPath(own, "report.ts")).toEqual([]);
  // an unowned path has no dependents
  expect(dependentsOfPath(own, "nope.ts")).toEqual([]);
});

test("editMagnitude places a change on the spectrum", () => {
  const base = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  expect(editMagnitude(base, base)).toBe("small"); // identical
  expect(editMagnitude(base, base + "\nline 20")).toBe("small"); // one line added
  const medium = base.split("\n").map((l, i) => (i < 6 ? l + " // touched" : l)).join("\n");
  expect(editMagnitude(base, medium)).toBe("medium");
  const large = Array.from({ length: 20 }, (_, i) => `totally different ${i}`).join("\n");
  expect(editMagnitude(base, large)).toBe("large"); // full rewrite
});

test("editMagnitude is order-insensitive for reordered lines of equal size", () => {
  const a = "a\nb\nc";
  const b = "c\nb\na";
  expect(editMagnitude(a, b)).toBe("small"); // same bag of lines → no diff
});
