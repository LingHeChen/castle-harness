import { runCli } from "../src/cli.ts";
import cliConfig from "../src/config.ts";

await runCli(cliConfig, process.argv.slice(2))
