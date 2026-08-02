import { Builtins, Cli, type CliOptions } from "clipanion";

import { RunCommand } from "./commands/run";
import { TraceCommand } from "./commands/trace";
import { ServeCommand } from "./commands/serve";
import { BuildCommand } from "./commands/build";
import { ChatCommand } from "./commands/chat";
import { SessionsCommand } from "./commands/sessions";

export function createCli(cfg: Partial<CliOptions>): Cli {
  const cli = new Cli(cfg);

  cli.register(Builtins.HelpCommand)
  cli.register(Builtins.VersionCommand)

  cli.register(RunCommand)
  cli.register(TraceCommand)
  cli.register(ServeCommand)
  cli.register(BuildCommand)
  cli.register(ChatCommand)
  cli.register(SessionsCommand)

  return cli;
}

export async function runCli(cfg: Partial<CliOptions>, argv: string[]): Promise<void> {
  const cli = createCli(cfg)

  await cli.runExit(argv, {
    stdin: process.stdin,
    stderr: process.stderr,
    stdout: process.stdout,
  })
}
