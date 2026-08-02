import { Option, Command, type Usage } from "clipanion";
import { parseTrace } from "../core/analysis";

/**
 * Analyze a run trace and print the per-step KV-cache curve. Both this command
 * and the web dashboard go through {@link parseTrace}, so they read a run the
 * exact same way — the agent core only ever emitted events.
 */
export class TraceCommand extends Command {
  static override paths = [["trace"]];

  static override usage?: Usage = Command.Usage({
    description: "Analyze a run trace: per-step tokens, cache-hit rate, compactions",
    examples: [["Analyze a run", "castle trace .castle/traces/run-123.jsonl"]],
  });

  file = Option.String({ required: true });

  override async execute(): Promise<number | void> {
    const summary = parseTrace(await Bun.file(this.file).text());
    const out = this.context.stdout;

    out.write(`\n  trace: ${this.file}\n\n`);
    out.write(`  step   input   cached   hit%    output\n`);
    out.write(`  ────   ─────   ──────   ────    ──────\n`);
    for (const s of summary.steps) {
      out.write(
        `  ${pad(s.step, 4)}   ${pad(s.inputTokens, 5)}   ${pad(s.cachedInputTokens, 6)}   ${pad(pct(s.hitRate), 4)}    ${pad(s.outputTokens, 6)}\n`,
      );
    }

    if (summary.compactions.length > 0) {
      out.write(`\n  compactions:\n`);
      for (const c of summary.compactions) {
        out.write(`    ⟲ ${c.summarizedSegments} turns · ${c.beforeTokens} → ${c.afterTokens} tokens\n`);
      }
    }

    if (summary.total) {
      const t = summary.total;
      out.write(
        `\n  total: input=${t.inputTokens} cached=${t.cachedInputTokens} (${pct(t.hitRate)} hit) output=${t.outputTokens}\n`,
      );
    }
    out.write("\n");
    return 0;
  }
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function pad(v: string | number, width: number): string {
  return String(v).padStart(width);
}
