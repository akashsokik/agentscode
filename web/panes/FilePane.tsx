import hljs from 'highlight.js/lib/common';
import { useEffect, useMemo, useState } from 'react';
import type { FileContent, FileDiff } from '../../shared/types.ts';
import { api, type Root } from '../api.ts';
import { open } from '../layout.ts';
import { AlertCircle, File, FileDiff as FileDiffIcon, RefreshCw } from '../mono/icons.tsx';
import { cx, Empty, HeaderButton, Loading } from '../ui/common.tsx';
import { PaneFrame, type PaneChrome } from './PaneFrame.tsx';

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', mdx: 'markdown', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby', php: 'php',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', sql: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  diff: 'diff', patch: 'diff', graphql: 'graphql', lua: 'lua', r: 'r', pl: 'perl',
};

export function languageOf(path: string): string | null {
  const name = path.split('/').pop() ?? '';
  if (name === 'Dockerfile') return 'dockerfile';
  if (name === 'Makefile') return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const lang = LANGUAGES[ext];
  return lang && hljs.getLanguage(lang) ? lang : null;
}

function fileName(path: string): string {
  return path.split('/').pop() || path;
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    load().then(result => { if (live) setData(result); }, err => { if (live) setError((err as Error).message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { data, error, reload: () => setNonce(n => n + 1) };
}

/** Read-only file viewer with syntax highlighting and line numbers. */
export function FilePane({ root, path, chrome }: { root: Root; path: string; chrome: PaneChrome }) {
  const { data, error } = useLoad<FileContent>(() => api.readFile(root, path), [JSON.stringify(root), path]);
  const html = useMemo(() => {
    if (!data || data.binary) return null;
    const lang = languageOf(path);
    if (!lang || data.text.length > 400_000) return null;
    try {
      // highlight.js escapes the source text and only adds <span class> tags, so its output is safe to inject.
      return hljs.highlight(data.text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [data, path]);
  const lines = data && !data.binary ? data.text.split('\n').length - (data.text.endsWith('\n') ? 1 : 0) : 0;

  return (
    <PaneFrame
      chrome={chrome}
      title={<span className="flex min-w-0 items-center gap-2"><File className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} /><span className="truncate text-content">{fileName(path)}</span><span className="min-w-0 truncate font-normal text-content/40">{path}</span></span>}
      actions={<HeaderButton icon={FileDiffIcon} label="Open diff" onClick={() => open({ kind: 'diff', root, path })} />}
    >
      {error ? <Empty icon={AlertCircle} title="Could not open the file">{error}</Empty>
        : !data ? <Loading className="grid flex-1 place-items-center" />
        : data.binary ? <Empty icon={File} title="Binary file">{(data.size / 1024).toFixed(1)} KB</Empty>
        : (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="flex min-w-max font-mono text-[var(--code-font-size)] leading-[1.6]">
              <pre aria-hidden className="sticky left-0 shrink-0 select-none bg-background-base py-3 pl-4 pr-3 text-right text-content/30">
                {Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join('\n')}
              </pre>
              {html !== null
                ? <pre className="flex-1 py-3 pr-6 text-content/90 select-text" dangerouslySetInnerHTML={{ __html: html }} />
                : <pre className="flex-1 py-3 pr-6 text-content/90 select-text">{data.text}</pre>}
            </div>
            {data.truncated && <p className="px-4 pb-4 text-[11.5px] text-content/45">Showing the first 1 MB of {(data.size / 1024 / 1024).toFixed(1)} MB.</p>}
          </div>
        )}
    </PaneFrame>
  );
}

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
  old?: number;
  new?: number;
}

export function parseDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith('Binary files')) lines.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1), new: newLine++ });
    else if (raw.startsWith('-')) lines.push({ kind: 'del', text: raw.slice(1), old: oldLine++ });
    else if (raw.startsWith('\\')) lines.push({ kind: 'meta', text: raw });
    else if (raw.startsWith('diff --git')) inHunk = false;
    else if (raw !== '' || lines.length) lines.push({ kind: 'ctx', text: raw.slice(1), old: oldLine++, new: newLine++ });
  }
  // A trailing empty context line comes from the final newline.
  while (lines.length && lines[lines.length - 1].kind === 'ctx' && lines[lines.length - 1].text === '') lines.pop();
  return lines;
}

/** Unified diff of one file against HEAD. */
export function DiffPane({ root, path, chrome }: { root: Root; path: string; chrome: PaneChrome }) {
  const { data, error, reload } = useLoad<FileDiff>(() => api.gitDiff(root, path), [JSON.stringify(root), path]);
  const lines = useMemo(() => (data ? parseDiff(data.diff) : []), [data]);
  const added = lines.filter(l => l.kind === 'add').length;
  const removed = lines.filter(l => l.kind === 'del').length;
  return (
    <PaneFrame
      chrome={chrome}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <FileDiffIcon className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
          <span className="truncate text-content">{fileName(path)}</span>
          <span className="shrink-0 font-mono text-[11px] text-diff-add-fg">+{added}</span>
          <span className="shrink-0 font-mono text-[11px] text-diff-del-fg">-{removed}</span>
          <span className="min-w-0 truncate font-normal text-content/40">{path}</span>
        </span>
      }
      actions={
        <>
          <HeaderButton icon={RefreshCw} label="Refresh diff" onClick={reload} />
          <HeaderButton icon={File} label="Open file" onClick={() => open({ kind: 'file', root, path })} />
        </>
      }
    >
      {error ? <Empty icon={AlertCircle} title="Could not diff the file">{error}</Empty>
        : !data ? <Loading className="grid flex-1 place-items-center" />
        : !lines.length ? <Empty icon={FileDiffIcon} title="No changes">This file matches HEAD.</Empty>
        : (
          <div className="min-h-0 flex-1 overflow-auto py-2">
            <table className="min-w-full border-collapse font-mono text-[var(--code-font-size)] leading-[1.6]">
              <tbody>
                {lines.map((line, i) => {
                  if (line.kind === 'hunk' || line.kind === 'meta') {
                    return <tr key={i}><td colSpan={4} className="bg-content/5 px-4 py-0.5 text-[11px] text-content/45">{line.text}</td></tr>;
                  }
                  // The number columns take the stronger gutter tint, so changed rows read at a glance.
                  const gutter = cx('w-10 select-none px-2 text-right tabular-nums', line.kind === 'add' ? 'bg-diff-add-gutter text-content/45' : line.kind === 'del' ? 'bg-diff-del-gutter text-content/45' : 'text-content/30');
                  return (
                  <tr key={i} className={cx(line.kind === 'add' && 'bg-diff-add-bg', line.kind === 'del' && 'bg-diff-del-bg')}>
                    <td className={gutter}>{line.old ?? ''}</td>
                    <td className={gutter}>{line.new ?? ''}</td>
                    <td className={cx('w-5 select-none text-center', line.kind === 'add' ? 'text-diff-add-fg' : line.kind === 'del' ? 'text-diff-del-fg' : 'text-content/25')}>
                      {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}
                    </td>
                    <td className={cx('whitespace-pre pl-1 pr-6 select-text', line.kind === 'add' ? 'text-diff-add-fg' : line.kind === 'del' ? 'text-diff-del-fg' : 'text-content/80')}>{line.text}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </PaneFrame>
  );
}
