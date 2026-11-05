/** "/name args" -> { name, args }. Plain text and paths such as "/Users/me/app" are not commands. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const match = text.trim().match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1], args: (match[2] ?? '').trim() } : null;
}

/** Commands the IDE runs itself because they change state it tracks. */
export const IDE_COMMANDS = ['new', 'clear', 'reset'];

export function isIdeCommand(text: string): boolean {
  const command = parseCommand(text);
  return Boolean(command && IDE_COMMANDS.includes(command.name.toLowerCase()));
}
