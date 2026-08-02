import { Option, Command, type Usage } from "clipanion";
import { resolve } from "node:path";
import { listSessions } from "../core/session";

export class SessionsCommand extends Command {
  static override paths = [["sessions"]];

  static override usage?: Usage = Command.Usage({
    description: "List saved chat sessions in this project",
    examples: [["List sessions", "castle sessions"]],
  });

  cwd = Option.String("--cwd", { description: "Working directory (default: current dir)" });

  override async execute(): Promise<number | void> {
    const cwd = this.cwd ? resolve(this.cwd) : process.cwd();
    const sessions = await listSessions(cwd);
    const out = this.context.stdout;

    if (sessions.length === 0) {
      out.write("\x1b[2mno saved sessions\x1b[0m\n");
      return 0;
    }
    for (const s of sessions) {
      out.write(`\x1b[36m${s.id}\x1b[0m  \x1b[2m${s.turns} turns · ${s.preview}\x1b[0m\n`);
    }
    out.write(`\n\x1b[2mresume the latest with 'castle chat --continue', or a specific one with '--resume <id>'\x1b[0m\n`);
    return 0;
  }
}
