import hljs from 'highlight.js/lib/common';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Walkthrough, WalkthroughStep } from '../../shared/types.ts';
import { api, walkthroughImageUrl, walkthroughMarkdownUrl, type Root } from '../api.ts';
import { openToSide } from '../layout.ts';
import { AlertCircle, ArrowUp, ChevronLeft, ChevronRight, Code, Copy, File, FileDiff, GitBranch, ImagePlus, Route, StickyNote, Terminal, Workflow, type IconComponent } from '../mono/icons.tsx';
import { toast, useApp } from '../store.ts';
import { cx, Empty, HeaderButton, Loading } from '../ui/common.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { MermaidDiagram } from '../ui/MermaidDiagram.tsx';
import { codeChanged, stepQuestion } from '../walkthrough.ts';
import { languageOf, parseDiff, useLoad } from './FilePane.tsx';
import { PaneFrame, type PaneChrome } from './PaneFrame.tsx';

const KIND_ICON: Record<WalkthroughStep['kind'], IconComponent> = { note: StickyNote, code: Code, diff: FileDiff, command: Terminal, image: ImagePlus, diagram: Workflow };

/**
 * A walkthrough an agent made: its steps on the left, the current one on the right, with the code,
 * diff, command or screenshot it points at. Arrow keys (or J and K) move between steps.
 */
export function WalkthroughPane({ agentId, id, chrome }: { agentId: string; id: string; chrome: PaneChrome }) {
  const { data, error } = useLoad<Walkthrough>(() => api.walkthrough(agentId, id), [agentId, id]);
  const [index, setIndex] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const count = data?.steps.length ?? 0;
  const go = (next: number) => setIndex(Math.max(0, Math.min(count - 1, next)));
  useEffect(() => { body.current?.scrollTo({ top: 0 }); }, [index]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); go(index + 1); }
    if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); go(index - 1); }
  };

  const copyMarkdown = async () => {
    try {
      const response = await fetch(walkthroughMarkdownUrl(agentId, id));
      if (!response.ok) throw new Error('Could not load the walkthrough.');
      await navigator.clipboard.writeText(await response.text());
      toast('Copied the walkthrough as markdown.', 'info');
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <PaneFrame
      chrome={chrome}
      title={<span className="flex min-w-0 items-center gap-2"><Route className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} /><span className="truncate text-content">{data?.title ?? 'Walkthrough'}</span></span>}
      actions={data ? <HeaderButton icon={Copy} label="Copy as markdown" onClick={() => void copyMarkdown()} /> : undefined}
    >
      {error ? <Empty icon={AlertCircle} title="Could not open the walkthrough">{error}</Empty>
        : !data ? <Loading className="grid flex-1 place-items-center" />
        : (
          <div tabIndex={0} onKeyDown={onKeyDown} className="@container flex min-h-0 flex-1 outline-none">
            <StepList walkthrough={data} index={index} onPick={setIndex} />
            <div className="flex min-w-0 flex-1 flex-col">
              <div ref={body} className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-[880px] px-6 py-6 font-sans">
                  {index === 0 ? <Cover walkthrough={data} /> : null}
                  <StepView key={index} walkthrough={data} agentId={agentId} index={index} step={data.steps[index]} />
                </div>
              </div>
              <Footer index={index} count={count} onGo={go} />
            </div>
          </div>
        )}
    </PaneFrame>
  );
}

function Cover({ walkthrough: w }: { walkthrough: Walkthrough }) {
  const projects = useApp(s => s.snapshot?.projects);
  const project = projects?.find(p => p.id === w.projectId)?.name;
  return (
    <header className="mb-8 border-b border-stroke pb-6">
      <h1 className="text-[20px] font-semibold tracking-tight text-content">{w.title}</h1>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-content/45">
        <span>By {w.agentName}, {new Date(w.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
        {project ? <span>{project}</span> : null}
        {w.branch ? <span className="flex items-center gap-1"><GitBranch className="size-3" strokeWidth={1.75} /><span className="font-mono text-[11.5px]">{w.branch}</span></span> : null}
        {w.commit ? <span className="font-mono text-[11.5px]">{w.commit}</span> : null}
      </p>
      <Markdown text={w.summary} className="mt-4 text-[13.5px] leading-relaxed text-content/80" />
    </header>
  );
}

function StepList({ walkthrough, index, onPick }: { walkthrough: Walkthrough; index: number; onPick: (i: number) => void }) {
  return (
    <nav aria-label="Steps" className="hidden w-60 shrink-0 overflow-y-auto border-r border-stroke px-2 py-3 font-sans @[720px]:block">
      <p className="px-2 pb-2 text-[11px] font-medium text-content/40">{walkthrough.steps.length} steps</p>
      <ol className="flex flex-col gap-px">
        {walkthrough.steps.map((step, i) => {
          const Icon = KIND_ICON[step.kind];
          return (
            <li key={i}>
              <button
                type="button"
                aria-current={i === index ? 'step' : undefined}
                onClick={() => onPick(i)}
                className={cx('flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors duration-100', i === index ? 'bg-selection text-content' : 'text-content/65 hover:bg-content/5 hover:text-content')}
              >
                <span className="mt-px w-4 shrink-0 text-right text-[11px] tabular-nums text-content/35">{i + 1}</span>
                <Icon className="mt-0.5 size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
                <span className="line-clamp-2 min-w-0 leading-snug">{step.title}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepView({ walkthrough, agentId, index, step }: { walkthrough: Walkthrough; agentId: string; index: number; step: WalkthroughStep }) {
  const Icon = KIND_ICON[step.kind];
  return (
    <article>
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-content/40">
        <Icon className="size-3.5" strokeWidth={1.75} />
        Step {index + 1} of {walkthrough.steps.length}
      </p>
      <h2 className="mt-1 text-[16px] font-semibold text-content">{step.title}</h2>
      {step.body ? <Markdown text={step.body} className="mt-2 text-[13.5px] leading-relaxed text-content/80" /> : null}
      <div className="mt-4">
        {step.kind === 'code' ? <CodeStep step={step} />
          : step.kind === 'diff' ? <DiffStep step={step} />
          : step.kind === 'command' ? <CommandStep step={step} agentName={walkthrough.agentName} />
          : step.kind === 'diagram' && step.source ? <MermaidDiagram source={step.source} className="!my-0" />
          : step.kind === 'image' && step.image ? <img src={walkthroughImageUrl(agentId, walkthrough.id, step.image.file)} alt={step.title} className="max-h-[70vh] max-w-full rounded-lg border border-content/10" />
          : null}
      </div>
      <AskBox walkthrough={walkthrough} agentId={agentId} index={index} step={step} />
    </article>
  );
}

function FileBar({ step, children }: { step: WalkthroughStep; children?: ReactNode }) {
  const root = step.root as Root | null | undefined;
  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-content/10 px-3 py-1.5 text-[12px]">
      <span className="min-w-0 truncate font-mono text-[11.5px] text-content/70">{step.path}{step.kind === 'code' ? `:${step.startLine}-${step.endLine}` : ''}</span>
      {children}
      {root && step.path ? (
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <HeaderButton icon={File} label="Open file" onClick={() => openToSide({ kind: 'file', root, path: step.path! })} />
          <HeaderButton icon={FileDiff} label="Open current diff" onClick={() => openToSide({ kind: 'diff', root, path: step.path! })} />
        </span>
      ) : null}
    </div>
  );
}

function CodeStep({ step }: { step: WalkthroughStep }) {
  const root = step.root as Root | null | undefined;
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (!root || !step.path) return;
    let live = true;
    api.readFile(root, step.path).then(file => { if (live) setChanged(!file.binary && codeChanged(step, file.text)); }, () => { if (live) setChanged(true); });
    return () => { live = false; };
  }, [step, root]);
  const html = useMemo(() => {
    const lang = languageOf(step.path ?? '');
    if (!lang || !step.excerpt) return null;
    try {
      // highlight.js escapes the source and only adds <span class> tags, so its output is safe to inject.
      return hljs.highlight(step.excerpt, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [step]);
  const lines = (step.excerpt ?? '').split('\n').length;
  return (
    <div className="overflow-hidden rounded-lg border border-content/10">
      <FileBar step={step}>
        {changed ? <span className="shrink-0 rounded bg-warning/15 px-1.5 text-[11px] text-warning" title="The file no longer reads like this at these lines">Changed since</span> : null}
      </FileBar>
      <div className="overflow-x-auto">
        <div className="flex min-w-max font-mono text-[var(--code-font-size)] leading-[1.6]">
          <pre aria-hidden className="shrink-0 select-none py-2.5 pl-3 pr-3 text-right text-content/30">
            {Array.from({ length: lines }, (_, i) => (step.startLine ?? 1) + i).join('\n')}
          </pre>
          {html !== null
            ? <pre className="flex-1 py-2.5 pr-6 text-content/90" dangerouslySetInnerHTML={{ __html: html }} />
            : <pre className="flex-1 py-2.5 pr-6 text-content/90">{step.excerpt}</pre>}
        </div>
      </div>
    </div>
  );
}

function DiffStep({ step }: { step: WalkthroughStep }) {
  const lines = useMemo(() => parseDiff(step.excerpt ?? ''), [step]);
  const added = lines.filter(l => l.kind === 'add').length;
  const removed = lines.filter(l => l.kind === 'del').length;
  return (
    <div className="overflow-hidden rounded-lg border border-content/10">
      <FileBar step={step}>
        <span className="shrink-0 font-mono text-[11px] text-diff-add-fg">+{added}</span>
        <span className="shrink-0 font-mono text-[11px] text-diff-del-fg">-{removed}</span>
      </FileBar>
      <div className="max-h-[60vh] overflow-auto py-1">
        <table className="min-w-full border-collapse font-mono text-[var(--code-font-size)] leading-[1.6]">
          <tbody>
            {lines.map((line, i) => line.kind === 'hunk' || line.kind === 'meta' ? (
              <tr key={i}><td colSpan={3} className="bg-content/5 px-3 py-0.5 text-[11px] text-content/45">{line.text}</td></tr>
            ) : (
              <tr key={i} className={cx(line.kind === 'add' && 'bg-diff-add-bg', line.kind === 'del' && 'bg-diff-del-bg')}>
                <td className="w-10 select-none px-2 text-right tabular-nums text-content/30">{line.new ?? line.old ?? ''}</td>
                <td className={cx('w-4 select-none text-center', line.kind === 'add' ? 'text-diff-add-fg' : line.kind === 'del' ? 'text-diff-del-fg' : 'text-content/25')}>
                  {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}
                </td>
                <td className={cx('whitespace-pre pr-6', line.kind === 'add' ? 'text-diff-add-fg' : line.kind === 'del' ? 'text-diff-del-fg' : 'text-content/80')}>{line.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A command and its output as the agent reported them; Podcode does not rerun or check them. */
function CommandStep({ step, agentName }: { step: WalkthroughStep; agentName: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-content/10 bg-content/[0.03]">
      <p className="border-b border-content/10 px-3.5 py-1.5 font-sans text-[11px] text-content/40">Output as reported by {agentName}</p>
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-[var(--code-font-size)] leading-[1.6]">
        <span className="text-content/45">$ </span><span className="text-content">{step.command}</span>
        {step.output ? <span className="text-content/65">{`\n${step.output}`}</span> : null}
      </pre>
    </div>
  );
}

/** A question about this step goes to the agent as a message, with the step named. */
function AskBox({ walkthrough, agentId, index, step }: { walkthrough: Walkthrough; agentId: string; index: number; step: WalkthroughStep }) {
  const agentExists = useApp(s => Boolean(s.snapshot?.agents.some(a => a.id === agentId)));
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  if (!agentExists) return null;
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await api.send(agentId, stepQuestion(walkthrough.title, index, step, text));
      setText('');
      toast(`Asked ${walkthrough.agentName} about step ${index + 1}.`, 'info');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="mt-6 flex items-end gap-2 rounded-lg border border-content/10 px-3 py-2 focus-within:border-content/20">
      <textarea
        value={text}
        rows={1}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
        placeholder={`Ask ${walkthrough.agentName} about this step`}
        aria-label="Ask about this step"
        className="max-h-32 min-h-6 flex-1 resize-none bg-transparent py-0.5 font-sans text-[13px] leading-6 text-content outline-none placeholder:text-content/35 [field-sizing:content]"
      />
      <button
        type="button"
        onClick={() => void send()}
        disabled={!text.trim() || sending}
        aria-label="Send question"
        className="grid size-6 shrink-0 place-items-center rounded-md bg-content text-background-base transition-opacity duration-150 disabled:opacity-25"
      >
        <ArrowUp className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}

function Footer({ index, count, onGo }: { index: number; count: number; onGo: (i: number) => void }) {
  return (
    <div className="shrink-0 border-t border-stroke">
      <div className="h-0.5 bg-content/5"><div className="h-full bg-content/40 transition-[width] duration-200" style={{ width: `${((index + 1) / Math.max(1, count)) * 100}%` }} /></div>
      <div className="flex items-center gap-2 px-4 py-2 font-sans text-[12px]">
        <button type="button" onClick={() => onGo(index - 1)} disabled={index === 0} className="flex h-7 items-center gap-1 rounded-md px-2 text-content/70 transition-colors duration-150 hover:bg-content/5 hover:text-content disabled:opacity-30 disabled:hover:bg-transparent">
          <ChevronLeft className="size-3.5" strokeWidth={1.75} /> Previous
        </button>
        <span className="mx-auto tabular-nums text-content/40">{index + 1} / {count}</span>
        <button type="button" onClick={() => onGo(index + 1)} disabled={index >= count - 1} className="flex h-7 items-center gap-1 rounded-md px-2 text-content/70 transition-colors duration-150 hover:bg-content/5 hover:text-content disabled:opacity-30 disabled:hover:bg-transparent">
          Next <ChevronRight className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
