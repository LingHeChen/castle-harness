import { Option, Command, type Usage } from "clipanion";
import { resolve } from "node:path";
import { startServer } from "../server";

export class ServeCommand extends Command {
  static override paths = [["serve"]];

  static override usage?: Usage = Command.Usage({
    description: "Start the web dashboard (trace viewer + live agent runs)",
    examples: [["Serve on port 3000", "castle serve --port 3000"]],
  });

  port = Option.String("--port", "3000", { description: "Port to listen on" });
  cwd = Option.String("--cwd", { description: "Working dir that runs/builds operate in (default: current dir)" });

  override async execute(): Promise<number | void> {
    const port = Number.parseInt(this.port, 10) || 3000;
    const cwd = this.cwd ? resolve(this.cwd) : process.cwd();
    const server = startServer(port, cwd);
    this.context.stdout.write(`\x1b[36mcastle dashboard\x1b[0m → http://localhost:${server.port}  \x1b[2m(cwd: ${cwd})\x1b[0m\n`);
    // Keep the process alive.
    await new Promise<void>(() => {});
  }
}
