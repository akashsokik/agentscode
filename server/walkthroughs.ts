import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import type { ImageMediaType, Walkthrough, WalkthroughRoot, WalkthroughStep, WalkthroughSummary } from '../shared/types.ts';
import { sniffImage } from './attachments.ts';
import type { walkthroughInput } from './comms/tools.ts';
import { HttpError } from './errors.ts';
import { gitRun } from './projects.ts';
import { gitDiff } from './workspace.ts';

// Walkthroughs: guided tours of an agent's work, made when the user asks. Each lives in its own
// folder under the agent's home, <home>/walkthroughs/<id>/, as walkthrough.json, a readable
// walkthrough.md and any images, so it survives the code moving on.

export type WalkthroughInput = z.infer<typeof walkthroughInput>;

/** A folder a code or diff step can point into, and how the viewer opens files there. */
export interface StepRoot {
  root: string;
  open: WalkthroughRoot | null;
  projectId: string | null;
}

export interface WalkthroughContext {
  agentId: string;
  agentName: string;
  /** <home>/walkthroughs */
  dir: string;
  /** The agent's working folder; relative paths start here. */
  cwd: string;
  home?: string;
  /** The folder holding a path, or null when the path is outside everything the agent works in. */
  rootOf(target: string): StepRoot | null;
  /** The agent's current place, for the header when no step names one. */
  fallback: { projectId: string | null; root: string | null; branch: string | null };
}

const MAX_CODE_LINES = 200;
const DEFAULT_CODE_LINES = 40;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_CHARS = 200_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const EXT: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const ID = /^[0-9]{8}-[0-9a-f]{8}$/;
const IMAGE_FILE = /^[0-9]{2}\.(png|jpg|gif|webp)$/;

function resolve(ctx: WalkthroughContext, raw: string): string {
  const expanded = ctx.home && (raw === '~' || raw.startsWith('~/')) ? path.join(ctx.home, raw.slice(1)) : raw;
  const full = path.resolve(ctx.cwd, expanded);
  try { return fs.realpathSync(full); } catch { return full; }
}

function placed(ctx: WalkthroughContext, raw: string | undefined, kind: string): { full: string; rel: string; at: StepRoot } {
  if (!raw) throw new Error(`a ${kind} step needs a path.`);
  const full = resolve(ctx, raw);
  const at = ctx.rootOf(full);
  if (!at) throw new Error(`${raw} is outside your projects and workspace.`);
  return { full, rel: path.relative(at.root, full) || path.basename(full), at };
}

function codeStep(ctx: WalkthroughContext, step: WalkthroughInput['steps'][number]): { step: WalkthroughStep; at: StepRoot } {
  const { full, rel, at } = placed(ctx, step.path, 'code');
  let stat: fs.Stats;
  try { stat = fs.statSync(full); } catch { throw new Error(`${step.path} does not exist.`); }
  if (!stat.isFile()) throw new Error(`${step.path} is not a file.`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${step.path} is too large to quote; use a diff or a note.`);
  const text = fs.readFileSync(full, 'utf8');
  if (text.includes('\0')) throw new Error(`${step.path} is a binary file.`);
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const start = step.start_line ?? 1;
  if (start > lines.length) throw new Error(`${step.path} has ${lines.length} lines, so it has no line ${start}.`);
  let end = Math.min(step.end_line ?? start + DEFAULT_CODE_LINES - 1, lines.length);
  if (end < start) throw new Error(`end_line ${end} comes before start_line ${start}.`);
  end = Math.min(end, start + MAX_CODE_LINES - 1);
  return {
    step: { kind: 'code', title: step.title, body: step.body, path: rel, root: at.open, startLine: start, endLine: end, excerpt: lines.slice(start - 1, end).join('\n') },
    at,
  };
}

async function diffStep(ctx: WalkthroughContext, step: WalkthroughInput['steps'][number]): Promise<{ step: WalkthroughStep; at: StepRoot }> {
  const { rel, at } = placed(ctx, step.path, 'diff');
  let diff: string;
  try {
    diff = (await gitDiff(at.root, rel)).diff;
  } catch (error) {
    throw new Error(`could not diff ${step.path}: ${(error as Error).message}`);
  }
  if (!diff.trim()) throw new Error(`${step.path} has no uncommitted changes; use a code step to show it.`);
  const excerpt = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... (diff cut short)` : diff;
  return { step: { kind: 'diff', title: step.title, body: step.body, path: rel, root: at.open, excerpt }, at };
}

function imageStep(ctx: WalkthroughContext, step: WalkthroughInput['steps'][number], folder: string, index: number): WalkthroughStep {
  if (!step.path) throw new Error('an image step needs the path of an image file.');
  const full = resolve(ctx, step.path);
  let stat: fs.Stats;
  try { stat = fs.statSync(full); } catch { throw new Error(`${step.path} does not exist.`); }
  if (!stat.isFile()) throw new Error(`${step.path} is not a file.`);
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`${step.path} is over 8 MB.`);
  const bytes = fs.readFileSync(full);
  const mediaType = sniffImage(bytes);
  if (!mediaType) throw new Error(`${step.path} is not a png, jpeg, gif or webp image.`);
  const file = `${String(index + 1).padStart(2, '0')}.${EXT[mediaType]}`;
  fs.mkdirSync(path.join(folder, 'images'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'images', file), bytes);
  return { kind: 'image', title: step.title, body: step.body, image: { file, mediaType } };
}

function newId(now: number): string {
  const d = new Date(now);
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${day}-${randomBytes(4).toString('hex')}`;
}

async function headOf(root: string): Promise<{ branch: string | null; commit: string | null }> {
  const [branch, commit] = await Promise.all([
    gitRun(root, ['branch', '--show-current'], 5_000),
    gitRun(root, ['rev-parse', '--short', 'HEAD'], 5_000),
  ]);
  return {
    branch: branch.ok && branch.stdout.trim() ? branch.stdout.trim() : null,
    commit: commit.ok && commit.stdout.trim() ? commit.stdout.trim() : null,
  };
}

/** Check every step, capture code, diffs and images, and write the walkthrough. All or nothing. */
export async function createWalkthrough(ctx: WalkthroughContext, input: WalkthroughInput, now = Date.now()): Promise<Walkthrough> {
  const id = newId(now);
  const folder = path.join(ctx.dir, id);
  fs.mkdirSync(folder, { recursive: true });
  try {
    const steps: WalkthroughStep[] = [];
    const errors: string[] = [];
    let first: StepRoot | null = null;
    for (const [index, step] of input.steps.entries()) {
      try {
        if (step.kind === 'note') {
          if (!step.body) throw new Error('a note step needs a body.');
          steps.push({ kind: 'note', title: step.title, body: step.body });
        } else if (step.kind === 'command') {
          if (!step.command) throw new Error('a command step needs the command that ran.');
          steps.push({ kind: 'command', title: step.title, body: step.body, command: step.command, output: step.output ?? '' });
        } else if (step.kind === 'diagram') {
          if (!step.source) throw new Error('a diagram step needs Mermaid source.');
          steps.push({ kind: 'diagram', title: step.title, body: step.body, source: step.source.replace(/^```(?:mermaid)?\s*\n?|\n?```\s*$/g, '') });
        } else if (step.kind === 'image') {
          steps.push(imageStep(ctx, step, folder, index));
        } else {
          const made = step.kind === 'code' ? codeStep(ctx, step) : await diffStep(ctx, step);
          first ??= made.at;
          steps.push(made.step);
        }
      } catch (error) {
        errors.push(`Step ${index + 1} (${step.kind}, "${step.title}"): ${(error as Error).message}`);
      }
    }
    if (errors.length) throw new HttpError(400, `Walkthrough not saved. Fix these and call create_walkthrough again:\n${errors.join('\n')}`);
    const root = first?.root ?? ctx.fallback.root;
    const head = root ? await headOf(root) : { branch: null, commit: null };
    const walkthrough: Walkthrough = {
      id,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      title: input.title,
      summary: input.summary,
      stepCount: steps.length,
      createdAt: now,
      projectId: first ? first.projectId : ctx.fallback.projectId,
      branch: head.branch ?? ctx.fallback.branch,
      commit: head.commit,
      steps,
    };
    fs.writeFileSync(path.join(folder, 'walkthrough.json'), `${JSON.stringify(walkthrough, null, 2)}\n`);
    fs.writeFileSync(path.join(folder, 'walkthrough.md'), walkthroughMarkdown(walkthrough));
    return walkthrough;
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

export function summaryOf(walkthrough: Walkthrough): WalkthroughSummary {
  const { steps: _steps, ...summary } = walkthrough;
  return summary;
}

/** The agent's walkthroughs, newest first. */
export function listWalkthroughs(dir: string): WalkthroughSummary[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const list: WalkthroughSummary[] = [];
  for (const name of names) {
    if (!ID.test(name)) continue;
    try { list.push(summaryOf(readWalkthrough(dir, name))); } catch { /* skip a damaged one */ }
  }
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export function readWalkthrough(dir: string, id: string): Walkthrough {
  if (!ID.test(id)) throw new HttpError(404, 'No such walkthrough.');
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, id, 'walkthrough.json'), 'utf8')) as Walkthrough;
  } catch {
    throw new HttpError(404, 'No such walkthrough.');
  }
}

export function walkthroughImage(dir: string, id: string, file: string): string {
  if (!ID.test(id) || !IMAGE_FILE.test(file)) throw new HttpError(404, 'No such image.');
  const full = path.join(dir, id, 'images', file);
  if (!fs.existsSync(full)) throw new HttpError(404, 'No such image.');
  return full;
}

export function deleteWalkthrough(dir: string, id: string): void {
  if (!ID.test(id) || !fs.existsSync(path.join(dir, id, 'walkthrough.json'))) throw new HttpError(404, 'No such walkthrough.');
  fs.rmSync(path.join(dir, id), { recursive: true, force: true });
}

function fence(text: string, lang = ''): string {
  const ticks = text.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

/** The walkthrough as markdown: what walkthrough.md holds, and what Copy as markdown gives. */
export function walkthroughMarkdown(w: Walkthrough): string {
  const where = [w.branch && `branch \`${w.branch}\``, w.commit && `commit \`${w.commit}\``].filter(Boolean).join(', ');
  const out = [`# ${w.title}`, '', `By ${w.agentName}, ${new Date(w.createdAt).toISOString().slice(0, 16).replace('T', ' ')}${where ? `, ${where}` : ''}.`, '', w.summary];
  w.steps.forEach((step, i) => {
    out.push('', `## ${i + 1}. ${step.title}`);
    if (step.body) out.push('', step.body);
    if (step.kind === 'code') out.push('', `\`${step.path}\` lines ${step.startLine}-${step.endLine}`, '', fence(step.excerpt ?? '', path.extname(step.path ?? '').slice(1)));
    if (step.kind === 'diff') out.push('', `\`${step.path}\``, '', fence(step.excerpt ?? '', 'diff'));
    if (step.kind === 'command') out.push('', fence(`$ ${step.command}${step.output ? `\n${step.output}` : ''}`, 'console'));
    if (step.kind === 'diagram') out.push('', fence(step.source ?? '', 'mermaid'));
    if (step.kind === 'image' && step.image) out.push('', `![${step.title}](images/${step.image.file})`);
  });
  return `${out.join('\n')}\n`;
}
