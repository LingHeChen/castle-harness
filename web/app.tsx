import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { summarizeEvents, type RunSummary, type TimedEvent } from "../src/core/analysis";
import type { AgentEvent } from "../src/core/events";
import type { BuildEvent } from "../src/build/events";
import type { Task } from "../src/build/schemas";
import { CacheChart } from "./CacheChart";
import { Timeline } from "./Timeline";
import { BuildView, type PendingRequest } from "./BuildView";

type RunListEntry = { id: string; steps: number; compactions: number; totalTokens: number; hitRate: number };

type ClarifyQ = { question: string; why: string };
type ServerMsg =
  | BuildEvent
  | { type: "build-started" | "build-ended" }
  | { type: "clarify-request"; questions: ClarifyQ[] }
  | { type: "approval-request"; tasks: Task[]; tree?: unknown };

function App() {
  const [runs, setRuns] = useState<RunListEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);

  // Live-run state
  const [live, setLive] = useState<TimedEvent[] | null>(null);
  const [running, setRunning] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Build-pipeline state
  const [buildEvents, setBuildEvents] = useState<BuildEvent[] | null>(null);
  const [building, setBuilding] = useState(false);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const buildWsRef = useRef<WebSocket | null>(null);

  function respond(msg: object) {
    buildWsRef.current?.send(JSON.stringify(msg));
    setPending(null);
  }

  async function refreshRuns() {
    const r = await fetch("/api/runs");
    setRuns((await r.json()) as RunListEntry[]);
  }

  useEffect(() => {
    refreshRuns();
  }, []);

  async function openRun(id: string) {
    setLive(null);
    setBuildEvents(null);
    setSelected(id);
    const r = await fetch(`/api/runs/${id}`);
    setSummary(r.ok ? ((await r.json()) as RunSummary) : null);
  }

  function startBuild(goal: string) {
    if (building || running) return;
    setSelected(null);
    setSummary(null);
    setLive(null);
    const events: BuildEvent[] = [];
    setBuildEvents([]);
    setBuilding(true);

    setPending(null);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/build`);
    buildWsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "build", goal }));
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data) as ServerMsg;
      if (ev.type === "build-started") return;
      if (ev.type === "build-ended") {
        setBuilding(false);
        setPending(null);
        ws.close();
        refreshRuns();
        return;
      }
      // Checkpoint requests pause the pipeline waiting for the user.
      if (ev.type === "clarify-request") {
        setPending({ kind: "clarify", questions: ev.questions });
        return;
      }
      if (ev.type === "approval-request") {
        setPending({ kind: "approval", tasks: ev.tasks });
        return;
      }
      events.push(ev as BuildEvent);
      setBuildEvents([...events]);
    };
    ws.onclose = () => setBuilding(false);
  }

  function startRun(task: string, budget: number | undefined, compact: boolean) {
    if (running) return;
    setSelected(null);
    setSummary(null);
    setBuildEvents(null);
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
        <NewBuild onStart={startBuild} building={building} />
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
        {buildEvents ? (
          <BuildView events={buildEvents} running={building} pending={pending} respond={respond} />
        ) : view ? (
          <RunDetail summary={view} live={live !== null} running={running} />
        ) : (
          <div className="placeholder">Select a run, start an agent, or kick off a build.</div>
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

function NewBuild({ onStart, building }: { onStart: (goal: string) => void; building: boolean }) {
  const [goal, setGoal] = useState("");
  return (
    <form
      className="newrun newbuild"
      onSubmit={(e) => {
        e.preventDefault();
        if (goal.trim()) onStart(goal.trim());
      }}
    >
      <textarea placeholder="Build a feature (spec → tests → parallel dev)…" value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} />
      <div className="newrun-row">
        <span className="build-hint">autonomous</span>
        <button disabled={building || !goal.trim()}>{building ? "building…" : "build"}</button>
      </div>
    </form>
  );
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

createRoot(document.getElementById("root")!).render(<App />);
