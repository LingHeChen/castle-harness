/** Cap tool output so a single noisy command can't blow up the context window. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return text.slice(0, max) + `\n... [truncated ${dropped} chars]`;
}
