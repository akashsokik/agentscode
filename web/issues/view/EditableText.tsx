/**
 * The issue's title and description, edited in place. The title is one line: ⏎ saves, ⎋ puts it
 * back. The description reads as Markdown; a click (or ⏎ on it) opens a plain editor where ⌘⏎
 * saves and ⎋ cancels. Both save through the issue API (issueWrites.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../../ui/Markdown.tsx';
import { Kbd } from '../../ui/Kbd.tsx';
import { TEXTAREA, TextButton } from '../../ui/common.tsx';
import { writeIssue } from './issueWrites.ts';

export function IssueTitle({ id, title }: { id: string; title: string }) {
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(title), [title]);
  const save = async () => {
    const next = draft.replace(/\s+/g, ' ').trim();
    if (!next || next === title || busy) { setDraft(title); return; }
    setBusy(true);
    if (!(await writeIssue(id, { title: next }))) setDraft(title);
    setBusy(false);
  };
  return (
    <input
      aria-label="Title"
      value={draft}
      maxLength={200}
      aria-busy={busy || undefined}
      onChange={e => setDraft(e.target.value.replace(/[\r\n]+/g, ' '))}
      onBlur={() => void save()}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(title); requestAnimationFrame(() => e.currentTarget?.blur()); }
      }}
      className="w-full rounded-md bg-transparent px-1 -mx-1 font-sans text-[20px] font-semibold leading-tight text-content outline-none hover:bg-content/4 focus:bg-content/5"
    />
  );
}

export function IssueDescription({ id, text }: { id: string; text: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const shown = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!editing) setDraft(text); }, [text, editing]);
  const close = () => { setEditing(false); requestAnimationFrame(() => shown.current?.focus()); };
  const save = async () => {
    if (busy) return;
    if (!draft.trim() || draft === text) { close(); return; }
    setBusy(true);
    const ok = await writeIssue(id, { text: draft });
    setBusy(false);
    if (ok) close();
  };
  if (editing) {
    return (
      <div className="flex flex-col gap-1.5">
        <textarea
          autoFocus
          aria-label="Description"
          value={draft}
          rows={Math.min(18, Math.max(4, draft.split('\n').length + 1))}
          maxLength={4000}
          aria-busy={busy || undefined}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(text); close(); }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
          }}
          className={`${TEXTAREA} text-[13px] leading-relaxed`}
        />
        <div className="flex items-center justify-end gap-2 font-sans text-[11px] text-content/45">
          <span className="mr-auto inline-flex items-center gap-1"><Kbd spec="Mod+Enter" quiet /> save <Kbd spec="Escape" quiet /> cancel</span>
          <TextButton onClick={() => { setDraft(text); close(); }}>Cancel</TextButton>
          <TextButton onClick={() => void save()} disabled={!draft.trim()}>Save</TextButton>
        </div>
      </div>
    );
  }
  return (
    <div
      ref={shown}
      role="button"
      tabIndex={0}
      aria-label="Description, press Enter to edit"
      onClick={e => { if (!(e.target as HTMLElement).closest('a, button')) setEditing(true); }}
      onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); setEditing(true); } }}
      className="-mx-1 cursor-text rounded-md px-1 py-0.5 outline-none hover:bg-content/4 focus-visible:bg-content/5"
    >
      {text.trim() ? <Markdown text={text} className="text-[13px] leading-[1.6] text-content/80" /> : <p className="font-sans text-[13px] text-content/40">Add a description…</p>}
    </div>
  );
}
