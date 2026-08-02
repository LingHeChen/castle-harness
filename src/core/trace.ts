import { mkdirSync } from "node:fs";
import type { FileSink } from "bun";
import type { AgentEvent, Usage } from "./events";

/**
 * Append-only structured trace. Every run writes one JSONL file where each line
 * is a timestamped record. This is the substrate the web trace panel and the
 * eval harness read later — the agent core never renders, it only emits.
 */
export class Tracer {
  readonly runId: string;
  readonly path: string;
  private readonly writer: FileSink;

  constructor(baseDir = ".castle/traces", runId?: string) {
    this.runId = runId ?? `run-${Date.now()}`;
    mkdirSync(baseDir, { recursive: true });
    this.path = `${baseDir}/${this.runId}.jsonl`;
    this.writer = Bun.file(this.path).writer();
  }

  private record(obj: Record<string, unknown>): void {
    this.writer.write(JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
    this.writer.flush();
  }

  event(ev: AgentEvent): void {
    this.record({ kind: "event", ...ev });
  }

  final(usage: Usage): void {
    this.record({ kind: "final", usage });
  }

  close(): void {
    this.writer.end();
  }
}
