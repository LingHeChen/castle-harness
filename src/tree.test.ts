import { test, expect } from "bun:test";
import { buildTaskTree, leavesOf, countNodes, type TaskNode, type ExpandFn } from "./build/tree";
import { assembleTasks } from "./build/decompose";
import { toWaves } from "./build/graph";
import type { DecomposeStep } from "./build/schemas";

// Fake expander: a canned plan keyed by node title, so recursion is exercised
// deterministically with no model.
const plan: Record<string, DecomposeStep> = {
  root: { atomic: false, acceptanceCriteria: [], files: [], subtasks: [
    { id: "api", title: "API", description: "the api" },
    { id: "ui", title: "UI", description: "the ui" },
  ] },
  API: { atomic: false, acceptanceCriteria: [], files: [], subtasks: [
    { id: "routes", title: "routes", description: "routes" },
    { id: "db", title: "db", description: "db" },
  ] },
  UI: { atomic: true, acceptanceCriteria: ["renders"], files: ["ui.ts"], subtasks: [] },
  routes: { atomic: true, acceptanceCriteria: ["200 ok"], files: ["routes.ts"], subtasks: [] },
  db: { atomic: true, acceptanceCriteria: ["persists"], files: ["db.ts"], subtasks: [] },
};
const fakeExpand: ExpandFn = async (n) => plan[n.title] ?? { atomic: true, acceptanceCriteria: ["done"], files: [`${n.id}.ts`], subtasks: [] };

function buildFixture(maxDepth = 5): Promise<TaskNode> {
  return buildTaskTree({ id: "root", title: "root", description: "g" }, fakeExpand, maxDepth);
}

test("recursion expands to leaves and prefixes ids by parent", async () => {
  const tree = await buildFixture();
  expect(leavesOf(tree).map((l) => l.id).sort()).toEqual(["root-api-db", "root-api-routes", "root-ui"]);
  expect(countNodes(tree)).toBe(5); // root, root-api, root-api-routes, root-api-db, root-ui
});

test("leaves carry acceptance criteria and files; groups don't", async () => {
  const tree = await buildFixture();
  const ui = leavesOf(tree).find((l) => l.id === "root-ui")!;
  expect(ui.acceptanceCriteria).toEqual(["renders"]);
  expect(ui.files).toEqual(["ui.ts"]);
  expect(tree.acceptanceCriteria).toEqual([]); // root is a group
});

test("maxDepth forces a node to become a leaf even if it would split", async () => {
  const tree = await buildFixture(1);
  expect(leavesOf(tree).map((l) => l.id).sort()).toEqual(["root-api", "root-ui"]);
});

test("colliding subtask ids are made unique", async () => {
  const collide: ExpandFn = async (n) =>
    n.depth === 0
      ? { atomic: false, acceptanceCriteria: [], files: [], subtasks: [
          { id: "x", title: "x", description: "" },
          { id: "x", title: "x", description: "" },
        ] }
      : { atomic: true, acceptanceCriteria: ["ok"], files: [], subtasks: [] };
  const ids = leavesOf(await buildTaskTree({ id: "root", title: "root", description: "" }, collide, 3)).map((l) => l.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("assembleTasks drops invalid/self deps, applies fallback criteria, and feeds toWaves", async () => {
  const leaves = leavesOf(await buildFixture());
  const depMap = new Map<string, string[]>([
    ["root-api-db", ["ghost", "root-api-db"]], // invalid + self → dropped
    ["root-api-routes", ["root-api-db"]], // valid
  ]);
  const tasks = assembleTasks(leaves, depMap);

  const db = tasks.find((t) => t.id === "root-api-db")!;
  expect(db.dependsOn).toEqual([]); // ghost + self stripped
  expect(tasks.find((t) => t.id === "root-api-routes")!.dependsOn).toEqual(["root-api-db"]);

  const waves = toWaves(tasks);
  expect(waves.length).toBeGreaterThanOrEqual(2); // routes depends on db → at least 2 waves
});
