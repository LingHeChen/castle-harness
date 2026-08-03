import React, { useState } from "react";
import type { BuildEvent, BuildTask, TaskStatus } from "../src/build/events";
import type { Task } from "../src/build/schemas";
import { DagChart } from "./DagChart";
import { PlanEditor } from "./PlanEditor";

const PHASES = ["understand", "decompose", "tests + audit", "develop", "acceptance"];

export type PendingRequest =
  | { kind: "clarify"; questions: Array<{ question: string; why: string }> }
  | { kind: "approval"; tasks: Task[] };

type Audit = { sound: boolean; canFalsePass: boolean; issues: string[] };
type BuildState = {
  phase: number;
  intent?: { expandedIntent: string; assumptions: string[]; confidence: number; needsClarification: boolean };
  tasks: BuildTask[];
  waves: string[][];
  status: Record<string, TaskStatus>;
  activity: Record<string, string>;
  audits: Record<string, Audit>;
  report?: Array<{ id: string; passed: boolean; attempts: number; detail: string }>;
};

/** Fold the build event stream into renderable state (mirrors the CLI renderer). */
export function foldBuild(events: BuildEvent[]): BuildState {
  const s: BuildState = { phase: 0, tasks: [], waves: [], status: {}, activity: {}, audits: {} };
  for (const ev of events) {
    switch (ev.type) {
      case "phase":
        s.phase = ev.n;
        break;
      case "intent":
        s.intent = ev;
        break;
      case "graph":
        s.tasks = ev.tasks;
        s.waves = ev.waves;
        for (const t of ev.tasks) s.status[t.id] ??= "pending";
        break;
      case "audit":
        s.audits[ev.taskId] = { sound: ev.sound, canFalsePass: ev.canFalsePass, issues: ev.issues };
        break;
      case "task-status":
        s.status[ev.taskId] = ev.status;
        break;
      case "activity":
        s.activity[ev.taskId] = ev.action;
        break;
      case "report":
        s.report = ev.outcomes;
        break;
    }
  }
  return s;
}

export function BuildView({
  events,
  running,
  pending,
  respond,
}: {
  events: BuildEvent[];
  running: boolean;
  pending: PendingRequest | null;
  respond: (msg: object) => void;
}) {
  const s = foldBuild(events);
  const passed = s.report?.filter((o) => o.passed).length ?? 0;

  return (
    <>
      <div className="detail-header">
        {pending ? (
          <span className="badge waiting">● awaiting you</span>
        ) : running ? (
          <span className="badge live">● building</span>
        ) : s.report ? (
          <span className="badge done">done</span>
        ) : null}
        {PHASES.map((p, i) => (
          <span key={p} className={`phase-pill ${s.phase > i ? "past" : ""} ${s.phase === i + 1 ? "current" : ""}`}>
            {i + 1} {p}
          </span>
        ))}
      </div>

      {pending?.kind === "clarify" && <ClarifyPanel questions={pending.questions} respond={respond} />}
      {pending?.kind === "approval" && <PlanEditor initial={pending.tasks} respond={respond} />}

      {s.intent && (
        <section className="panel">
          <h2>intent · {Math.round(s.intent.confidence * 100)}% confidence{s.intent.needsClarification ? " · clarify" : ""}</h2>
          <p className="intent">{s.intent.expandedIntent}</p>
          {s.intent.assumptions.length > 0 && (
            <ul className="assumptions">
              {s.intent.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="panel">
        <h2>task graph · concurrency waves</h2>
        <DagChart tasks={s.tasks} waves={s.waves} status={s.status} activity={s.activity} />
      </section>

      {Object.keys(s.audits).length > 0 && (
        <section className="panel">
          <h2>acceptance-test audit</h2>
          <div className="audits">
            {s.tasks.map((t) => {
              const a = s.audits[t.id];
              if (!a) return null;
              const ok = a.sound && !a.canFalsePass;
              return (
                <div key={t.id} className={`audit-row ${ok ? "ok" : "weak"}`}>
                  <span className="audit-mark">{ok ? "✓ sound" : "⚠ weak"}</span>
                  <span className="audit-task">{t.id}</span>
                  {a.issues.length > 0 && <span className="audit-issues">{a.issues.join("; ")}</span>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {s.report && (
        <section className="panel">
          <h2>report · {passed}/{s.report.length} passed</h2>
          <div className="report">
            {s.report.map((o) => (
              <div key={o.id} className={`report-row ${o.passed ? "ok" : "fail"}`}>
                <span>{o.passed ? "✓" : "✗"}</span> <span className="report-id">{o.id}</span>
                <span className="report-detail">{o.detail.split("\n")[0]}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function ClarifyPanel({ questions, respond }: { questions: Array<{ question: string; why: string }>; respond: (msg: object) => void }) {
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  return (
    <section className="panel checkpoint">
      <h2>⏸ the agent needs to clarify before decomposing</h2>
      {questions.map((q, i) => (
        <div key={i} className="clarify-q">
          <div className="clarify-question">{q.question}</div>
          <div className="clarify-why">{q.why}</div>
          <input
            value={answers[i]}
            placeholder="your answer (blank = use its assumption)"
            onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
          />
        </div>
      ))}
      <button className="checkpoint-go" onClick={() => respond({ type: "clarify-response", answers })}>
        send answers →
      </button>
    </section>
  );
}

