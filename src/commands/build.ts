import { Option, Command, type Usage } from "clipanion";
import { build } from "../build/orchestrator";

export class BuildCommand extends Command {
  static override paths = [["build"]];

  static override usage?: Usage = Command.Usage({
    description: "Plan → test → build → verify: spec-driven autonomous development",
    examples: [["Build a feature", 'castle build "add a rate limiter to the API"']],
  });

  goal = Option.String({ required: true });
  model = Option.String("--model", { description: "Model id (default: deepseek-chat)" });
  yes = Option.Boolean("--yes", false, { description: "Autonomous: skip clarification, proceed on assumptions" });
  fixAttempts = Option.String("--fix-attempts", "2", { description: "Max fix attempts per failing task" });
  confidence = Option.String("--confidence", "0.75", { description: "Clarify below this confidence (0..1)" });

  override async execute(): Promise<number | void> {
    const outcomes = await build(this.goal, {
      cwd: process.cwd(),
      model: this.model,
      autonomous: this.yes,
      maxFixAttempts: Number.parseInt(this.fixAttempts, 10) || 2,
      confidenceThreshold: Number.parseFloat(this.confidence) || 0.75,
    }).catch((err) => {
      this.context.stderr.write(`\x1b[31mbuild failed:\x1b[0m ${(err as Error).message}\n`);
      return null;
    });

    if (!outcomes) return 1;

    const passed = outcomes.filter((o) => o.passed);
    this.context.stdout.write(`\n\x1b[1m━━ report ━━\x1b[0m\n`);
    for (const o of outcomes) {
      const mark = o.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      this.context.stdout.write(`${mark} ${o.task.id} — ${o.detail.split("\n")[0]}\n`);
    }
    this.context.stdout.write(`\n${passed.length}/${outcomes.length} tasks passed acceptance.\n`);
    return passed.length === outcomes.length ? 0 : 1;
  }
}
