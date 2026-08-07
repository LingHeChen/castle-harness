import { resolve } from "node:path";
import type { WriteAttempt, WriteDecision, WriteGuard } from "../tools";
import type { BuildEmit, SharedEditSize } from "./events";
import {
  classifyPath,
  dependentsOfPath,
  editMagnitude,
  normPath,
  type Ownership,
} from "./shared-edit";

/**
 * The stateful half of the shared-edit protocol.
 *
 * A dev agent developing a feature in its worktree may need to touch a file it
 * doesn't own — a shared/contract file. The tool layer routes that write here
 * (via the {@link WriteGuard} the guard seam installs) instead of letting it land
 * raw. This coordinator:
 *
 *  - **serializes** shared writes through a single queue (one shared change at a
 *    time — the mechanical half a git merge doesn't give you for free),
 *  - **applies** the change to the requesting worktree so the agent can proceed
 *    (the change rides that worktree's branch back to the integration tree),
 *  - **classifies** its magnitude on the spectrum (small → auto-merge … large →
 *    replan), and
 *  - **records** which shared files changed and who owns the ripple, so the
 *    orchestrator can re-verify the transitive dependents after the wave merges
 *    (the semantic half — "edit the shared file, then fix everything it touched").
 *
 * Owned/new files are never intercepted (the guard returns `allow`); only writes
 * to a file owned by a *different* task are coordinated.
 */
export class SharedEditCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  /** shared file (normalized) → the edits made to it this wave */
  private touched = new Map<string, { taskId: string; size: SharedEditSize }[]>();

  constructor(
    private readonly ownership: Ownership,
    private readonly emit: BuildEmit,
  ) {}

  /** A guard bound to one dev agent (its task id and its worktree directory). */
  guardFor(taskId: string, dir: string): WriteGuard {
    return (attempt) => this.handle(taskId, dir, attempt);
  }

  private async handle(taskId: string, dir: string, attempt: WriteAttempt): Promise<WriteDecision> {
    const cls = classifyPath(this.ownership, taskId, attempt.path);
    if (cls.kind !== "shared") return { type: "allow" }; // own file or brand-new → raw write is fine
    // Coordinate: serialize so concurrent shared writes are applied one at a time.
    return this.serialize(() => this.applyShared(taskId, dir, attempt, cls.owner, cls.contract));
  }

  private async applyShared(
    taskId: string,
    dir: string,
    attempt: WriteAttempt,
    owner: string,
    contract: boolean,
  ): Promise<WriteDecision> {
    const file = normPath(attempt.path);
    const target = resolve(dir, attempt.path);
    const before = await Bun.file(target).text().catch(() => "");
    const after =
      attempt.op === "write" ? attempt.content : before.replace(attempt.old_string, attempt.new_string);

    await Bun.write(target, after);

    const size = editMagnitude(before, after);
    const dependents = dependentsOfPath(this.ownership, file).filter((d) => d !== taskId);
    (this.touched.get(file) ?? this.touched.set(file, []).get(file)!).push({ taskId, size });

    this.emit({ type: "shared-edit", taskId, file, owner, size, dependents });

    const kind = contract ? "contract" : "shared";
    return {
      type: "handled",
      message:
        `Coordinated ${size} change to ${kind} file ${file} (owned by ${owner}) via the shared-edit protocol. ` +
        `The change was applied; dependents [${dependents.join(", ") || "none"}] will be re-verified after this wave. ` +
        `Keep your own files consistent with it.`,
    };
  }

  /** The union of tasks whose code must be re-verified for the shared changes so far. */
  dependentsToVerify(): Set<string> {
    const out = new Set<string>();
    for (const file of this.touched.keys()) {
      for (const d of dependentsOfPath(this.ownership, file)) out.add(d);
    }
    return out;
  }

  /** Snapshot of the shared files changed so far (for logging / the report). */
  touchedFiles(): string[] {
    return [...this.touched.keys()].sort();
  }

  /** Take the touched-file set and reset it — call once per wave to scope the ripple. */
  drainTouched(): Map<string, { taskId: string; size: SharedEditSize }[]> {
    const out = this.touched;
    this.touched = new Map();
    return out;
  }

  /** Serialize shared writes through a single promise chain (one at a time). */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
