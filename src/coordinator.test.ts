import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedEditCoordinator } from "./build/coordinator";
import { buildOwnership } from "./build/shared-edit";
import type { BuildEvent } from "./build/events";
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

// types (contract) ← order ← cart
const plan: Task[] = [
  task("types", ["types.ts"], [], "contract"),
  task("order", ["order.ts"], ["types"]),
  task("cart", ["cart.ts"], ["order"]),
];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "castle-coord-"));
  const events: BuildEvent[] = [];
  const coord = new SharedEditCoordinator(buildOwnership(plan), (e) => events.push(e));
  return { dir, events, coord };
}

test("own and new writes are allowed (not intercepted)", async () => {
  const { dir, coord } = setup();
  const guard = coord.guardFor("order", dir);
  expect(await guard({ op: "write", path: "order.ts", content: "x" })).toEqual({ type: "allow" });
  expect(await guard({ op: "write", path: "order.helper.ts", content: "x" })).toEqual({ type: "allow" });
});

test("a write to a contract file is handled: applied, event emitted, ripple recorded", async () => {
  const { dir, events, coord } = setup();
  const guard = coord.guardFor("order", dir);

  const decision = await guard({ op: "write", path: "types.ts", content: "export type Order = { id: string };\n" });
  expect(decision.type).toBe("handled");

  // applied to the requesting worktree
  expect(await Bun.file(join(dir, "types.ts")).text()).toBe("export type Order = { id: string };\n");

  // emitted a shared-edit event naming the owner and the dependents to re-verify
  const ev = events.find((e) => e.type === "shared-edit")! as Extract<BuildEvent, { type: "shared-edit" }>;
  expect(ev.owner).toBe("types");
  expect(ev.file).toBe("types.ts");
  expect(ev.dependents).toEqual(["cart"]); // transitive dependents of types, minus the editor (order)

  // recorded for the wave's ripple
  expect(coord.touchedFiles()).toEqual(["types.ts"]);
  expect([...coord.dependentsToVerify()].sort()).toEqual(["cart", "order"]);
});

test("edit op computes after-text from disk and classifies magnitude", async () => {
  const { dir, events, coord } = setup();
  const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  await Bun.write(join(dir, "types.ts"), body);
  const guard = coord.guardFor("cart", dir);

  await guard({ op: "edit", path: "types.ts", old_string: "line 5", new_string: "line FIVE" });
  expect((await Bun.file(join(dir, "types.ts")).text()).includes("line FIVE")).toBe(true);
  const ev = events.find((e) => e.type === "shared-edit")! as Extract<BuildEvent, { type: "shared-edit" }>;
  expect(ev.size).toBe("small"); // one line touched out of twenty
});

test("drainTouched resets the per-wave record (read dependents BEFORE draining)", async () => {
  const { dir, coord } = setup();
  const guard = coord.guardFor("order", dir);
  await guard({ op: "write", path: "types.ts", content: "a" });
  // dependents must be read before drain — drain wipes the touched record
  expect([...coord.dependentsToVerify()].sort()).toEqual(["cart", "order"]);
  expect(coord.drainTouched().size).toBe(1);
  expect(coord.touchedFiles()).toEqual([]); // cleared
  expect([...coord.dependentsToVerify()]).toEqual([]); // nothing left after drain
});

test("concurrent shared edits are serialized (no lost updates)", async () => {
  const { dir, coord } = setup();
  await Bun.write(join(dir, "types.ts"), "start");
  const guard = coord.guardFor("cart", dir);

  // Each edit inserts a line right after "start". applyShared reads the CURRENT
  // file, so if two ran interleaved one would clobber the other and we'd lose
  // lines. Serialized → every insertion sees the previous one.
  const N = 8;
  await Promise.all(
    Array.from({ length: N }, (_, i) => guard({ op: "edit", path: "types.ts", old_string: "start", new_string: `start\nline-${i}` })),
  );

  const lines = (await Bun.file(join(dir, "types.ts")).text()).split("\n");
  expect(lines).toHaveLength(N + 1); // "start" + N inserted lines, none lost
  expect(lines[0]).toBe("start");
});
