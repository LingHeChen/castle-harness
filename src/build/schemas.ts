import { z } from "zod";

/** Phase 1 — the model's expanded understanding of a possibly-vague goal. */
export const IntentSchema = z.object({
  expandedIntent: z.string().describe("A precise, fleshed-out statement of what the user wants."),
  assumptions: z.array(z.string()).describe("Assumptions made to fill gaps in the request."),
  confidence: z.number().min(0).max(1).describe("0..1 confidence that the intent is understood correctly."),
  clarifications: z
    .array(
      z.object({
        question: z.string(),
        why: z.string(),
        options: z
          .array(z.string())
          .describe("2–4 concrete, mutually-exclusive answer options the user can pick from (the user can always type their own instead). Empty only if the question is genuinely open-ended."),
      }),
    )
    .describe("Questions to ask the user. Populate these pessimistically whenever anything material is ambiguous."),
});
export type Intent = z.infer<typeof IntentSchema>;

/** Phase 2 — an atomic task in the decomposition graph. */
export const TaskSchema = z.object({
  id: z.string().describe("Short kebab-case slug, unique within the graph."),
  title: z.string(),
  description: z.string().describe("What to build, precisely enough to implement and test."),
  acceptanceCriteria: z.array(z.string()).min(1).describe("Observable, testable conditions that mean this task is done."),
  dependsOn: z.array(z.string()).describe("ids of tasks that must complete first."),
  files: z.array(z.string()).describe("Files this task will create or modify. Parallel tasks must not overlap."),
  /**
   * A "contract" task owns a shared artifact (DB schema, shared types, the API
   * interface) that many feature tasks depend on. Contracts are lifted into the
   * earliest wave and are the sole owner of their files; feature tasks that need
   * to change a contract file go through the shared-edit protocol, not a raw edit.
   */
  kind: z.enum(["contract", "feature"]).default("feature").describe("'contract' = owns a shared artifact everything else depends on; 'feature' = ordinary work."),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskGraphSchema = z.object({
  tasks: z.array(TaskSchema).min(1),
});
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

/**
 * Phase 2 (pre-decomposition) — the ONE stack + path conventions the whole build
 * obeys. Decided once from the goal and injected into every branch expansion so no
 * task introduces a second language or a divergent file layout.
 */
export const StackDecisionSchema = z.object({
  language: z.string().describe("The single language, e.g. 'TypeScript'."),
  runtime: z.string().describe("Runtime/framework, e.g. 'Bun (Bun.serve, bun:sqlite)'."),
  conventions: z
    .array(z.string())
    .min(1)
    .describe("Concrete file-layout rules every task must follow, e.g. '源码放 src/', '共享类型在 src/types.ts', 'HTTP 入口 src/server.ts 读 PORT', '持久化在 src/db.ts'."),
});
export type StackDecision = z.infer<typeof StackDecisionSchema>;

/**
 * Phase 2 (recursive) — one step of top-down decomposition of a single node.
 * Either the node is atomic (→ acceptance criteria + files, becomes a leaf) or it
 * splits into smaller subtasks (→ recurse into each).
 */
export const DecomposeStepSchema = z.object({
  atomic: z.boolean().describe("True if this is one independently testable unit that should NOT be split further."),
  acceptanceCriteria: z.array(z.string()).describe("If atomic: observable, testable conditions for done."),
  files: z.array(z.string()).describe("If atomic: files this task will create or modify."),
  subtasks: z
    .array(z.object({ id: z.string(), title: z.string(), description: z.string() }))
    .describe("If not atomic: the smallest sensible subtasks it breaks into."),
});
export type DecomposeStep = z.infer<typeof DecomposeStepSchema>;

/** Phase 2 (recursive) — dependency edges between the flattened leaf tasks. */
export const DependencyWiringSchema = z.object({
  dependencies: z.array(z.object({ task: z.string(), dependsOn: z.array(z.string()) })),
});
export type DependencyWiring = z.infer<typeof DependencyWiringSchema>;

/**
 * Phase 2 (contract-first) — the shared artifacts a build should freeze early.
 * A contract is a shared file (or small set) that many feature tasks depend on:
 * the DB schema, the shared types, the API interface. Lifting these into the
 * earliest wave and giving them a single owner is the biggest lever for keeping
 * parallel development clean.
 */
export const ContractPlanSchema = z.object({
  contracts: z
    .array(
      z.object({
        id: z.string().describe("Short kebab-case slug for the contract task."),
        title: z.string(),
        description: z.string().describe("What the shared artifact must define, precisely enough to implement and test."),
        acceptanceCriteria: z.array(z.string()).min(1).describe("Observable, testable conditions for the contract being complete."),
        files: z.array(z.string()).min(1).describe("The shared file(s) this contract owns. These become off-limits to raw edits by feature tasks."),
        consumers: z.array(z.string()).describe("ids of the feature tasks that depend on this contract."),
      }),
    )
    .describe("The shared artifacts to freeze first. Empty if the goal has no meaningful shared surface (e.g. a single self-contained library)."),
});
export type ContractPlan = z.infer<typeof ContractPlanSchema>;

/**
 * Phase 6 (integration) — how to stand up the finished app and what seams to test.
 * Unit acceptance proves each task; this plans the build-wide gate above it: bring
 * the server (and DB) up, exercise the DB↔API↔client seams and full user flows,
 * tear it down. Not applicable to a self-contained library (no runnable app).
 */
export const IntegrationPlanSchema = z.object({
  applicable: z
    .boolean()
    .describe("True if this build produces a runnable app/server with cross-component seams worth integration-testing. False for a self-contained library."),
  reason: z.string().describe("Why it is or isn't applicable."),
  setupCommand: z.array(z.string()).describe("argv to migrate/seed before starting the server (empty if none). Runs once before the server boots."),
  startCommand: z.array(z.string()).describe("argv that starts the server; it must read the PORT env var. Empty if not applicable."),
  readyPath: z.string().default("/").describe("HTTP path that returns a non-5xx status once the server is up."),
  scenarios: z
    .array(z.object({ title: z.string(), description: z.string() }))
    .describe("End-to-end scenarios the integration tests must cover — the seams: API↔DB, full user flows, concurrency/races."),
});
export type IntegrationPlan = z.infer<typeof IntegrationPlanSchema>;

/** Phase 3 — a context-isolated auditor's verdict on a task's acceptance tests. */
export const AuditVerdictSchema = z.object({
  sound: z.boolean().describe("Do the tests correctly encode the acceptance criteria?"),
  canFalsePass: z.boolean().describe("Could these tests pass WITHOUT a correct implementation (tautological asserts, mocked-away logic, happy-path only)?"),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
});
export type AuditVerdict = z.infer<typeof AuditVerdictSchema>;
