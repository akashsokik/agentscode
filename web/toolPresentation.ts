import type { ToolCall } from '../shared/types.ts';

/**
 * How a tool call reads in the work trail, after MonoCode's tool presentation: a shell command
 * that only reads a file reads as Read, a search as Search with its patterns as pills, and a
 * chained command (`git status && rg --files && cat a.ts`) as a row of step chips. Pure, so it is
 * tested directly.
 */

export type StepAction = 'Run' | 'Read' | 'Find' | 'List';

export interface CommandStep {
  /** The operator joining this step to the one before; none for the first. */
  op?: '&&' | '||' | ';';
  command: string;
  action: StepAction;
  target: string;
  /** The file a Read or List step names, to open it. */
  path?: string;
}

export interface StepChip {
  action: StepAction;
  label: string;
  path?: string;
}

export interface ToolShown {
  /** The verb the row leads with; a plain command has none ("Run" is not shown). */
  action: string;
  target: string;
  /** A file the call read or changed, to open (as a diff for a change). */
  file?: { path: string; diff: boolean; folder?: boolean };
  /** Search patterns, shown as pills. */
  patterns?: string[];
  /** A chained command's steps, deduplicated and without shell plumbing. */
  chips?: StepChip[];
  /** What a chained command is for, when the agent said (Claude's Bash description). */
  description?: string;
}

/** How each browser tool call leads its row. */
const BROWSER_ACTIONS: Record<string, string> = {
  open: 'Opened', list: 'Listed tabs', close: 'Closed tab', snapshot: 'Read page', screenshot: 'Screenshot',
  console: 'Console', click: 'Clicked', type: 'Typed', press: 'Pressed', eval: 'Ran script',
};

/** How a click, type or press reached the page, from its result: "trusted", "synthetic", or null when unknown. */
export function browserInput(tool: ToolCall): 'trusted' | 'synthetic' | null {
  if (tool.status !== 'ok' || !tool.output) return null;
  const match = /"input"\s*:\s*"(trusted|synthetic)"/.exec(tool.output);
  return match ? (match[1] as 'trusted' | 'synthetic') : null;
}

/** The file a successful browser_screenshot saved, from its result; null otherwise. */
export function browserScreenshot(tool: ToolCall): string | null {
  if (!/(?:^mcp__agentscode__|^agentscode\.)browser_screenshot$/.test(tool.name) || tool.status !== 'ok' || !tool.output) return null;
  const start = tool.output.indexOf('{');
  try {
    const shot = JSON.parse(tool.output.slice(start)) as { path?: unknown };
    const file = typeof shot.path === 'string' ? shot.path.split(/[\\/]/).pop() ?? '' : '';
    return /^[\w-]+\.png$/.test(file) ? file : null;
  } catch {
    return null;
  }
}

/** Splits a shell word list the way POSIX shells do; undefined when a quote or escape is left open. */
export function shellWords(text: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let at = 0; at < text.length; at++) {
    const ch = text[at];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (ch === '\\') {
      if (at + 1 >= text.length) return undefined;
      const next = text[++at];
      if (quote === '"' && !'\\"$`\n'.includes(next)) word += ch;
      if (next !== '\n') word += next;
      inWord = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) return undefined;
  if (inWord) words.push(word);
  return words;
}

function lastSegment(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

interface Intent {
  action: Exclude<StepAction, 'Run'>;
  target: string;
}

const VALUE_FLAGS: Record<string, string[]> = {
  head: ['-n', '-c', '--lines', '--bytes'],
  tail: ['-n', '-c', '--lines', '--bytes'],
  bat: ['--style', '--theme', '--language', '-l'],
  batcat: ['--style', '--theme', '--language', '-l'],
};
const SEARCH_FLAGS = ['-g', '--glob', '-t', '--type', '-A', '-B', '-C', '-m', '--max-count', '--context'];
for (const bin of ['rg', 'grep', 'ag', 'ack', 'egrep', 'fgrep']) VALUE_FLAGS[bin] = SEARCH_FLAGS;

/**
 * What a command does, when that is plainly a read, a search or a listing. Deliberately
 * conservative: substitution, redirects and anything opaque stay a command, and a command that
 * happens to mention `cat` never becomes a Read.
 */
export function shellIntent(command: string): Intent | undefined {
  if (command.length > 2000) return undefined;
  const stages: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let at = 0; at < command.length; at++) {
    const ch = command[at];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (ch === "'" || ch === '"') {
      if (quote === ch) quote = null;
      else if (!quote) quote = ch;
      continue;
    }
    if (ch === '`' || (ch === '$' && quote !== "'")) return undefined;
    if (quote) continue;
    if ('<>()'.includes(ch)) return undefined;
    if (';|&\n'.includes(ch)) {
      const stage = command.slice(start, at).trim();
      if (stage) stages.push(stage);
      start = at + 1;
    }
  }
  if (quote) return undefined;
  const tail = command.slice(start).trim();
  if (tail) stages.push(tail);

  let last: Intent | undefined;
  for (const stage of stages) {
    const args = shellWords(stage);
    if (!args?.length) return undefined;
    const bin = lastSegment(args[0]);
    const valueFlags = VALUE_FLAGS[bin] ?? [];
    const positional: string[] = [];
    let skip = false;
    let literal = false;
    for (const arg of args.slice(1)) {
      if (skip) { skip = false; continue; }
      if (arg === '--') { literal = true; continue; }
      if (!literal && valueFlags.includes(arg)) { skip = true; continue; }
      if (literal || !arg.startsWith('-')) positional.push(arg);
    }
    switch (bin) {
      case 'cd': case 'pwd': case 'echo': case 'printf': case 'true': case 'wc':
        break;
      case 'cat': case 'bat': case 'batcat': case 'nl': case 'less': case 'more': case 'tac': case 'head': case 'tail':
        // Several files need their real command, not a caption naming one of them.
        if (positional.length !== 1) return undefined;
        last = { action: 'Read', target: positional[0] };
        break;
      case 'sed': {
        // Only a print-address script is known to be a read; never sed -i.
        if (args.some(a => a.startsWith('-i') || a.startsWith('--in-place')) || positional.length !== 2) return undefined;
        if (!/^[\d,$]+p$/.test(positional[0])) return undefined;
        last = { action: 'Read', target: positional[1] };
        break;
      }
      case 'rg':
      case 'grep': case 'egrep': case 'fgrep': case 'ag': case 'ack': {
        if (bin === 'rg' && args.includes('--files')) { last = { action: 'Find', target: 'files' }; break; }
        // Pattern files and replacement or preprocessor modes are not simple searches.
        if (args.some(a => ['-f', '--file', '--pre', '--replace', '-r'].includes(a))) return undefined;
        const flagged = args.findIndex(a => a === '-e' || a === '--regexp');
        const query = flagged >= 0 ? args[flagged + 1] : positional[0];
        if (query === undefined) return undefined;
        last = { action: 'Find', target: query };
        break;
      }
      case 'ls': case 'tree':
        if (positional.length !== 1) return undefined;
        last = { action: 'List', target: positional[0] };
        break;
      default:
        return undefined;
    }
  }
  return last;
}

/**
 * The top-level `&&`, `||`, `;` and newline steps of a chained command. Pipelines stay one step;
 * anything opaque (substitution, subshells, heredocs) and a single command have no steps.
 */
export function commandSteps(command: string): CommandStep[] {
  if (command.length > 4000 || command.includes('<<')) return [];
  const parts: Array<[CommandStep['op'], string]> = [];
  let op: CommandStep['op'];
  let start = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let at = 0; at < command.length; at++) {
    const ch = command[at];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (ch === "'" || ch === '"') {
      if (quote === ch) quote = null;
      else if (!quote) quote = ch;
      continue;
    }
    if (ch === '`' || (ch === '$' && quote !== "'")) return [];
    if (quote) continue;
    if ('(){}'.includes(ch)) return [];
    const next = command[at + 1];
    const sep: [NonNullable<CommandStep['op']>, number] | undefined =
      ch === '&' && next === '&' ? ['&&', 2]
      : ch === '|' && next === '|' ? ['||', 2]
      : ch === ';' || ch === '\n' ? [';', 1]
      : undefined;
    if (!sep) continue;
    const part = command.slice(start, at).trim();
    if (part) {
      parts.push([op, part]);
      op = sep[0];
    }
    at += sep[1] - 1;
    start = at + 1;
  }
  if (quote) return [];
  const rest = command.slice(start).trim();
  if (rest) parts.push([op, rest]);
  if (parts.length < 2) return [];
  return parts.map(([joined, part], index) => {
    const intent = shellIntent(part);
    return {
      ...(index > 0 ? { op: joined ?? ';' } : {}),
      command: part,
      action: intent?.action ?? 'Run',
      target: intent?.target ?? part,
      ...(intent && intent.action !== 'Find' ? { path: intent.target } : {}),
    };
  });
}

/** `git status --short` reads as `git status`; flags and paths are detail. */
export function commandLabel(command: string): string {
  const [first = '', sub] = command.trim().split(/\s+/);
  const program = lastSegment(first) || first;
  if (sub && !sub.startsWith('-') && !/[/.='"]/.test(sub) && sub.length <= 16) return `${program} ${sub}`;
  return program;
}

const NOISE = new Set(['cd', 'pwd', 'echo', 'printf', 'true', 'false', 'sleep', 'clear']);

/** Shell plumbing that says nothing about what a chained command was for. */
function isNoise(step: CommandStep): boolean {
  return step.action === 'Run' && NOISE.has(step.command.trim().split(/\s+/)[0]);
}

/** One chip per distinct thing a chain did, in order: a file it read, a search, a program it ran. */
export function stepChips(steps: CommandStep[]): StepChip[] {
  const seen = new Set<string>();
  const chips: StepChip[] = [];
  for (const step of steps) {
    if (isNoise(step)) continue;
    const label = step.action === 'Read' || step.action === 'List' ? lastSegment(step.target) || step.target
      : step.action === 'Find' ? step.target
      : commandLabel(step.command);
    const key = `${step.action}\u0000${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chips.push({ action: step.action, label, ...(step.path ? { path: step.path } : {}) });
  }
  return chips;
}

/** A search's simple regex alternatives as separate pills; a literal or complex query stays whole. */
export function searchPatterns(query: string, command?: string): string[] {
  if (/[\\[\]()]/.test(query)) return [query];
  if (command) {
    const args = shellWords(command);
    if (!args) return [query];
    const bin = lastSegment(args[0] ?? '');
    const short = (flag: string) => args.some(a => a.startsWith('-') && !a.startsWith('--') && a.includes(flag));
    const extended = ['rg', 'ag', 'ack', 'egrep'].includes(bin) || (bin === 'grep' && (args.includes('--extended-regexp') || short('E')));
    const plain = args.includes('--fixed-strings') || args.includes('--basic-regexp') || short('F') || short('G');
    if (!extended || plain) return [query];
  }
  const patterns = query.split('|');
  return patterns.some(p => !p) ? [query] : patterns;
}

/**
 * The command a shell call ran, and the description Claude gave it. Claude's Bash detail is the
 * command with `# description` as its last line; its summary is the command clipped to one line,
 * so the detail is what keeps newlines and the full text a chain is split on.
 */
export function shellCommand(tool: ToolCall): { command: string; description?: string } {
  const detail = tool.detail?.trim();
  if (!detail) return { command: tool.summary };
  if (tool.name !== 'Bash') return { command: detail };
  const lines = detail.split('\n');
  const last = lines.at(-1) ?? '';
  const flat = detail.replace(/\s+/g, ' ').trim();
  // A command that itself ends in a comment flattens to exactly its summary.
  if (lines.length > 1 && last.startsWith('# ') && flat !== tool.summary) {
    return { command: lines.slice(0, -1).join('\n').trim(), description: last.slice(2).trim() || undefined };
  }
  return { command: detail };
}

function presentShell(tool: ToolCall): ToolShown {
  const { command, description } = shellCommand(tool);
  const intent = shellIntent(command);
  if (intent?.action === 'Read') return { action: 'Read', target: intent.target, file: { path: intent.target, diff: false } };
  if (intent?.action === 'List') return { action: 'List', target: intent.target, file: { path: intent.target, diff: false, folder: true } };
  if (intent?.action === 'Find') return { action: 'Search', target: intent.target, patterns: searchPatterns(intent.target, command) };
  const chips = stepChips(commandSteps(command));
  const firstLine = command.split('\n').find(line => line.trim())?.trim() ?? tool.summary;
  return chips.length ? { action: 'Run', target: firstLine, chips, ...(description ? { description } : {}) } : { action: 'Run', target: firstLine };
}

/** The action and target a tool call's row shows. */
export function presentTool(tool: ToolCall): ToolShown {
  const target = tool.summary;
  const single = Boolean(target) && !target.includes(', ');
  switch (tool.name) {
    case 'Read':
      return { action: 'Read', target, ...(single ? { file: { path: target, diff: false } } : {}) };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { action: 'Edit', target, ...(single ? { file: { path: target, diff: true } } : {}) };
    case 'Write':
      return { action: 'Write', target, ...(single ? { file: { path: target, diff: true } } : {}) };
    case 'Bash':
    case 'Shell':
      return presentShell(tool);
    case 'Grep': {
      // The summary is "pattern  in path"; the path is detail.
      const pattern = target.replace(/ {2}in .*$/, '');
      return { action: 'Search', target: pattern, patterns: searchPatterns(pattern) };
    }
    case 'Glob':
      return { action: 'Search', target, patterns: target ? [target] : [] };
    case 'WebFetch': return { action: 'Fetch', target };
    case 'WebSearch': return { action: 'Search the web', target };
    case 'Task':
    case 'Agent': return { action: 'Agent', target };
    case 'TodoWrite':
    case 'Plan': return { action: 'Plan', target };
    default: {
      const name = tool.name;
      const browserOp = name.match(/(?:^mcp__agentscode__|^agentscode\.)browser_(\w+)$/)?.[1];
      if (browserOp) {
        const shown = /^(mcp__|agentscode\.)/.test(target) ? '' : target;
        // Input the browser had to replay as DOM events is not what a user could do; say so on the row.
        const synthetic = ['click', 'type', 'press'].includes(browserOp) && browserInput(tool) === 'synthetic';
        return { action: BROWSER_ACTIONS[browserOp] ?? 'Browser', target: synthetic ? `${shown} (synthetic input)`.trim() : shown };
      }
      const channelTool = name.match(/(?:^mcp__agentscode__|^agentscode\.)(post_to_channel|read_channel|list_channels)$/)?.[1];
      if (channelTool) {
        const action = channelTool === 'post_to_channel' ? 'Posted' : channelTool === 'read_channel' ? 'Read channel' : 'Listed channels';
        return { action, target: target === name || target.startsWith('{') ? '' : target };
      }
      const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/) ?? name.match(/^([^.]+)\.(.+)$/);
      if (mcp) return { action: mcp[1] === 'agentscode' ? 'Comms' : mcp[1], target: mcp[2].replace(/_/g, ' ') };
      return { action: name, target: target === name ? '' : target };
    }
  }
}
