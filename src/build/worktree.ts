import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Git worktree isolation for parallel development. Each atomic task gets its own
 * worktree on its own branch, so subagents developing concurrently never touch
 * each other's working tree. Because the decomposition assigns disjoint files to
 * parallel tasks, the branches merge back cleanly.
 */

export type Worktree = { id: string; dir: string; branch: string };

export async function isGitRepo(cwd: string): Promise<boolean> {
  const res = await $`git rev-parse --is-inside-work-tree`.cwd(cwd).nothrow().quiet();
  return res.exitCode === 0;
}

export async function ensureCommitted(cwd: string, message: string): Promise<void> {
  await $`git add -A`.cwd(cwd).quiet();
  // Commit only if there is something staged.
  const status = await $`git status --porcelain`.cwd(cwd).quiet();
  if (status.stdout.toString().trim()) {
    await $`git commit -m ${message}`.cwd(cwd).quiet();
  }
}

/**
 * "From nothing" bootstrap. A build develops each task in a git worktree, and
 * `git worktree add … HEAD` needs a repo that already has a HEAD commit. So for an
 * empty or non-git target directory we: create it, `git init`, scaffold the minimal
 * Bun/TS project files that are missing (never clobbering existing ones), and make
 * an initial commit — so the from-scratch case just works instead of erroring out.
 * Existing repos with a commit are left untouched.
 */
export async function ensureRepo(cwd: string): Promise<{ bootstrapped: boolean }> {
  mkdirSync(cwd, { recursive: true });

  const wasRepo = await isGitRepo(cwd);
  if (!wasRepo) await $`git init -q`.cwd(cwd).quiet();

  const hasCommit = (await $`git rev-parse --verify -q HEAD`.cwd(cwd).nothrow().quiet()).exitCode === 0;
  if (wasRepo && hasCommit) return { bootstrapped: false };

  await scaffoldIfMissing(cwd);
  await ensureCommitted(cwd, "castle: bootstrap project");
  return { bootstrapped: true };
}

/** Create the minimal Bun + TypeScript project files, but only those that don't exist yet. */
async function scaffoldIfMissing(cwd: string): Promise<void> {
  const write = async (rel: string, content: string) => {
    const f = Bun.file(join(cwd, rel));
    if (!(await f.exists())) await Bun.write(f, content);
  };
  await write(
    "package.json",
    JSON.stringify({ name: "castle-app", module: "index.ts", type: "module", private: true }, null, 2) + "\n",
  );
  await write(
    "tsconfig.json",
    JSON.stringify(
      { compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, types: ["bun-types"], skipLibCheck: true } },
      null,
      2,
    ) + "\n",
  );
  await write(".gitignore", ["node_modules", ".castle", "dist", "*.log"].join("\n") + "\n");
}

export async function addWorktree(cwd: string, id: string): Promise<Worktree> {
  const dir = join(cwd, ".castle", "worktrees", id);
  const branch = `castle/${id}`;
  // Clean up any stale worktree/branch from a previous run.
  await $`git worktree remove --force ${dir}`.cwd(cwd).nothrow().quiet();
  await $`git branch -D ${branch}`.cwd(cwd).nothrow().quiet();
  await $`git worktree add -b ${branch} ${dir} HEAD`.cwd(cwd).quiet();
  return { id, dir, branch };
}

/** Commit work in a worktree, then merge its branch back into the main tree. */
export async function mergeWorktree(cwd: string, wt: Worktree): Promise<{ merged: boolean; reason?: string }> {
  await ensureCommitted(wt.dir, `castle: implement ${wt.id}`);
  const res = await $`git merge --no-ff --no-edit ${wt.branch}`.cwd(cwd).nothrow().quiet();
  if (res.exitCode !== 0) {
    // Disjoint files should merge cleanly; if not, abort and report honestly.
    await $`git merge --abort`.cwd(cwd).nothrow().quiet();
    return { merged: false, reason: (res.stderr.toString() || res.stdout.toString()).trim() };
  }
  return { merged: true };
}

export async function removeWorktree(cwd: string, wt: Worktree): Promise<void> {
  await $`git worktree remove --force ${wt.dir}`.cwd(cwd).nothrow().quiet();
  await $`git branch -D ${wt.branch}`.cwd(cwd).nothrow().quiet();
}
