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
      out.write(`意图：${ev.expandedIntent}\n`);
      if (ev.assumptions.length) out.write(ev.assumptions.map((a) => `${C.dim}  · ${a}${C.reset}`).join("\n") + "\n");
      out.write(`${C.dim}置信度 ${Math.round(ev.confidence * 100)}%${ev.needsClarification ? " — 需要澄清" : ""}${C.reset}\n`);
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
      out.write(`${C.dim}叶子任务 → DAG：${C.reset}\n`);
      for (const t of ev.tasks) {
        const after = t.dependsOn.length ? ` ${C.dim}(依赖 ${t.dependsOn.join(", ")})${C.reset}` : "";
        const badge = t.kind === "contract" ? ` ${C.mag}◆契约${C.reset}` : "";
        out.write(`· ${t.id}${badge}${after} — ${t.title}\n`);
      }
      break;
    case "shared-edit":
      out.write(
        `  ${C.mag}◆ 共享编辑${C.reset} ${ev.taskId} → ${ev.file} ${C.dim}(所有者 ${ev.owner}，${ev.size})${C.reset}` +
          `${ev.dependents.length ? ` ${C.dim}涟漪至 ${ev.dependents.join(", ")}${C.reset}` : ""}\n`,
      );
      break;
    case "ripple":
      out.write(`  ${C.yellow}↝ 涟漪${C.reset} ${ev.file} → 重新验证 ${ev.dependents.join(", ") || "（尚无已构建的依赖方）"}\n`);
      break;
    case "audit": {
      const ok = ev.sound && !ev.canFalsePass;
      const mark = ok ? `${C.green}✓ 可靠${C.reset}` : `${C.yellow}⚠ 偏弱${C.reset}`;
      out.write(`  测试审计 ${ev.taskId}：${mark}${ev.issues.length ? ` ${C.dim}— ${ev.issues.join("; ")}${C.reset}` : ""}\n`);
      break;
    }
    case "wave":
      out.write(`第 ${ev.index} 波：${ev.taskIds.join(", ")}\n`);
      break;
    case "task-status": {
      const marks: Record<string, string> = {
        revising: `  ${C.yellow}↻ ${ev.taskId}：测试被判偏弱，重写中（${ev.detail ?? ""}）${C.reset}`,
        merged: `  ${C.green}已合并 ${ev.taskId}${C.reset}`,
        "merge-conflict": `  ${C.red}✗ ${ev.taskId} 合并冲突${C.reset}${ev.detail ? `：${ev.detail}` : ""}`,
        passing: `  ${C.green}✓ ${ev.taskId}${C.reset}`,
        failing: `  ${C.red}✗ ${ev.taskId} 仍未通过${C.reset}`,
        fixing: `  ${C.yellow}${ev.taskId}：修复中（${ev.detail ?? ""}）${C.reset}`,
        rippling: `  ${C.yellow}↝ ${ev.taskId}：${ev.detail ?? "共享变更后重新验证"}${C.reset}`,
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
    case "integration": {
      const label: Record<string, string> = {
        plan: "规划集成关卡",
        generate: "生成端到端测试",
        up: "拉起应用",
        run: "运行集成测试",
        fix: "修复实现",
      };
      out.write(`  ${C.cyan}▸ ${label[ev.step] ?? ev.step}${C.reset}${ev.detail ? ` ${C.dim}${ev.detail}${C.reset}` : ""}\n`);
      break;
    }
    case "integration-report": {
      if (!ev.applicable) {
        out.write(`${C.dim}集成关卡：跳过 — ${ev.detail}${C.reset}\n`);
        break;
      }
      const mark = ev.passed ? `${C.green}✓ 集成通过${C.reset}` : `${C.red}✗ 集成未通过${C.reset}`;
      out.write(`${mark}${ev.scenarios.length ? ` ${C.dim}(${ev.scenarios.join(", ")})${C.reset}` : ""}\n`);
      if (!ev.passed) out.write(`${C.dim}${ev.detail}${C.reset}\n`);
      break;
    }
    case "report":
      out.write(`\n${C.bold}━━ 报告 ━━${C.reset}\n`);
      for (const o of ev.outcomes) {
        const mark = o.passed ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
        out.write(`${mark} ${o.id} — ${o.detail.split("\n")[0]}\n`);
      }
      const passed = ev.outcomes.filter((o) => o.passed).length;
      out.write(`\n${passed}/${ev.outcomes.length} 个任务通过验收。\n`);
      break;
    case "error":
      out.write(`${C.red}错误：${C.reset} ${ev.message}\n`);
      break;
    case "done":
      break;
  }
}
