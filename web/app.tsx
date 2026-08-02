import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { summarizeEvents, type RunSummary, type TimedEvent } from "../src/core/analysis";
import type { AgentEvent } from "../src/core/events";
import { CacheChart } from "./CacheChart";
import { Timeline } from "./Timeline";

type RunListEntry = { id: string; steps: number; compactions: number; totalTokens: number; hitRate: number };

function App() {
  const [runs, setRuns] = useState<RunListEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);

  // Live-run state
  const [live, setLive] = useState<TimedEvent[] | null>(null);
  const [running, setRunning] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  async function refreshRuns() {
    const r = await fetch("/api/runs");
    setRuns((await r.json()) as RunListEntry[]);
  }

  useEffect(() => {
    refreshRuns();
  }, []);

  async function openRun(id: string) {
    setLive(null);
    setSelected(id);
    const r = await fetch(`/api/runs/${id}`);
    setSummary(r.ok ? ((await r.json()) as RunSummary) : null);
  }

  function startRun(task: string, budget: number | undefined, compact: boolean) {
    if (running) return;
    setSelected(null);
    setSummary(null);
    const events: TimedEvent[] = [];
    setLive([]);
    setRunning(true);

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/run`);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "start", task, contextBudget: budget, compact }));
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data) as AgentEvent | { type: "run-started" | "run-ended"; runId: string };
      if (ev.type === "run-ended") {
        setRunning(false);
        ws.close();
        refreshRuns();
        return;
      }
      if (ev.type === "run-started") return;
      events.push({ ...(ev as AgentEvent), ts: Date.now() });
      setLive([...events]);
    };
    ws.onclose = () => setRunning(false);
  }

  const view = live ? summarizeEvents(live) : summary;

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>
          <span className="logo">▚</span> castle
        </h1>
        <NewRun onStart={startRun} running={running} />
        <div className="runs-header">runs</div>
        <ul className="runs">
          {runs.map((r) => (
            <li
              key={r.id}
              className={selected === r.id ? "run active" : "run"}
              onClick={() => openRun(r.id)}
            >
              <div className="run-id">{r.id.replace(/^run-/, "")}</div>
              <div className="run-meta">
                {r.steps} steps · {r.compactions} ⟲ · {pct(r.hitRate)} hit
              </div>
            </li>
          ))}
          {runs.length === 0 && <li className="empty">no runs yet</li>}
        </ul>
      </aside>

      <main className="main">
        {view ? (
          <RunDetail summary={view} live={live !== null} running={running} />
        ) : (
          <div className="placeholder">Select a run, or start a new one.</div>
        )}
      </main>
    </div>
  );
}

function RunDetail({ summary, live, running }: { summary: RunSummary; live: boolean; running: boolean }) {
  const t = summary.total;
  return (
    <>
      <div className="detail-header">
        <div>
          {live ? (running ? <span className="badge live">● live</span> : <span className="badge done">done</span>) : null}
          <span className="stat">{summary.steps.length} steps</span>
          <span className="stat">{summary.compactions.length} compactions</span>
          {t && <span className="stat">{pct(t.hitRate)} cache hit</span>}
          {t && <span className="stat">{t.inputTokens.toLocaleString()} input tok</span>}
        </div>
      </div>
      <section className="panel">
        <h2>KV-cache curve</h2>
        <CacheChart steps={summary.steps} />
        <p className="hint">
          bars = input tokens (cached vs uncached) · line = cache-hit %. Dips mark cache resets right after
          compaction.
        </p>
      </section>
      <section className="panel">
        <h2>Timeline</h2>
        <Timeline events={summary.events} />
      </section>
    </>
  );
}

function NewRun({ onStart, running }: { onStart: (task: string, budget: number | undefined, compact: boolean) => void; running: boolean }) {
  const [task, setTask] = useState("");
  const [budget, setBudget] = useState("");
  const [compact, setCompact] = useState(true);
  return (
    <form
      className="newrun"
      onSubmit={(e) => {
        e.preventDefault();
        if (task.trim()) onStart(task.trim(), budget ? Number(budget) : undefined, compact);
      }}
    >
      <textarea
        placeholder="Give the agent a task…"
        value={task}
        onChange={(e) => setTask(e.target.value)}
        rows={3}
      />
      <div className="newrun-row">
        <input
          className="budget"
          placeholder="budget"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
        />
        <label className="compact-toggle">
          <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} /> compact
        </label>
        <button disabled={running || !task.trim()}>{running ? "running…" : "run"}</button>
      </div>
    </form>
  );
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

createRoot(document.getElementById("root")!).render(<App />);
