import React, { useState } from "react";
import type { BuildEvent, BuildTask, TaskStatus } from "../src/build/events";
import type { Task } from "../src/build/schemas";
import { DagChart } from "./DagChart";
import { PlanEditor } from "./PlanEditor";

const PHASES = ["理解", "分解", "测试 + 审计", "开发", "验收", "集成"];

export type ClarifyQuestion = { question: string; why: string; options?: string[] };
export type PendingRequest =
  | { kind: "clarify"; questions: ClarifyQuestion[] }
  | { kind: "approval"; tasks: Task[] };

type Audit = { sound: boolean; canFalsePass: boolean; issues: string[] };
type SharedEdit = { taskId: string; file: string; owner: string; size: string; dependents: string[] };
type Integration = { applicable: boolean; passed: boolean; attempts: number; scenarios: string[]; detail: string };
type BuildState = {
  phase: number;
  intent?: { expandedIntent: string; assumptions: string[]; confidence: number; needsClarification: boolean };
  tasks: BuildTask[];
  waves: string[][];
  status: Record<string, TaskStatus>;
  activity: Record<string, string>;
  audits: Record<string, Audit>;
  sharedEdits: SharedEdit[];
  integrationStep?: string;
  integration?: Integration;
  report?: Array<{ id: string; passed: boolean; attempts: number; detail: string }>;
};

/** Fold the build event stream into renderable state (mirrors the CLI renderer). */
export function foldBuild(events: BuildEvent[]): BuildState {
  const s: BuildState = { phase: 0, tasks: [], waves: [], status: {}, activity: {}, audits: {}, sharedEdits: [] };
  for (const ev of events) {
    switch (ev.type) {
      case "phase":
        s.phase = ev.n;
        break;
      case "shared-edit":
        s.sharedEdits.push({ taskId: ev.taskId, file: ev.file, owner: ev.owner, size: ev.size, dependents: ev.dependents });
        break;
      case "integration":
        s.integrationStep = ev.step;
        break;
      case "integration-report":
        s.integration = { applicable: ev.applicable, passed: ev.passed, attempts: ev.attempts, scenarios: ev.scenarios, detail: ev.detail };
        s.integrationStep = undefined;
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
  onResume,
}: {
  events: BuildEvent[];
  running: boolean;
  pending: PendingRequest | null;
  respond: (msg: object) => void;
  onResume?: () => void;
}) {
  const s = foldBuild(events);
  const passed = s.report?.filter((o) => o.passed).length ?? 0;
  // A historical build that never finished (no report) can be resumed.
  const canResume = !!onResume && !running && !pending && !s.report;

  return (
    <>
      <div className="detail-header">
        {pending ? (
          <span className="badge waiting">● 等待你</span>
        ) : running ? (
          <span className="badge live">● 构建中</span>
        ) : s.report ? (
          <span className="badge done">完成</span>
        ) : null}
        {PHASES.map((p, i) => (
          <span key={p} className={`phase-pill ${s.phase > i ? "past" : ""} ${s.phase === i + 1 ? "current" : ""}`}>
            {i + 1} {p}
          </span>
        ))}
        {canResume && (
          <button className="resume-btn" onClick={onResume}>
            继续构建 →
          </button>
        )}
      </div>

      {pending?.kind === "clarify" && <ClarifyPanel questions={pending.questions} respond={respond} />}
      {pending?.kind === "approval" && <PlanEditor initial={pending.tasks} respond={respond} />}

      {s.intent && (
        <section className="panel">
          <h2>意图 · {Math.round(s.intent.confidence * 100)}% 置信度{s.intent.needsClarification ? " · 待澄清" : ""}</h2>
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
        <h2>任务图 · 并发波次</h2>
        <DagChart tasks={s.tasks} waves={s.waves} status={s.status} activity={s.activity} />
      </section>

      {s.sharedEdits.length > 0 && (
        <section className="panel">
          <h2>共享编辑协议 · {s.sharedEdits.length} 次协调变更</h2>
          <div className="shared-edits">
            {s.sharedEdits.map((e, i) => (
              <div key={i} className={`shared-edit size-${e.size}`}>
                <span className={`shared-size size-${e.size}`}>{e.size}</span>
                <span className="shared-file">{e.file}</span>
                <span className="shared-meta">{e.taskId} → 所有者 {e.owner}</span>
                <span className="shared-deps">涟漪至：{e.dependents.join(", ") || "无"}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {Object.keys(s.audits).length > 0 && (
        <section className="panel">
          <h2>验收测试审计</h2>
          <div className="audits">
            {s.tasks.map((t) => {
              const a = s.audits[t.id];
              if (!a) return null;
              const ok = a.sound && !a.canFalsePass;
              return (
                <div key={t.id} className={`audit-row ${ok ? "ok" : "weak"}`}>
                  <span className="audit-mark">{ok ? "✓ 可靠" : "⚠ 偏弱"}</span>
                  <span className="audit-task">{t.id}</span>
                  {a.issues.length > 0 && <span className="audit-issues">{a.issues.join("; ")}</span>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {(s.integrationStep || s.integration) && (
        <section className="panel">
          <h2>
            集成关卡
            {s.integration
              ? s.integration.applicable
                ? s.integration.passed
                  ? " · ✓ 通过"
                  : " · ✗ 未通过"
                : " · 跳过"
              : ` · ${s.integrationStep}…`}
          </h2>
          {s.integrationStep && !s.integration && <p className="hint">正在拉起应用并端到端地检验各处接缝…</p>}
          {s.integration && !s.integration.applicable && <p className="hint">{s.integration.detail}</p>}
          {s.integration?.applicable && (
            <div className={`integration ${s.integration.passed ? "ok" : "fail"}`}>
              {s.integration.scenarios.length > 0 && (
                <ul className="int-scenarios">
                  {s.integration.scenarios.map((sc, i) => (
                    <li key={i}>{sc}</li>
                  ))}
                </ul>
              )}
              {!s.integration.passed && <pre className="int-detail">{s.integration.detail}</pre>}
            </div>
          )}
        </section>
      )}

      {s.report && (
        <section className="panel">
          <h2>报告 · {passed}/{s.report.length} 通过</h2>
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

function ClarifyPanel({ questions, respond }: { questions: ClarifyQuestion[]; respond: (msg: object) => void }) {
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  const [custom, setCustom] = useState<boolean[]>(() => questions.map(() => false));
  const set = (i: number, v: string) => setAnswers(answers.map((a, j) => (j === i ? v : a)));
  const setCustomAt = (i: number, v: boolean) => setCustom(custom.map((c, j) => (j === i ? v : c)));

  return (
    <section className="panel checkpoint">
      <h2>⏸ 分解前 agent 需要你澄清</h2>
      {questions.map((q, i) => {
        const opts = q.options ?? [];
        return (
          <div key={i} className="clarify-q">
            <div className="clarify-question">{q.question}</div>
            <div className="clarify-why">{q.why}</div>
            {opts.length > 0 && (
              <div className="clarify-options">
                {opts.map((o) => (
                  <button
                    key={o}
                    type="button"
                    className={`clarify-option ${!custom[i] && answers[i] === o ? "selected" : ""}`}
                    onClick={() => {
                      setCustomAt(i, false);
                      set(i, o);
                    }}
                  >
                    {o}
                  </button>
                ))}
                <button
                  type="button"
                  className={`clarify-option other ${custom[i] ? "selected" : ""}`}
                  onClick={() => {
                    setCustomAt(i, true);
                    set(i, "");
                  }}
                >
                  其他…
                </button>
              </div>
            )}
            {(opts.length === 0 || custom[i]) && (
              <input
                value={answers[i]}
                autoFocus={custom[i]}
                placeholder="你的回答（留空则采用它的假设）"
                onChange={(e) => set(i, e.target.value)}
              />
            )}
          </div>
        );
      })}
      <button className="checkpoint-go" onClick={() => respond({ type: "clarify-response", answers })}>
        提交回答 →
      </button>
    </section>
  );
}

