import { Option, Command, type Usage } from "clipanion";
import { resolve } from "node:path";
import { runAgent } from "../core/agent";
import { Tracer } from "../core/trace";
import { TerminalRenderer } from "../render";

export class RunCommand extends Command {
  static override paths = [["run"], Command.Default];

  static override usage?: Usage = Command.Usage({
    description: "Run the Castle agent on a task",
    examples: [["Fix failing tests", 'castle run "fix the failing tests in this project"']],
  });

  task = Option.String({ required: true });
  cwd = Option.String("--cwd", { description: "Working directory the agent operates in (default: current dir)" });
  model = Option.String("--model", { description: "Model id (default: deepseek-chat)" });
  maxSteps = Option.String("--max-steps", "20", { description: "Max agent steps" });
  noCompact = Option.Boolean("--no-compact", false, { description: "Disable context compaction" });
  contextBudget = Option.String("--context-budget", { description: "Compaction trigger, in tokens" });
  dryRun = Option.Boolean("--dry-run", false, { description: "Print config and exit" });

  override async execute(): Promise<number | void> {
    const cwd = this.cwd ? resolve(this.cwd) : process.cwd();
    const maxSteps = Number.parseInt(this.maxSteps, 10) || 20;

    if (this.dryRun) {
      this.context.stdout.write(
        JSON.stringify({ task: this.task, model: this.model ?? "deepseek-chat", maxSteps, cwd }, null, 2) + "\n",
      );
      return 0;
    }

    const tracer = new Tracer();
    this.context.stdout.write(`\x1b[2mrun ${tracer.runId} · ${cwd}\x1b[0m\n\n`);

    const renderer = new TerminalRenderer();
    try {
      for await (const ev of runAgent(this.task, {
        cwd,
        maxSteps,
        tracer,
        model: this.model,
        compact: !this.noCompact,
        contextBudget: this.contextBudget ? Number.parseInt(this.contextBudget, 10) : undefined,
      })) {
        renderer.handle(ev);
      }
    } catch (err) {
      this.context.stderr.write(`\x1b[31mfatal:\x1b[0m ${(err as Error).message}\n`);
      return 1;
    } finally {
      tracer.close();
    }

    this.context.stdout.write(`\x1b[2mtrace: ${tracer.path}\x1b[0m\n`);
    return 0;
  }
}
