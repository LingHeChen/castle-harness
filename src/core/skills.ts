import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Skills: named, reusable instruction bundles the agent can pull in on demand.
 * Each is a markdown file under `.castle/skills/` with simple frontmatter:
 *
 *   ---
 *   name: release-checklist
 *   description: steps to cut a release
 *   ---
 *   <body the agent loads when it needs it>
 *
 * The design is progressive disclosure — a context-economy move: only the skill
 * *names and descriptions* sit in the prompt at all times; the full body is
 * loaded via the `load_skill` tool exactly when the agent decides it's relevant.
 * That keeps the always-on context small while making capability discoverable.
 */

export type Skill = { name: string; description: string; file: string };

const SKILLS_DIR = ".castle/skills";

export async function listSkills(cwd: string): Promise<Skill[]> {
  const dir = join(cwd, SKILLS_DIR);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const f of files) {
    const path = join(dir, f);
    const meta = parseFrontmatter(await Bun.file(path).text());
    skills.push({
      name: meta.name ?? f.replace(/\.md$/, ""),
      description: meta.description ?? "",
      file: path,
    });
  }
  return skills;
}

export async function loadSkill(cwd: string, name: string): Promise<string | null> {
  const skill = (await listSkills(cwd)).find((s) => s.name === name);
  if (!skill) return null;
  return stripFrontmatter(await Bun.file(skill.file).text()).trim();
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "");
}
