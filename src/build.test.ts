import { test, expect } from "bun:test";
import { toWaves } from "./build/graph";
import type { Task } from "./build/schemas";

function task(id: string, dependsOn: string[] = []): Task {
  return { id, title: id, description: "", acceptanceCriteria: ["c"], dependsOn, files: [`${id}.ts`] };
}

test("independent tasks land in one parallel wave", () => {
  const waves = toWaves([task("a"), task("b"), task("c")]);
  expect(waves).toHaveLength(1);
  expect(waves[0]!.map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
});

test("dependencies produce ordered waves", () => {
  const waves = toWaves([task("a"), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])]);
  expect(waves.map((w) => w.map((t) => t.id).sort())).toEqual([["a"], ["b", "c"], ["d"]]);
});

test("cycles are rejected", () => {
  expect(() => toWaves([task("a", ["b"]), task("b", ["a"])])).toThrow(/cycle/);
});

test("unknown dependencies are rejected", () => {
  expect(() => toWaves([task("a", ["ghost"])])).toThrow(/unknown/);
});
