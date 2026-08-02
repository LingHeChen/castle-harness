import { z } from "zod";

/** Phase 1 — the model's expanded understanding of a possibly-vague goal. */
export const IntentSchema = z.object({
  expandedIntent: z.string().describe("A precise, fleshed-out statement of what the user wants."),
  assumptions: z.array(z.string()).describe("Assumptions made to fill gaps in the request."),
  confidence: z.number().min(0).max(1).describe("0..1 confidence that the intent is understood correctly."),
  clarifications: z
    .array(z.object({ question: z.string(), why: z.string() }))
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
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskGraphSchema = z.object({
  tasks: z.array(TaskSchema).min(1),
});
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

/** Phase 3 — a context-isolated auditor's verdict on a task's acceptance tests. */
export const AuditVerdictSchema = z.object({
  sound: z.boolean().describe("Do the tests correctly encode the acceptance criteria?"),
  canFalsePass: z.boolean().describe("Could these tests pass WITHOUT a correct implementation (tautological asserts, mocked-away logic, happy-path only)?"),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
});
export type AuditVerdict = z.infer<typeof AuditVerdictSchema>;
