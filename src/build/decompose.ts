import { think } from "../core/subagent";
import { DecomposeStepSchema, DependencyWiringSchema, type Intent, type Task } from "./schemas";
import { buildTaskTree, leavesOf, type ExpandFn, type OnNode, type TaskNode } from "./tree";

const EXPAND_SYSTEM =
  "You are a tech lead decomposing a software goal top-down. For the given task, decide: is it a " +
  "single, independently testable unit? If yes, set atomic=true and give concrete acceptanceCriteria " +
  "and the files it will touch. If it is still too big, set atomic=false and break it into the smallest " +
  "sensible subtasks.\n" +
  "Rules: (1) Infer ONE language/stack from the overall goal and stay consistent — never mix languages. " +
  "(2) A task that is a few functions in one file is already atomic; don't over-split. " +
  "(3) When atomic, name specific files; avoid files a sibling task would obviously also own.";

const WIRE_SYSTEM =
  "You wire build-order dependencies between atomic tasks. For each task, list the ids of other tasks " +
  "that must be completed first. Only reference ids from the provided list. Keep it minimal and acyclic — " +
  "a dependency means 'cannot start until that one is done' (e.g., a module that imports another).";

/** Model-backed expansion for one node, in the context of the overall goal. */
function modelExpand(goal: string, model?: string): ExpandFn {
  return (node) =>
    think({
      model,
      schema: DecomposeStepSchema,
      system: EXPAND_SYSTEM,
      prompt:
        `Overall goal:\n${goal}\n\n` +
        `Task under consideration (tree depth ${node.depth}):\n${node.title}\n${node.description}`,
    });
}

export type DecomposeResult = { tree: TaskNode; tasks: Task[] };

/**
 * Recursively decompose an intent into a task tree, then wire dependencies over
 * its leaves to produce the executable DAG. Structure first (tree), dependencies
 * second (a flat pass over leaves) — which keeps cross-branch ordering simple and
 * gives the user a clean thing to edit later.
 */
export async function recursiveDecompose(
  intent: Intent,
  opts: { model?: string; maxDepth?: number; onNode?: OnNode },
): Promise<DecomposeResult> {
  const goal = intent.expandedIntent;
  const root = { id: "root", title: goal.slice(0, 60), description: goal };
  const tree = await buildTaskTree(root, modelExpand(goal, opts.model), opts.maxDepth ?? 3, opts.onNode);
  const leaves = leavesOf(tree);
  const tasks = await wireDependencies(goal, leaves, opts.model);
  return { tree, tasks };
}

/** Turn the leaves into a Task[] with a wired, validated, acyclic dependency set. */
export async function wireDependencies(goal: string, leaves: TaskNode[], model?: string): Promise<Task[]> {
  let depMap = new Map<string, string[]>();

  if (leaves.length > 1) {
    const { dependencies } = await think({
      model,
      schema: DependencyWiringSchema,
      system: WIRE_SYSTEM,
      prompt:
        `Goal:\n${goal}\n\nAtomic tasks:\n` +
        leaves.map((l) => `- ${l.id}: ${l.title}`).join("\n") +
        `\n\nList each task's prerequisite task ids.`,
    });
    depMap = new Map(dependencies.map((d) => [d.task, d.dependsOn]));
  }

  return assembleTasks(leaves, depMap);
}

/** Turn leaves + a raw dependency map into validated, acyclic-ready Task[]. Pure. */
export function assembleTasks(leaves: TaskNode[], depMap: Map<string, string[]>): Task[] {
  const ids = new Set(leaves.map((l) => l.id));
  return leaves.map((l) => ({
    id: l.id,
    title: l.title,
    description: l.description,
    acceptanceCriteria: l.acceptanceCriteria.length > 0 ? l.acceptanceCriteria : ["Implemented as described."],
    files: l.files,
    // keep only real, non-self references (the editor can add more later)
    dependsOn: (depMap.get(l.id) ?? []).filter((d) => ids.has(d) && d !== l.id),
  }));
}
