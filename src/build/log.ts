const C = { dim: "\x1b[2m", reset: "\x1b[0m", cyan: "\x1b[36m", bold: "\x1b[1m", mag: "\x1b[35m" };

export function phase(title: string): void {
  process.stdout.write(`\n${C.bold}${C.cyan}━━ ${title} ━━${C.reset}\n`);
}

export function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

/** Compact one-line trace of a subagent's actions, tagged by task/kind. */
export function sub(tag: string, msg: string): void {
  process.stdout.write(`${C.dim}${C.mag}[${tag}]${C.reset}${C.dim} ${msg}${C.reset}\n`);
}
