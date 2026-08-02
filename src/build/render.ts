import type { BuildEvent } from "./events";

const C = { dim: "\x1b[2m", reset: "\x1b[0m", cyan: "\x1b[36m", bold: "\x1b[1m", mag: "\x1b[35m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m" };
const out = process.stdout;

/** Renders the build pipeline's event stream to the terminal. */
export function renderBuildEvent(ev: BuildEvent): void {
  switch (ev.type) {
    case "phase":
      out.write(`\n${C.bold}${C.cyan}━━ ${ev.n} · ${ev.title} ━━${C.reset}\n`);
      break;
    case "intent":
      out.write(`intent: ${ev.expandedIntent}\n`);
      if (ev.assumptions.length) out.write(ev.assumptions.map((a) => `${C.dim}  · ${a}${C.reset}`).join("\n") + "\n");
      out.write(`${C.dim}confidence ${Math.round(ev.confidence * 100)}%${ev.needsClarification ? " — clarification needed" : ""}${C.reset}\n`);
      break;
    case "node": {
      const indent = "  ".repeat(ev.depth);
      const marker = ev.leaf ? `${C.green}•${C.reset}` : `${C.dim}▸${C.reset}`;
      out.write(`${indent}${marker} ${ev.title} ${C.dim}(${ev.id})${C.reset}\n`);
      break;
    }
    case "tree":
      break; // already streamed as `node` events above
    case "graph":
      out.write(`${C.dim}leaves → DAG:${C.reset}\n`);
      for (const t of ev.tasks) {
        const after = t.dependsOn.length ? ` ${C.dim}(after ${t.dependsOn.join(", ")})${C.reset}` : "";
        out.write(`· ${t.id}${after} — ${t.title}\n`);
      }
      break;
    case "audit": {
      const ok = ev.sound && !ev.canFalsePass;
      const mark = ok ? `${C.green}✓ sound${C.reset}` : `${C.yellow}⚠ weak${C.reset}`;
      out.write(`  audit ${ev.taskId}: ${mark}${ev.issues.length ? ` ${C.dim}— ${ev.issues.join("; ")}${C.reset}` : ""}\n`);
      break;
    }
    case "wave":
      out.write(`wave ${ev.index}: ${ev.taskIds.join(", ")}\n`);
      break;
    case "task-status": {
      const marks: Record<string, string> = {
        revising: `  ${C.yellow}↻ ${ev.taskId}: tests flagged, rewriting (${ev.detail ?? ""})${C.reset}`,
        merged: `  ${C.green}merged ${ev.taskId}${C.reset}`,
        "merge-conflict": `  ${C.red}✗ merge conflict on ${ev.taskId}${C.reset}${ev.detail ? `: ${ev.detail}` : ""}`,
        passing: `  ${C.green}✓ ${ev.taskId}${C.reset}`,
        failing: `  ${C.red}✗ ${ev.taskId} still failing${C.reset}`,
        fixing: `  ${C.yellow}${ev.taskId}: fixing (${ev.detail ?? ""})${C.reset}`,
      };
      if (marks[ev.status]) out.write(marks[ev.status] + "\n");
      break;
    }
    case "activity":
      out.write(`${C.dim}${C.mag}[${ev.taskId}/${ev.kind}]${C.reset}${C.dim} ▸ ${ev.action}${C.reset}\n`);
      break;
    case "log":
      out.write(`${ev.message}\n`);
      break;
    case "report":
      out.write(`\n${C.bold}━━ report ━━${C.reset}\n`);
      for (const o of ev.outcomes) {
        const mark = o.passed ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
        out.write(`${mark} ${o.id} — ${o.detail.split("\n")[0]}\n`);
      }
      const passed = ev.outcomes.filter((o) => o.passed).length;
      out.write(`\n${passed}/${ev.outcomes.length} tasks passed acceptance.\n`);
      break;
    case "error":
      out.write(`${C.red}error:${C.reset} ${ev.message}\n`);
      break;
    case "done":
      break;
  }
}
