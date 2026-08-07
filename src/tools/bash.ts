import { tool } from "ai";
import { z } from "zod";
import { truncate } from "../core/util";
import type { ToolContext } from "./index";

/** A shell command that never returns must not freeze the whole build. */
const DEFAULT_TIMEOUT_MS = 120_000;

export function bashTool(ctx: ToolContext) {
  const timeoutMs = ctx.bashTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return tool({
    description:
      "Run a shell command in the working directory. Returns the exit code and " +
      "combined stdout/stderr. Use for tests, git, grep, builds — anything the " +
      "dedicated file tools don't cover. Commands are killed after a timeout, so " +
      "for a long-running process (a server) start it in the BACKGROUND with '&' " +
      "and redirect output to a file (e.g. `bun run server.ts > /tmp/s.log 2>&1 &`), " +
      "then poll — never run a server in the foreground.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute, e.g. 'bun test'."),
    }),
    execute: async ({ command }) => {
      // `sh -c <command>` as a single argv (no re-parse → no injection surprises).
      // stdin is ignored so a command that reads stdin gets EOF instead of blocking.
      const proc = Bun.spawn(["sh", "-c", command], { cwd: ctx.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const outP = new Response(proc.stdout).text().catch(() => "");
      const errP = new Response(proc.stderr).text().catch(() => "");

      // Bound the wait on process exit; on timeout, kill it and move on.
      const exit = await Promise.race([proc.exited, after(timeoutMs, "timeout" as const)]);
      const timedOut = exit === "timeout";
      if (timedOut) {
        proc.kill("SIGKILL");
        await Promise.race([proc.exited, after(1000, null)]);
      }

      // Read whatever output is buffered, but with a short grace: a backgrounded
      // child holding the pipe open must not hang us after the parent has exited.
      const [stdout, stderr] = await Promise.race([Promise.all([outP, errP]), after(1000, ["", ""] as [string, string])]);
      let out = stdout;
      if (stderr) out += (out ? "\n" : "") + stderr;
      out = out.trim() || "(no output)";

      if (timedOut) {
        return truncate(
          `error: 命令超过 ${Math.round(timeoutMs / 1000)}s 未结束，已被杀掉。若需要常驻进程（如服务器），` +
            `请用 '&' 放到后台并把输出重定向到文件，再轮询，不要在前台运行。\n${out}`,
          ctx.maxOutput,
        );
      }
      return truncate(`exit=${proc.exitCode}\n${out}`, ctx.maxOutput);
    },
  });
}

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
