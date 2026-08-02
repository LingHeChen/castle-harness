import { Option, Command, type Usage } from "clipanion";
import { resolve } from "node:path";
import { ChatSession, latestSessionId } from "../core/session";
import { Tracer } from "../core/trace";
import { TerminalRenderer } from "../render";

export class ChatCommand extends Command {
  static override paths = [["chat"]];

  static override usage?: Usage = Command.Usage({
    description: "Interactive multi-turn session (history persists to disk, resumable)",
    examples: [
      ["Start a chat", "castle chat"],
      ["Resume the last session", "castle chat --continue"],
    ],
  });

  cwd = Option.String("--cwd", { description: "Working directory (default: current dir)" });
  model = Option.String("--model", { description: "Model id (default: deepseek-chat)" });
  resumeId = Option.String("--resume", { description: "Resume a specific session id" });
  continueLast = Option.Boolean("--continue,-c", false, { description: "Resume the most recent session" });
  maxSteps = Option.String("--max-steps", "30", { description: "Max agent steps per turn" });

  override async execute(): Promise<number | void> {
    const cwd = this.cwd ? resolve(this.cwd) : process.cwd();
    const out = this.context.stdout;

    let resumeId = this.resumeId;
    if (!resumeId && this.continueLast) {
      resumeId = (await latestSessionId(cwd)) ?? undefined;
      if (!resumeId) out.write("\x1b[2mno prior session to continue; starting a new one\x1b[0m\n");
    }

    let session: ChatSession;
    try {
      session = await ChatSession.start({ cwd, model: this.model, resumeId, maxSteps: Number.parseInt(this.maxSteps, 10) || 30 });
    } catch (err) {
      this.context.stderr.write(`\x1b[31mfailed to start:\x1b[0m ${(err as Error).message}\n`);
      return 1;
    }

    out.write(`\x1b[36mcastle chat\x1b[0m \x1b[2m· ${session.id}${session.turns ? ` (resumed, ${session.turns} turns)` : ""} · ${cwd}\x1b[0m\n`);
    out.write(`\x1b[2mtype a message, /help for commands, /exit or Ctrl-D to quit\x1b[0m\n`);

    try {
      for (;;) {
        const input = prompt("\n\x1b[1myou›\x1b[0m ");
        if (input === null) break; // Ctrl-D / EOF
        const line = input.trim();
        if (!line) continue;
        if (line === "/exit" || line === "/quit") break;
        if (line === "/help") {
          out.write("\x1b[2m  /exit, /quit  end the session\n  /help         this message\n\x1b[0m");
          continue;
        }

        const tracer = new Tracer(".castle/traces", `${session.id}-t${session.turns + 1}`);
        const renderer = new TerminalRenderer();
        try {
          for await (const ev of session.turn(line, tracer)) renderer.handle(ev);
        } catch (err) {
          this.context.stderr.write(`\x1b[31mturn failed:\x1b[0m ${(err as Error).message}\n`);
        } finally {
          tracer.close();
        }
      }
    } finally {
      session.close();
    }

    out.write(`\n\x1b[2msession saved: .castle/sessions/${session.id}.json — resume with 'castle chat --continue'\x1b[0m\n`);
    return 0;
  }
}
