import { test, expect } from "bun:test";
import { pool } from "./core/util";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("pool preserves input→output order regardless of completion order", async () => {
  const out = await pool([50, 10, 30, 5], 4, async (ms, i) => {
    await sleep(ms);
    return i; // finishes out of order, but results keyed by index
  });
  expect(out).toEqual([0, 1, 2, 3]);
});

test("pool runs up to `limit` in parallel — genuinely concurrent, and capped", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  await pool(items, 3, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(15);
    inFlight--;
  });
  expect(maxInFlight).toBe(3); // hit the cap: true parallelism, bounded
});

test("limit larger than the item count just runs them all at once", async () => {
  let maxInFlight = 0;
  let inFlight = 0;
  await pool([1, 2, 3], 100, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(10);
    inFlight--;
  });
  expect(maxInFlight).toBe(3); // all three, but never more than there are
});

test("empty input is a no-op", async () => {
  expect(await pool([], 4, async () => 1)).toEqual([]);
});
