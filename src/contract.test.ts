import { test, expect } from "bun:test";
import { applyContracts } from "./build/contract";
import { toWaves } from "./build/graph";
import type { ContractPlan, Task } from "./build/schemas";

const feat = (id: string, files: string[], dependsOn: string[] = []): Task => ({
  id,
  title: id,
  description: id,
  acceptanceCriteria: ["ok"],
  files,
  dependsOn,
  kind: "feature",
});

test("contracts become wave-0 tasks that consumers depend on", () => {
  const tasks = [feat("order", ["order.ts", "types.ts"]), feat("cart", ["cart.ts", "types.ts"])];
  const plan: ContractPlan = {
    contracts: [{ id: "types", title: "Shared types", description: "d", acceptanceCriteria: ["types exist"], files: ["types.ts"], consumers: ["order", "cart"] }],
  };
  const result = applyContracts(tasks, plan);

  const types = result.find((t) => t.id === "types")!;
  expect(types.kind).toBe("contract");
  expect(types.dependsOn).toEqual([]); // frozen first, no prerequisites

  // consumers now depend on the contract...
  expect(result.find((t) => t.id === "order")!.dependsOn).toContain("types");
  expect(result.find((t) => t.id === "cart")!.dependsOn).toContain("types");

  // ...and the contract lands in the earliest wave.
  const waves = toWaves(result);
  expect(waves[0]!.map((t) => t.id)).toEqual(["types"]);
});

test("the contract is the SOLE owner of its files (stripped from features)", () => {
  const tasks = [feat("order", ["order.ts", "types.ts"]), feat("cart", ["cart.ts", "types.ts"])];
  const plan: ContractPlan = {
    contracts: [{ id: "types", title: "t", description: "d", acceptanceCriteria: ["ok"], files: ["types.ts"], consumers: ["order", "cart"] }],
  };
  const result = applyContracts(tasks, plan);

  expect(result.find((t) => t.id === "order")!.files).toEqual(["order.ts"]);
  expect(result.find((t) => t.id === "cart")!.files).toEqual(["cart.ts"]);
  expect(result.find((t) => t.id === "types")!.files).toEqual(["types.ts"]);

  // every file has exactly one owner
  const owners = new Map<string, number>();
  for (const t of result) for (const f of t.files) owners.set(f, (owners.get(f) ?? 0) + 1);
  expect([...owners.values()].every((n) => n === 1)).toBe(true);
});

test("dangling consumer references are ignored", () => {
  const tasks = [feat("order", ["order.ts", "types.ts"])];
  const plan: ContractPlan = {
    contracts: [{ id: "types", title: "t", description: "d", acceptanceCriteria: ["ok"], files: ["types.ts"], consumers: ["order", "ghost"] }],
  };
  const result = applyContracts(tasks, plan);
  expect(result.find((t) => t.id === "order")!.dependsOn).toEqual(["types"]);
  expect(result.find((t) => t.id === "ghost")).toBeUndefined();
});

test("a contract id colliding with a feature id is uniquified", () => {
  const tasks = [feat("types", ["types-impl.ts", "shared.ts"])];
  const plan: ContractPlan = {
    contracts: [{ id: "types", title: "t", description: "d", acceptanceCriteria: ["ok"], files: ["shared.ts"], consumers: ["types"] }],
  };
  const result = applyContracts(tasks, plan);
  const ids = result.map((t) => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(result.some((t) => t.kind === "contract" && t.id !== "types")).toBe(true);
});

test("two contracts cannot claim the same file — first one wins", () => {
  const tasks = [feat("a", ["a.ts", "shared.ts"]), feat("b", ["b.ts"])];
  const plan: ContractPlan = {
    contracts: [
      { id: "c1", title: "c1", description: "d", acceptanceCriteria: ["ok"], files: ["shared.ts"], consumers: ["a"] },
      { id: "c2", title: "c2", description: "d", acceptanceCriteria: ["ok"], files: ["shared.ts"], consumers: ["b"] },
    ],
  };
  const result = applyContracts(tasks, plan);
  expect(result.find((t) => t.id === "c1")!.files).toEqual(["shared.ts"]);
  // c2 had nothing left to own → dropped entirely
  expect(result.find((t) => t.id === "c2")).toBeUndefined();
});

test("empty contract plan is a no-op", () => {
  const tasks = [feat("a", ["a.ts"]), feat("b", ["b.ts"])];
  expect(applyContracts(tasks, { contracts: [] })).toEqual(tasks);
});
