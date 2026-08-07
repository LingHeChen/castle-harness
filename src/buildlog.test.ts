import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildLog } from "./build/store";
import type { BuildEmit, BuildEvent } from "./build/events";

test("tee forwards each event downstream exactly once and logs it to disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "castle-log-"));
  const log = new BuildLog(dir, "bld-x");
  const seen: BuildEvent[] = [];
  const emit = log.tee((ev) => seen.push(ev));

  emit({ type: "phase", n: 1, title: "understand" });
  emit({ type: "log", message: "hi" });
  emit({ type: "done" });
  log.close();

  // forwarded once each (no recursion / duplication)
  expect(seen).toHaveLength(3);
  expect(seen.map((e) => e.type)).toEqual(["phase", "log", "done"]);

  // persisted to disk, one JSON line per event, with a timestamp
  const lines = (await Bun.file(log.path).text()).trim().split("\n");
  expect(lines).toHaveLength(3);
  const first = JSON.parse(lines[0]!);
  expect(first.type).toBe("phase");
  expect(typeof first.ts).toBe("number");
});

test("tee does not call itself even if opts is rebound around it (regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "castle-log2-"));
  const log = new BuildLog(dir, "bld-y");
  let calls = 0;
  let opts: { emit: BuildEmit } = { emit: () => { calls++; } };
  opts = { ...opts, emit: log.tee(opts.emit) }; // the exact pattern build() uses
  opts.emit({ type: "done" });
  log.close();
  expect(calls).toBe(1); // downstream hit once, no infinite loop
});
