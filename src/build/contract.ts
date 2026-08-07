import { think } from "../core/subagent";
import { OUTPUT_ZH } from "../core/prompt";
import { ContractPlanSchema, type ContractPlan, type Task } from "./schemas";

/**
 * Contract-first decomposition.
 *
 * The recursive decomposition produces a flat set of feature tasks that assume
 * disjoint files. That assumption holds for a single self-contained library but
 * breaks for anything with a shared surface — a DB schema, shared types, an API
 * interface — that many tasks touch. Contract-first fixes this by *lifting* those
 * shared artifacts into their own tasks in the earliest wave, giving each shared
 * file a single owner. Everything else depends on the contracts, so the shared
 * surface is frozen before any feature code is written — the single biggest lever
 * for keeping parallel development clean. Feature tasks that later need to change a
 * contract file don't edit it raw; they go through the shared-edit protocol.
 */

const CONTRACT_SYSTEM =
  "You are a staff engineer planning a build so it can be developed in parallel without churn. " +
  "Given the goal and the already-decomposed feature tasks, identify the SHARED artifacts that many " +
  "tasks depend on — the DB schema, shared/domain types, the API interface/contract, shared config. " +
  "For each, emit a contract task that owns exactly those shared file(s), plus the ids of the feature " +
  "tasks that consume it.\n" +
  "Rules: (1) A contract is genuinely shared surface, not one feature's private file — if only one task " +
  "touches a file, it is NOT a contract. (2) Prefer a few coarse contracts (types, schema, api) over many " +
  "tiny ones. (3) Only reference feature-task ids from the provided list as consumers. (4) If the goal is a " +
  "single self-contained unit with no shared surface, return an empty contracts array.";

/** Model pass: identify the shared artifacts to freeze first, over the feature tasks. */
export async function identifyContracts(goal: string, tasks: Task[], model?: string, stack = ""): Promise<ContractPlan> {
  if (tasks.length < 2) return { contracts: [] };
  return think({
    model,
    schema: ContractPlanSchema,
    system: CONTRACT_SYSTEM + OUTPUT_ZH,
    prompt:
      `Goal:\n${goal}\n\n` +
      (stack ? `固定技术栈与路径约定（契约文件路径必须与之一致）:\n${stack}\n\n` : "") +
      `Feature tasks:\n` +
      tasks.map((t) => `- ${t.id}: ${t.title} (files: ${t.files.join(", ") || "none"})`).join("\n") +
      `\n\nIdentify the shared contracts and their consumers.`,
  });
}

/**
 * Apply a contract plan to a feature-task set. Pure and deterministic:
 *
 *  - each contract becomes a wave-0 task (no deps) with `kind: "contract"`,
 *  - the contract is the SOLE owner of its files — those files are stripped from
 *    every feature task, so every file has exactly one owner (what the shared-edit
 *    guard relies on),
 *  - each declared consumer gains a dependency on the contract,
 *  - invalid consumer references and contract/feature id collisions are handled.
 *
 * Contracts are returned first, then the (rewired) feature tasks.
 */
export function applyContracts(tasks: Task[], plan: ContractPlan): Task[] {
  const featureIds = new Set(tasks.map((t) => t.id));
  const used = new Set(featureIds);
  const claimed = new Set<string>(); // files already owned by an earlier contract

  const contractTasks: Task[] = [];
  const depsToAdd = new Map<string, Set<string>>(); // featureId -> contract ids

  for (const c of plan.contracts) {
    const files = c.files.filter((f) => !claimed.has(f));
    if (files.length === 0) continue; // nothing left to own → not a real contract
    const id = uniquify(c.id, used);
    for (const f of files) claimed.add(f);

    contractTasks.push({
      id,
      title: c.title,
      description: c.description,
      acceptanceCriteria: c.acceptanceCriteria.length > 0 ? c.acceptanceCriteria : ["Shared contract defined as described."],
      files,
      dependsOn: [], // contracts are frozen first — earliest wave, no prerequisites
      kind: "contract",
    });

    for (const consumer of c.consumers) {
      if (!featureIds.has(consumer)) continue; // ignore dangling references
      (depsToAdd.get(consumer) ?? depsToAdd.set(consumer, new Set()).get(consumer)!).add(id);
    }
  }

  if (contractTasks.length === 0) return tasks;

  const contractIds = new Set(contractTasks.map((c) => c.id));
  const rewired = tasks.map((t) => {
    const extra = depsToAdd.get(t.id);
    const dependsOn = extra ? dedupe([...t.dependsOn, ...extra]) : t.dependsOn;
    return {
      ...t,
      // a contract is the sole owner of its files: strip them from features
      files: t.files.filter((f) => !claimed.has(f)),
      dependsOn: dependsOn.filter((d) => contractIds.has(d) || featureIds.has(d)),
    };
  });

  return [...contractTasks, ...rewired];
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function uniquify(id: string, used: Set<string>): string {
  const base = id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "contract";
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) candidate = `${base}-${n++}`;
  used.add(candidate);
  return candidate;
}
