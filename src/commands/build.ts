import { Option, Command, type Usage } from "clipanion";
import { build } from "../build/orchestrator";
import { renderBuildEvent } from "../build/render";

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
      emit: renderBuildEvent,
      ask: this.yes ? undefined : (q, why) => prompt(`\n? ${q}\n  (why: ${why})\n> `),
    }).catch((err) => {
      this.context.stderr.write(`\x1b[31mbuild failed:\x1b[0m ${(err as Error).message}\n`);
      return null;
    });

    if (!outcomes) return 1;
    return outcomes.every((o) => o.passed) ? 0 : 1;
  }
}
