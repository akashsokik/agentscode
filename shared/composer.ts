/**
 * What the composer's pickers list: `/` for commands and skills, `@` for project files. The shapes
 * follow MonoCode's skill catalog and file index; the injection is MonoCode's injectSkillPrompt.
 */

/** A command the `/` picker offers. */
export interface ComposerCommand {
  /** What follows the slash: "clear", "review", "vercel:deploy". */
  name: string;
  description: string;
  /** Who defines it: AgentsCode itself, the project, the user, or an installed plugin. */
  scope: 'agentscode' | 'project' | 'user' | 'plugin';
  /** Where it came from: "agentscode", "claude", "codex", "agents", or the plugin's name. */
  source: string;
  argumentHint?: string;
  /** Other names that run it, such as /new for /clear. */
  aliases?: string[];
}

/** Files under an agent's workspace, relative to it, for the `@` picker. */
export interface ProjectFileList {
  files: string[];
  /** The listing stopped at its cap; a search may miss files past it. */
  truncated: boolean;
}

/** Skill names invoked in `text` as `/name`, at the start or after whitespace, in order, once each. */
export function skillNamesInText(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)\/([a-zA-Z0-9][\w.:-]*)(?=\s|$)/g)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * For an engine that does not run skills itself: the prompt with each invoked skill's
 * instructions in front of it. The message as typed stays as it is in the transcript.
 */
export function injectSkillPrompt(text: string, skills: { name: string; body: string }[]): string {
  const blocks = skills.filter(skill => skill.body.trim()).map(skill => `## /${skill.name}\n\n${skill.body.trim()}`);
  if (!blocks.length) return text;
  return ['The user invoked skill(s) with /name. Follow every instruction in each skill body.', '', blocks.join('\n\n'), '', '---', '', text].join('\n');
}
