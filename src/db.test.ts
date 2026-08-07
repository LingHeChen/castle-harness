import { test, expect } from "bun:test";
import { SqliteBuildStore } from "./build/db";
import type { BuildRecord } from "./build/store";
import type { Task } from "./build/schemas";

const task = (id: string, kind: "contract" | "feature" = "feature", dependsOn: string[] = []): Task => ({
  id,
  title: `任务 ${id}`,
  description: `desc ${id}`,
  acceptanceCriteria: ["ok"],
  files: [`${id}.ts`],
  dependsOn,
  kind,
});

function store() {
  return new SqliteBuildStore(":memory:");
}

test("a build round-trips with its id, intent, tree, outcomes", () => {
  const s = store();
  const rec: BuildRecord = {
    id: "bld-1",
    createdAt: 1000,
    goal: "一个 todo 微服务",
    intent: "expanded",
    tree: { id: "root", title: "root", leaf: false, children: [] },
    outcomes: [{ id: "api", passed: true, attempts: 0, detail: "ok" }],
  };
  s.saveBuild(rec);

  const got = s.getBuild("bld-1")!;
  expect(got.id).toBe("bld-1");
  expect(got.goal).toBe("一个 todo 微服务");
  expect(got.intent).toBe("expanded");
  expect(got.tree?.id).toBe("root");
  expect(got.outcomes?.[0]).toEqual({ id: "api", passed: true, attempts: 0, detail: "ok" });
  s.close();
});

test("every task is stored with its id, kind, deps and files", () => {
  const s = store();
  s.saveBuild({ id: "bld-2", createdAt: 1, goal: "g" });
  s.saveTasks("bld-2", [task("types", "contract"), task("api", "feature", ["types"])]);

  const tasks = s.getTasks("bld-2");
  expect(tasks.map((t) => t.id).sort()).toEqual(["api", "types"]);
  const types = tasks.find((t) => t.id === "types")!;
  expect(types.kind).toBe("contract");
  expect(tasks.find((t) => t.id === "api")!.dependsOn).toEqual(["types"]);
  expect(tasks.find((t) => t.id === "api")!.files).toEqual(["api.ts"]);
  // acceptanceCriteria round-trips — resume reloads the full plan from here.
  expect(types.acceptanceCriteria).toEqual(["ok"]);
  s.close();
});

test("saveBuild persists nested tasks and getBuild rehydrates them", () => {
  const s = store();
  s.saveBuild({ id: "bld-3", createdAt: 1, goal: "g", tasks: [task("a"), task("b", "feature", ["a"])] });
  expect(s.getBuild("bld-3")!.tasks?.map((t) => t.id).sort()).toEqual(["a", "b"]);
  s.close();
});

test("saveBuild upserts (id is the key) and saveTasks is idempotent", () => {
  const s = store();
  s.saveBuild({ id: "bld-4", createdAt: 1, goal: "first" });
  s.saveBuild({ id: "bld-4", createdAt: 1, goal: "second", intent: "now set" });
  expect(s.getBuild("bld-4")!.goal).toBe("second");
  expect(s.getBuild("bld-4")!.intent).toBe("now set");

  s.saveTasks("bld-4", [task("x")]);
  s.saveTasks("bld-4", [task("x"), task("y")]); // re-save, no duplicate rows
  expect(s.getTasks("bld-4").map((t) => t.id).sort()).toEqual(["x", "y"]);
  s.close();
});

test("listBuilds returns newest first", () => {
  const s = store();
  s.saveBuild({ id: "old", createdAt: 100, goal: "a" });
  s.saveBuild({ id: "new", createdAt: 200, goal: "b" });
  expect(s.listBuilds().map((b) => b.id)).toEqual(["new", "old"]);
  s.close();
});
