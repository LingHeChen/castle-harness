import React from "react";
import type { TimedEvent } from "../src/core/analysis";

/**
 * Renders the agent's event stream as a scrolling timeline. Consecutive
 * text-delta events are coalesced into one assistant message so streaming reads
 * naturally.
 */
export function Timeline({ events }: { events: TimedEvent[] }) {
  const rows = coalesce(events);
  return (
    <div className="timeline">
      {rows.map((row, i) => (
        <Row key={i} row={row} />
      ))}
      {rows.length === 0 && <div className="chart-empty">no events yet</div>}
    </div>
  );
}

type Row =
  | { kind: "step"; step: number }
  | { kind: "text"; text: string }
  | { kind: "tool-call"; name: string; input: unknown }
  | { kind: "tool-result"; name: string; output: string; ms: number }
  | { kind: "compaction"; before: number; after: number; turns: number }
  | { kind: "done"; text: string }
  | { kind: "error"; message: string };

function coalesce(events: TimedEvent[]): Row[] {
  const rows: Row[] = [];
  for (const ev of events) {
    switch (ev.type) {
      case "step-start":
        rows.push({ kind: "step", step: ev.step });
        break;
      case "text-delta": {
        const last = rows[rows.length - 1];
        if (last && last.kind === "text") last.text += ev.text;
        else rows.push({ kind: "text", text: ev.text });
        break;
      }
      case "tool-call":
        rows.push({ kind: "tool-call", name: ev.name, input: ev.input });
        break;
      case "tool-result":
        rows.push({ kind: "tool-result", name: ev.name, output: ev.output, ms: ev.ms });
        break;
      case "compaction":
        rows.push({ kind: "compaction", before: ev.beforeTokens, after: ev.afterTokens, turns: ev.summarizedSegments });
        break;
      case "done":
        rows.push({ kind: "done", text: ev.text });
        break;
      case "error":
        rows.push({ kind: "error", message: ev.message });
        break;
    }
  }
  return rows;
}

function Row({ row }: { row: Row }) {
  switch (row.kind) {
    case "step":
      return <div className="tl-step">step {row.step}</div>;
    case "text":
      return <div className="tl-text">{row.text}</div>;
    case "tool-call":
      return (
        <div className="tl-tool">
          <span className="tl-tool-name">▸ {row.name}</span> <span className="tl-tool-arg">{summarize(row.input)}</span>
        </div>
      );
    case "tool-result":
      return (
        <div className="tl-result">
          <span className="tl-ms">{row.ms}ms</span> {clip(row.output, 240)}
        </div>
      );
    case "compaction":
      return (
        <div className="tl-compaction">
          ⟲ compacted {row.turns} turns · {row.before} → {row.after} tokens
        </div>
      );
    case "done":
      return <div className="tl-done">✓ {row.text}</div>;
    case "error":
      return <div className="tl-error">✗ {row.message}</div>;
  }
}

function summarize(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") return o.command;
    if (typeof o.path === "string") return o.path;
  }
  return clip(JSON.stringify(input ?? {}), 100);
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}
