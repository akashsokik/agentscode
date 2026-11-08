import path from 'node:path';
import { COMMS_SERVER } from '../config.ts';

// Turn raw tool calls into short human text for speech bubbles, chat rows and approval cards.

type Input = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

/** Show paths inside the project relative to it, so bubbles and rows stay short. */
export function relativize(text: string, cwd?: string): string {
  if (!cwd || cwd === '/') return text;
  return text.split(`${cwd}/`).join('').split(cwd).join('.');
}

function base(p: unknown): string {
  return path.basename(str(p)) || str(p);
}

function filePathOf(input: Input): string {
  return str(input.file_path) || str(input.path) || str(input.notebook_path);
}

/** A few words for the speech bubble over the desk. */
export function toolActivity(name: string, input: Input): string {
  switch (name) {
    case 'Read':
      return `Reading ${base(filePathOf(input))}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${base(filePathOf(input))}`;
    case 'Write':
      return `Writing ${base(filePathOf(input))}`;
    case 'Bash':
      return str(input.description) ? clip(str(input.description), 40) : `Running ${clip(str(input.command), 32)}`;
    case 'Grep':
      return `Searching "${clip(str(input.pattern), 24)}"`;
    case 'Glob':
      return `Looking for ${clip(str(input.pattern), 28)}`;
    case 'WebFetch':
      return 'Reading the web';
    case 'WebSearch':
      return `Searching the web`;
    case 'Task':
    case 'Agent':
      return `Delegating: ${clip(str(input.description), 30)}`;
    case 'TodoWrite':
      return 'Updating the plan';
    case 'AskUserQuestion':
      return 'Has a question';
    case 'ExitPlanMode':
      return 'Plan ready';
    default:
      return `Using ${name.replace(/^mcp__/, '').replace(/__/g, ' ')}`;
  }
}

const BROWSER_TOOL = /(?:^mcp__agentscode__|^agentscode\.)browser_(\w+)$/;

/** A browser tool call in a few words: the page it opened, the ref it clicked, the key it pressed. */
export function browserSummary(op: string, input: Input): string {
  switch (op) {
    case 'open': return clip(str(input.url).replace(/^https?:\/\//, ''), 120);
    case 'click': return str(input.ref);
    case 'type': return clip(`${str(input.ref)} "${str(input.text)}"${input.submit ? ' and Enter' : ''}`, 120);
    case 'press': return str(input.key);
    case 'eval': return clip(str(input.expression), 120);
    default: return str(input.tab_id);
  }
}

/** One line for the chat transcript. */
export function toolSummary(name: string, input: Input, cwd?: string): string {
  const browser = BROWSER_TOOL.exec(name)?.[1];
  if (browser) return browserSummary(browser, input);
  switch (name) {
    case 'Bash':
      return clip(relativize(str(input.command), cwd), 160);
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return relativize(filePathOf(input), cwd);
    case 'Grep':
      return `${str(input.pattern)}${input.path ? `  in ${relativize(str(input.path), cwd)}` : ''}`;
    case 'Glob':
      return str(input.pattern);
    case 'WebFetch':
      return str(input.url);
    case 'WebSearch':
      return str(input.query);
    case 'Task':
    case 'Agent':
      return str(input.description);
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? (input.todos as Input[]) : [];
      const done = todos.filter((t) => t.status === 'completed').length;
      return `${done}/${todos.length} steps done`;
    }
    case `mcp__${COMMS_SERVER}__post_to_channel`:
      return clip(`${str(input.channel)}: ${str(input.text).replace(/\s+/g, ' ')}`, 160);
    case `mcp__${COMMS_SERVER}__read_channel`:
      return str(input.channel);
    case `mcp__${COMMS_SERVER}__remember`:
      return clip(`Remembered: ${str(input.text)}`, 160);
    case `mcp__${COMMS_SERVER}__forget`:
      return clip(`Forgot: ${str(input.text) || str(input.id)}`, 160);
    default:
      return clip(JSON.stringify(input), 160);
  }
}

function diffLines(oldText: string, newText: string): string {
  const minus = oldText.split('\n').map((l) => `- ${l}`);
  const plus = newText.split('\n').map((l) => `+ ${l}`);
  return [...minus, ...plus].join('\n');
}

/** Longer body shown when a tool row or approval card is expanded. */
export function toolDetail(name: string, input: Input, cwd?: string): string {
  switch (name) {
    case 'Bash':
      return [relativize(str(input.command), cwd), str(input.description) && `# ${str(input.description)}`]
        .filter(Boolean)
        .join('\n');
    case 'Edit':
      return diffLines(str(input.old_string), str(input.new_string));
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : [];
      return edits.map((e) => diffLines(str(e.old_string), str(e.new_string))).join('\n...\n');
    }
    case 'Write': {
      const lines = str(input.content).split('\n');
      const head = lines.slice(0, 40).join('\n');
      return lines.length > 40 ? `${head}\n... (${lines.length - 40} more lines)` : head;
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? (input.todos as Input[]) : [];
      const mark = (s: unknown) => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[>]' : '[ ]');
      return todos.map((t) => `${mark(t.status)} ${str(t.content)}`).join('\n');
    }
    case 'Task':
    case 'Agent':
      return str(input.prompt);
    default:
      return JSON.stringify(input, null, 2);
  }
}

/** The question in the raised-hand bubble, e.g. "Run npm test?". */
export function approvalTitle(name: string, input: Input, cwd?: string): string {
  switch (name) {
    case 'Bash': {
      const command = relativize(str(input.command), cwd).trim();
      if (command.length <= 40 || !str(input.description)) return `Run ${clip(command, 40)}?`;
      return `${clip(str(input.description), 44)}?`;
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Edit ${base(filePathOf(input))}?`;
    case 'Write':
      return `Write ${base(filePathOf(input))}?`;
    case 'WebFetch': {
      try {
        return `Fetch ${new URL(str(input.url)).host}?`;
      } catch {
        return 'Fetch a web page?';
      }
    }
    case 'WebSearch':
      return `Search the web for "${clip(str(input.query), 32)}"?`;
    default:
      return `Use ${name.replace(/^mcp__/, '').replace(/__/g, ' ')}?`;
  }
}

/**
 * A better summary once a tool's result is in. forget is called with an id, so its row only names
 * what was forgotten when the result says.
 */
export function resultSummary(name: string, output: string): string | undefined {
  if (name !== `mcp__${COMMS_SERVER}__forget`) return undefined;
  try {
    const text = (JSON.parse(output) as { forgot?: { text?: unknown } })?.forgot?.text;
    return typeof text === 'string' ? clip(`Forgot: ${text}`, 160) : undefined;
  } catch {
    return undefined;
  }
}

/** The summary for a teammate-comms call made by Codex, whose items carry the server, tool and arguments. */
export function mcpSummary(server: string, tool: string, args: Input, output: string): string {
  const name = `mcp__${server}__${tool}`;
  if (server === COMMS_SERVER && tool.startsWith('browser_')) return browserSummary(tool.slice('browser_'.length), args);
  if (server !== COMMS_SERVER || (tool !== 'remember' && tool !== 'forget')) return `${server}.${tool}`;
  const summary = resultSummary(name, output) ?? toolSummary(name, args);
  // Without the text (an item shaped differently than expected), the tool name says more.
  return /^(Remembered|Forgot):\s*$/.test(summary) ? `${server}.${tool}` : summary;
}

/** Flatten a tool_result content payload to plain text. */
export function toolResultText(content: unknown, max = 4000): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((block: Input) => (block?.type === 'text' ? str(block.text) : block?.type === 'image' ? '[image]' : ''))
      .join('\n');
  }
  return text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more characters)` : text;
}
