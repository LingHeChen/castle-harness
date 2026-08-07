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
type BuildListEntry = { id: string; createdAt: number; goal: string; taskCount: number; passed: number; total: number; done: boolean };

type BalanceResult =
  | { ok: true; isAvailable: boolean; infos: Array<{ currency: string; totalBalance: string; grantedBalance: string; toppedUpBalance: string }> }
  | { ok: false; error: string };

type ClarifyQ = { question: string; why: string; options?: string[] };
type ServerMsg =
  | BuildEvent
  | { type: "build-started"; buildId?: string }
  | { type: "build-ended" }
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

  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [builds, setBuilds] = useState<BuildListEntry[]>([]);
  const [openBuildId, setOpenBuildId] = useState<string | null>(null);

  async function refreshRuns() {
    const r = await fetch("/api/runs");
    setRuns((await r.json()) as RunListEntry[]);
  }

  async function refreshBuilds() {
    try {
      setBuilds((await (await fetch("/api/builds")).json()) as BuildListEntry[]);
    } catch {
      /* ignore */
    }
  }

  async function refreshBalance() {
    try {
      setBalance((await (await fetch("/api/balance")).json()) as BalanceResult);
    } catch {
      setBalance({ ok: false, error: "无法获取" });
    }
  }

  useEffect(() => {
    refreshRuns();
    refreshBuilds();
    refreshBalance();
    const t = setInterval(refreshBalance, 60_000); // 余额每分钟刷新一次
    // Deep-link: /build/<id> opens that build read-only; back/forward navigates.
    const route = () => {
      const m = location.pathname.match(/^\/build\/([\w.-]+)$/);
      if (m) void openBuild(m[1]!, false);
    };
    route();
    window.addEventListener("popstate", route);
    return () => {
      clearInterval(t);
      window.removeEventListener("popstate", route);
    };
  }, []);

  async function openRun(id: string) {
    setLive(null);
    setBuildEvents(null);
    setOpenBuildId(null);
    setSelected(id);
    if (location.pathname !== "/") history.pushState(null, "", "/");
    const r = await fetch(`/api/runs/${id}`);
    setSummary(r.ok ? ((await r.json()) as RunSummary) : null);
  }

  /** Open a persisted build read-only by replaying its event log. */
  async function openBuild(id: string, push = true) {
    setLive(null);
    setSummary(null);
    setSelected(null);
    setPending(null);
    setBuilding(false);
    setOpenBuildId(id);
    if (push && location.pathname !== `/build/${id}`) history.pushState(null, "", `/build/${id}`);
    try {
      const events = (await (await fetch(`/api/builds/${id}/events`)).json()) as BuildEvent[];
      setBuildEvents(events);
    } catch {
      setBuildEvents([]);
    }
  }

  function startBuild(goal: string) {
    driveBuild({ type: "build", goal }, true);
  }

  function resumeBuild(id: string) {
    driveBuild({ type: "build", resume: id }, false);
  }

  /** Open a build WebSocket and stream it live. `payload` is the start/resume msg. */
  function driveBuild(payload: { type: "build"; goal?: string; resume?: string }, resetUrl: boolean) {
    if (building || running) return;
    setSelected(null);
    setSummary(null);
    setLive(null);
    const events: BuildEvent[] = [];
    setBuildEvents([]);
    setBuilding(true);
    if (resetUrl) setOpenBuildId(null);

    setPending(null);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/build`);
    buildWsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify(payload));
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data) as ServerMsg;
      if (ev.type === "build-started") {
        // The build now has an id — reflect it in the URL so it's shareable/reloadable.
        if (ev.buildId) {
          setOpenBuildId(ev.buildId);
          history.pushState(null, "", `/build/${ev.buildId}`);
        }
        return;
      }
      if (ev.type === "build-ended") {
        setBuilding(false);
        setPending(null);
        ws.close();
        refreshRuns();
        refreshBuilds();
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
        <Balance balance={balance} />
        <NewRun onStart={startRun} running={running} />
        <NewBuild onStart={startBuild} building={building} />

        <div className="runs-header">构建</div>
        <ul className="runs">
          {builds.map((b) => (
            <li key={b.id} className={openBuildId === b.id ? "run active" : "run"} onClick={() => openBuild(b.id)}>
              <div className="run-id">{b.goal.slice(0, 40)}</div>
              <div className="run-meta">
                {b.done ? `${b.passed}/${b.total} 通过` : "进行中"} · {b.taskCount} 任务 · {b.id.replace(/^bld-/, "")}
              </div>
            </li>
          ))}
          {builds.length === 0 && <li className="empty">暂无构建</li>}
        </ul>

        <div className="runs-header">运行记录</div>
        <ul className="runs">
          {runs.map((r) => (
            <li
              key={r.id}
              className={selected === r.id ? "run active" : "run"}
              onClick={() => openRun(r.id)}
            >
              <div className="run-id">{r.id.replace(/^run-/, "")}</div>
              <div className="run-meta">
                {r.steps} 步 · {r.compactions} ⟲ · {pct(r.hitRate)} 命中
              </div>
            </li>
          ))}
          {runs.length === 0 && <li className="empty">暂无运行记录</li>}
        </ul>
      </aside>

      <main className="main">
        {buildEvents ? (
          <BuildView
            events={buildEvents}
            running={building}
            pending={pending}
            respond={respond}
            onResume={openBuildId && !building ? () => resumeBuild(openBuildId) : undefined}
          />
        ) : view ? (
          <RunDetail summary={view} live={live !== null} running={running} />
        ) : (
          <div className="placeholder">选择一条运行记录、启动一个 agent，或发起一次构建。</div>
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
          {live ? (running ? <span className="badge live">● 实时</span> : <span className="badge done">完成</span>) : null}
          <span className="stat">{summary.steps.length} 步</span>
          <span className="stat">{summary.compactions.length} 次压缩</span>
          {t && <span className="stat">{pct(t.hitRate)} 缓存命中</span>}
          {t && <span className="stat">{t.inputTokens.toLocaleString()} 输入 tok</span>}
        </div>
      </div>
      <section className="panel">
        <h2>KV-cache 曲线</h2>
        <CacheChart steps={summary.steps} />
        <p className="hint">
          柱 = 输入 token（缓存 vs 未缓存）· 线 = 缓存命中率。凹陷标记每次压缩后紧接着的缓存重置。
        </p>
      </section>
      <section className="panel">
        <h2>时间线</h2>
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
        placeholder="给 agent 一个任务…"
        value={task}
        onChange={(e) => setTask(e.target.value)}
        rows={3}
      />
      <div className="newrun-row">
        <input
          className="budget"
          placeholder="预算"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
        />
        <label className="compact-toggle">
          <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} /> 压缩
        </label>
        <button disabled={running || !task.trim()}>{running ? "运行中…" : "运行"}</button>
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
      <textarea placeholder="构建一个特性 / 微服务（规格 → 测试 → 并行开发）…" value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} />
      <div className="newrun-row">
        <span className="build-hint">自主</span>
        <button disabled={building || !goal.trim()}>{building ? "构建中…" : "构建"}</button>
      </div>
    </form>
  );
}

function Balance({ balance }: { balance: BalanceResult | null }) {
  if (!balance) return <div className="balance loading">余额加载中…</div>;
  if (!balance.ok) return <div className="balance err" title={balance.error}>DeepSeek 余额不可用</div>;
  const cny = balance.infos.find((i) => i.currency === "CNY") ?? balance.infos[0];
  return (
    <div className={`balance ${balance.isAvailable ? "ok" : "low"}`} title="DeepSeek 账户余额">
      <span className="balance-label">DeepSeek 余额</span>
      {cny ? (
        <span className="balance-amt">
          {cny.totalBalance} {cny.currency}
        </span>
      ) : (
        <span className="balance-amt">—</span>
      )}
    </div>
  );
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

createRoot(document.getElementById("root")!).render(<App />);
