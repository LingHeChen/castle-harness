import { Option, Command, type Usage } from "clipanion";
import { resolve } from "node:path";
import { build } from "../build/orchestrator";
import { renderBuildEvent } from "../build/render";

export class BuildCommand extends Command {
  static override paths = [["build"]];

  static override usage?: Usage = Command.Usage({
    description: "规格驱动的自主开发：理解 → 分解 → 测试 → 并行构建 → 验收 → 集成关卡",
    examples: [
      ["构建一个特性", 'castle build "给 API 加一个限流器"'],
      ["从零一次性造一个微服务（空目录亦可）", 'castle build "一个 todo 微服务，REST API + 持久化" --oneshot --cwd ./svc'],
      ["续跑一个中断的构建", "castle build --resume bld-1785932731537 --cwd ./svc"],
    ],
  });

  goal = Option.String({ required: false });
  cwd = Option.String("--cwd", { description: "目标目录（默认当前目录；空目录/非 git 目录会自动初始化）" });
  model = Option.String("--model", { description: "模型 id（默认 deepseek-chat）" });
  yes = Option.Boolean("--yes", false, { description: "自主模式：跳过澄清，按假设推进" });
  oneshot = Option.Boolean("--oneshot", false, { description: "一次性从零建造：全自主（跳过所有 HIL），一路跑到集成关卡通过" });
  fixAttempts = Option.String("--fix-attempts", "2", { description: "每个失败任务的最大修复次数" });
  auditAttempts = Option.String("--audit-attempts", "1", { description: "偏弱的测试被打回重写的次数" });
  maxDepth = Option.String("--max-depth", "3", { description: "递归分解的深度上限" });
  confidence = Option.String("--confidence", "0.75", { description: "低于此置信度则触发澄清（0..1）" });
  noIntegration = Option.Boolean("--no-integration", false, { description: "跳过集成关卡（第 6 阶段）" });
  concurrency = Option.String("--concurrency", "4", { description: "同时在跑的子 agent 上限（真并行的并发度）" });
  resume = Option.String("--resume", { description: "续跑已有构建：传 build id，复用已保存的计划，跳过已完成任务" });

  override async execute(): Promise<number | void> {
    if (!this.goal && !this.resume) {
      this.context.stderr.write("\x1b[31m需要一个目标，或用 --resume <build-id> 续跑。\x1b[0m\n");
      return 1;
    }
    const outcomes = await build(this.goal ?? "", {
      cwd: this.cwd ? resolve(this.cwd) : process.cwd(),
      model: this.model,
      buildId: this.resume,
      resume: Boolean(this.resume),
      maxFixAttempts: Number.parseInt(this.fixAttempts, 10) || 2,
      maxAuditAttempts: Number.parseInt(this.auditAttempts, 10) || 1,
      maxDepth: Number.parseInt(this.maxDepth, 10) || 3,
      confidenceThreshold: Number.parseFloat(this.confidence) || 0.75,
      integration: !this.noIntegration,
      concurrency: Number.parseInt(this.concurrency, 10) || 4,
      emit: renderBuildEvent,
      // CLI：交互式澄清（除非 --yes / --oneshot 全自主）。计划的审阅/编辑交给 Web UI。
      clarify:
        this.yes || this.oneshot
          ? undefined
          : async (questions) =>
              questions.map((q) => {
                const opts = q.options.length ? "\n" + q.options.map((o, i) => `  ${i + 1}) ${o}`).join("\n") : "";
                const ans = prompt(`\n? ${q.question}\n  （原因：${q.why}）${opts}\n> 选项编号或直接输入（留空=用默认假设）：`) ?? "";
                const n = Number.parseInt(ans, 10);
                return q.options.length && n >= 1 && n <= q.options.length ? q.options[n - 1]! : ans;
              }),
    }).catch((err) => {
      this.context.stderr.write(`\x1b[31m构建失败：\x1b[0m ${(err as Error).message}\n`);
      return null;
    });

    if (!outcomes) return 1;
    return outcomes.every((o) => o.passed) ? 0 : 1;
  }
}
