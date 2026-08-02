import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory, appendMemory } from "./core/memory";
import { listSkills, loadSkill } from "./core/skills";

function tmp() {
  return mkdtempSync(join(tmpdir(), "castle-ms-"));
}

test("memory: empty when absent, round-trips after append", async () => {
  const dir = tmp();
  expect(await loadMemory(dir)).toBe("");
  await appendMemory(dir, "prefer bun over node");
  await appendMemory(dir, "tests live in acceptance/");
  const mem = await loadMemory(dir);
  expect(mem).toContain("prefer bun over node");
  expect(mem).toContain("tests live in acceptance/");
});

test("skills: none when dir absent", async () => {
  expect(await listSkills(tmp())).toHaveLength(0);
});

test("skills: parses frontmatter and loads body without it", async () => {
  const dir = tmp();
  mkdirSync(join(dir, ".castle/skills"), { recursive: true });
  await Bun.write(
    join(dir, ".castle/skills/release.md"),
    `---\nname: release\ndescription: cut a release\n---\nStep 1: bump version\nStep 2: tag`,
  );
  const skills = await listSkills(dir);
  expect(skills).toHaveLength(1);
  expect(skills[0]!.name).toBe("release");
  expect(skills[0]!.description).toBe("cut a release");

  const body = await loadSkill(dir, "release");
  expect(body).toContain("Step 1: bump version");
  expect(body).not.toContain("---");
  expect(await loadSkill(dir, "nope")).toBeNull();
});
