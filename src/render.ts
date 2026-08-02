import type { AgentEvent, Usage } from "./core/events";

const C = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

/**
 * Stateful terminal renderer for the agent's event stream. Kept out of the core
 * so the loop stays presentation-free; the TUI (P3) is a drop-in replacement.
 */
export class TerminalRenderer {
  private out = process.stdout;
  private inText = false;

  handle(ev: AgentEvent): void {
    switch (ev.type) {
      case "step-start":
        this.endText();
        this.out.write(`${C.dim}── step ${ev.step} ──${C.reset}\n`);
        break;
      case "reasoning-delta":
        // Reasoning is dimmed so it reads as the model "thinking".
        this.out.write(`${C.dim}${ev.text}${C.reset}`);
        break;
      case "text-delta":
        this.inText = true;
        this.out.write(ev.text);
        break;
      case "tool-call":
        this.endText();
        this.out.write(`${C.cyan}▸ ${ev.name}${C.reset} ${C.dim}${summarizeInput(ev.input)}${C.reset}\n`);
        break;
      case "tool-result":
        this.out.write(`${C.dim}  ${indent(clip(ev.output, 500))} ${C.reset}${C.dim}(${ev.ms}ms)${C.reset}\n`);
        break;
      case "compaction":
        this.endText();
        this.out.write(
          `${C.yellow}⟲ compacted${C.reset} ${C.dim}${ev.summarizedSegments} turns · ${fmtTokens(ev.beforeTokens)}→${fmtTokens(ev.afterTokens)}${C.reset}\n`,
        );
        break;
      case "step-finish":
        this.out.write(`${C.dim}  ${formatUsage(ev.usage)}${C.reset}\n`);
        break;
      case "done":
        this.endText();
        this.out.write(`\n${C.green}✓ done${C.reset}  ${formatUsage(ev.usage)}\n`);
        break;
      case "error":
        this.endText();
        this.out.write(`${C.red}✗ error:${C.reset} ${ev.message}\n`);
        break;
    }
  }

  private endText(): void {
    if (this.inText) {
      this.out.write("\n");
      this.inText = false;
    }
  }
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.command === "string") return obj.command;
    if (typeof obj.path === "string") return obj.path;
  }
  return clip(JSON.stringify(input ?? {}), 120);
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function indent(s: string): string {
  return s.replace(/\n/g, "\n  ");
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatUsage(u: Usage): string {
  const cacheRate =
    u.inputTokens > 0 ? Math.round((u.cachedInputTokens / u.inputTokens) * 100) : 0;
  return `${C.dim}in=${u.inputTokens} out=${u.outputTokens} cached=${u.cachedInputTokens} (${cacheRate}% hit) total=${u.totalTokens}${C.reset}`;
}
