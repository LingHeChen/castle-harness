import { think } from "../core/subagent";
import { OUTPUT_ZH } from "../core/prompt";
import { DecomposeStepSchema, DependencyWiringSchema, StackDecisionSchema, type Intent, type Task } from "./schemas";
import { buildTaskTree, leavesOf, type ExpandFn, type OnNode, type TaskNode } from "./tree";
import { identifyContracts, applyContracts } from "./contract";

const STACK_SYSTEM =
  "You are a tech lead fixing the ONE stack and file layout for a build before it is decomposed. From the " +
  "goal, pick a single language + runtime/framework and a concrete set of path conventions every task will " +
  "obey — where source lives, where shared types live, the server entry (must read PORT from env) and the " +
  "persistence module. This is decided ONCE and never contradicted. Do not assume a specific database unless " +
  "the goal implies one.";

const EXPAND_SYSTEM =
  "You are a tech lead decomposing a software goal top-down. For the given task decide: is it a SINGLE " +
  "cohesive unit — ONE file (or a few closely-related functions in one file)? If yes, atomic=true with " +
  "concrete acceptanceCriteria and that file. If it spans multiple files or several concerns, atomic=false " +
  "and break it into the smallest sensible subtasks.\n" +
  "Rules: (1) OBEY the fixed stack & conventions below EXACTLY — never another language, never a path that " +
  "diverges from the conventions (e.g. don't mix src/contract/ and src/contracts/, or .js and .ts). " +
  "(2) DO NOT recreate a component/file already in the 'already-planned' list — depend on / import it. " +
  "(3) A node is atomic ONLY if it maps to ~one file. If it names MULTIPLE files, or clearly bundles several " +
  "concerns (e.g. types + storage + routes + server), it is NOT atomic — you MUST split it. The overall " +
  "goal is never atomic. (4) Don't over-split a genuinely single-file unit into trivial fragments. " +
  "(5) For a runnable service/app, its components — shared types/contract, the storage module, each " +
  "route/handler (or a small group), and the server entry that reads PORT — should each become their own " +
  "atomic task, added ONCE across the whole tree (check the already-planned list first).";

const WIRE_SYSTEM =
  "You wire build-order dependencies between atomic tasks. For each task, list the ids of other tasks " +
  "that must be completed first. Only reference ids from the provided list. Keep it minimal and acyclic — " +
  "a dependency means 'cannot start until that one is done' (e.g., a module that imports another).";

/** Decide the one stack + path conventions up front, so every branch shares them. */
async function chooseStack(goal: string, model?: string): Promise<string> {
  const d = await think({ model, schema: StackDecisionSchema, system: STACK_SYSTEM + OUTPUT_ZH, prompt: `目标:\n${goal}` });
  return `语言: ${d.language}\n运行时/框架: ${d.runtime}\n路径约定:\n${d.conventions.map((c) => `- ${c}`).join("\n")}`;
}

/** Model-backed expansion for one node, aware of the fixed stack + already-planned leaves. */
function modelExpand(goal: string, model?: string): ExpandFn {
  return (node, ctx) =>
    think({
      model,
      schema: DecomposeStepSchema,
      system: EXPAND_SYSTEM + OUTPUT_ZH,
      prompt:
        `总目标:\n${goal}\n\n` +
        `固定技术栈与路径约定（必须严格遵守，禁止引入其他语言或偏离的路径）:\n${ctx.stack}\n\n` +
        (ctx.existing.length > 0
          ? `已规划的任务及其文件（不要重复创建这些组件/文件；需要就依赖/导入它们）:\n` +
            ctx.existing.map((e) => `- ${e.id}: ${e.title} → ${e.files.join(", ") || "(无文件)"}`).join("\n") +
            "\n\n"
          : "") +
        (ctx.mustSplit
          ? "这是整体目标，绝不能作为单个原子任务——必须 atomic=false，拆成它的组成部分（共享类型/契约、存储模块、各路由/处理器、读 PORT 的服务器入口等）。\n\n"
          : "") +
        `当前要分解的任务（树深度 ${node.depth}）:\n${node.title}\n${node.description}`,
    });
}

export type DecomposeResult = { tree: TaskNode; tasks: Task[] };

/**
 * Recursively decompose an intent into a task tree, then wire dependencies over
 * its leaves to produce the executable DAG. Structure first (tree), dependencies
 * second (a flat pass over leaves), then contract-first (lift shared artifacts
 * into wave-0 contract tasks) — which keeps cross-branch ordering simple, gives
 * the user a clean thing to edit later, and freezes the shared surface up front.
 */
export async function recursiveDecompose(
  intent: Intent,
  opts: { model?: string; maxDepth?: number; onNode?: OnNode },
): Promise<DecomposeResult> {
  const goal = intent.expandedIntent;
  const root = { id: "root", title: goal.slice(0, 60), description: goal };
  const stack = await chooseStack(goal, opts.model);
  const tree = await buildTaskTree(root, modelExpand(goal, opts.model), opts.maxDepth ?? 3, opts.onNode, stack);
  const leaves = leavesOf(tree);
  const features = await wireDependencies(goal, leaves, opts.model);
  const plan = await identifyContracts(goal, features, opts.model, stack);
  const tasks = applyContracts(features, plan);
  return { tree, tasks };
}

/** Turn the leaves into a Task[] with a wired, validated, acyclic dependency set. */
export async function wireDependencies(goal: string, leaves: TaskNode[], model?: string): Promise<Task[]> {
  let depMap = new Map<string, string[]>();

  if (leaves.length > 1) {
    const { dependencies } = await think({
      model,
      schema: DependencyWiringSchema,
      system: WIRE_SYSTEM + OUTPUT_ZH,
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
    kind: "feature" as const,
  }));
}
