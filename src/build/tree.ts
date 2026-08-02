import type { DecomposeStep } from "./schemas";

/**
 * A node in the decomposition tree. A node with no `children` is a *leaf* — an
 * atomic, independently testable unit that will actually be built. Nodes with
 * children are groupings that exist only to organise the tree. The executable
 * work is the set of leaves; their dependencies (wired separately) form the DAG.
 */
export type TaskNode = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[]; // meaningful on leaves
  files: string[]; // meaningful on leaves
  children: TaskNode[];
};

/** Expand one node: decide atomic-vs-split. Injectable so recursion is testable. */
export type ExpandFn = (node: { id: string; title: string; description: string; depth: number }) => Promise<DecomposeStep>;

/** Called as each node is resolved, so callers can stream recursion progress. */
export type OnNode = (node: { id: string; title: string; depth: number; leaf: boolean }) => void;

/**
 * Recursively decompose `root` into a task tree, stopping a branch when the model
 * says it's atomic, when it proposes no subtasks, or at `maxDepth`. Ids are made
 * globally unique (and file-safe) as the tree is built.
 */
export async function buildTaskTree(
  root: { id: string; title: string; description: string },
  expand: ExpandFn,
  maxDepth: number,
  onNode?: OnNode,
): Promise<TaskNode> {
  const used = new Set<string>();

  async function go(node: { id: string; title: string; description: string }, depth: number): Promise<TaskNode> {
    const id = uniquify(node.id, used);
    const step = await expand({ id, title: node.title, description: node.description, depth });

    if (step.atomic || depth >= maxDepth || step.subtasks.length === 0) {
      onNode?.({ id, title: node.title, depth, leaf: true });
      return { id, title: node.title, description: node.description, acceptanceCriteria: step.acceptanceCriteria, files: step.files, children: [] };
    }

    onNode?.({ id, title: node.title, depth, leaf: false });
    const children: TaskNode[] = [];
    for (const sub of step.subtasks) {
      children.push(await go({ id: `${id}-${sub.id}`, title: sub.title, description: sub.description }, depth + 1));
    }
    return { id, title: node.title, description: node.description, acceptanceCriteria: [], files: [], children };
  }

  return go(root, 0);
}

/** All leaves of the tree, left to right — the executable task set. */
export function leavesOf(tree: TaskNode): TaskNode[] {
  return tree.children.length === 0 ? [tree] : tree.children.flatMap(leavesOf);
}

/** Total node count (for progress/logging). */
export function countNodes(tree: TaskNode): number {
  return 1 + tree.children.reduce((n, c) => n + countNodes(c), 0);
}

function uniquify(id: string, used: Set<string>): string {
  const base = id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) candidate = `${base}-${n++}`;
  used.add(candidate);
  return candidate;
}
