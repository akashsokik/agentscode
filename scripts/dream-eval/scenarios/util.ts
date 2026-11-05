import type { Score, SessionView } from '../scenario.ts';

export const SOURCE = /\.(c|m)?(j|t)sx?$/;

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function pass(detail: string): Score {
  return { pass: true, detail };
}

export function fail(detail: string): Score {
  return { pass: false, detail };
}

/** Nothing to judge (say, no indented lines to check); left out of the rates. */
export function inconclusive(detail: string): Score {
  return { pass: null, detail };
}

/** Source files session 2 created. */
export function addedSources(view: SessionView): string[] {
  return view.added.filter(file => SOURCE.test(file));
}

export function clip(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Short for a report line. */
export function list(items: string[], max = 4): string {
  if (!items.length) return 'none';
  const shown = items.slice(0, max).map(item => clip(item, 80));
  return items.length > max ? `${shown.join('; ')}; +${items.length - max} more` : shown.join('; ');
}

/**
 * The simple commands in what the agent ran, in order: each command split into lines and on ; && || |,
 * so "cat > f <<EOF ... EOF; node --test" yields "node --test" on its own. Quoting is ignored, which is
 * fine for telling which programs were invoked.
 */
export function invocations(commands: string[]): string[] {
  return commands.flatMap(command => command.split(/\n|;|&&|\|\||\|/)).map(part => part.trim()).filter(Boolean);
}

/** An invocation without leading VAR=value assignments and `env`. */
export function program(invocation: string): string {
  return invocation.replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '');
}

/** The first invocation whose program part matches, for a report line. */
export function firstInvocation(commands: string[], pattern: RegExp): string | null {
  return invocations(commands).find(inv => pattern.test(program(inv))) ?? null;
}
