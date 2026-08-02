import type { AgentEvent, Usage } from "./events";

export type TimedEvent = { ts?: number } & AgentEvent;

export type StepMetric = {
  step: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  hitRate: number; // 0..1
};

export type CompactionMetric = {
  beforeTokens: number;
  afterTokens: number;
  summarizedSegments: number;
};

export type RunSummary = {
  steps: StepMetric[];
  compactions: CompactionMetric[];
  total?: StepMetric;
  events: TimedEvent[];
};

function hit(inputTokens: number, cached: number): number {
  return inputTokens > 0 ? cached / inputTokens : 0;
}

function metric(step: number, u: Usage): StepMetric {
  return {
    step,
    inputTokens: u.inputTokens,
    cachedInputTokens: u.cachedInputTokens,
    outputTokens: u.outputTokens,
    hitRate: hit(u.inputTokens, u.cachedInputTokens),
  };
}

/**
 * Fold a list of agent events into structured run metrics. This is the single
 * source of truth for "what happened in a run": the `castle trace` CLI, the
 * dashboard's historical view, and its live WebSocket view all call it, so a
 * run looks identical whether replayed from disk or watched in real time.
 */
export function summarizeEvents(events: TimedEvent[]): RunSummary {
  const steps: StepMetric[] = [];
  const compactions: CompactionMetric[] = [];
  let total: StepMetric | undefined;

  for (const ev of events) {
    if (ev.type === "step-finish") {
      steps.push(metric(ev.step, ev.usage));
    } else if (ev.type === "compaction") {
      compactions.push({
        beforeTokens: ev.beforeTokens,
        afterTokens: ev.afterTokens,
        summarizedSegments: ev.summarizedSegments,
      });
    } else if (ev.type === "done") {
      total = metric(0, ev.usage);
    }
  }

  return { steps, compactions, total, events };
}

/** Parse a raw JSONL trace file into the same {@link RunSummary} shape. */
export function parseTrace(jsonl: string): RunSummary {
  const events: TimedEvent[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { kind?: string; ts?: number } & Record<string, unknown>;
    if (rec.kind === "event") {
      const { kind, ...ev } = rec;
      events.push(ev as TimedEvent);
    }
    // `kind: "final"` records are redundant with the `done` event's usage.
  }
  return summarizeEvents(events);
}
