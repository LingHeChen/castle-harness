import { test, expect } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepo, isGitRepo, addWorktree, mergeWorktree, removeWorktree } from "./build/worktree";

async function hasHead(cwd: string) {
  return (await $`git rev-parse --verify -q HEAD`.cwd(cwd).nothrow().quiet()).exitCode === 0;
}

test("ensureRepo bootstraps an empty dir: git init + scaffold + initial commit", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "castle-boot-")), "svc"); // note: dir does not exist yet
  const res = await ensureRepo(dir);

  expect(res.bootstrapped).toBe(true);
  expect(await isGitRepo(dir)).toBe(true);
  expect(await hasHead(dir)).toBe(true); // worktrees need a HEAD commit
  expect(await Bun.file(join(dir, "package.json")).exists()).toBe(true);
  expect(await Bun.file(join(dir, "tsconfig.json")).exists()).toBe(true);
  expect(await Bun.file(join(dir, ".gitignore")).exists()).toBe(true);
});

test("ensureRepo is idempotent and never clobbers existing files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "castle-boot2-"));
  await Bun.write(join(dir, "package.json"), `{"name":"mine"}`);
  await ensureRepo(dir);

  expect(JSON.parse(await Bun.file(join(dir, "package.json")).text()).name).toBe("mine"); // preserved
  const second = await ensureRepo(dir);
  expect(second.bootstrapped).toBe(false); // already a repo with a commit
});

test("an existing repo with commits is left untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "castle-boot3-"));
  await $`git init -q`.cwd(dir).quiet();
  await Bun.write(join(dir, "readme.md"), "hi");
  await $`git add -A`.cwd(dir).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q -m init`.cwd(dir).quiet();

  const res = await ensureRepo(dir);
  expect(res.bootstrapped).toBe(false);
  expect(await Bun.file(join(dir, "package.json")).exists()).toBe(false); // not scaffolded over an existing project
});

test("after bootstrap, the worktree chain works (HEAD exists → add/merge)", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "castle-boot4-")), "svc");
  await ensureRepo(dir);

  const wt = await addWorktree(dir, "task-a");
  await Bun.write(join(wt.dir, "a.ts"), "export const a = 1;");
  const merged = await mergeWorktree(dir, wt);
  await removeWorktree(dir, wt);

  expect(merged.merged).toBe(true);
  expect(await Bun.file(join(dir, "a.ts")).exists()).toBe(true); // task output landed on the main tree
});
