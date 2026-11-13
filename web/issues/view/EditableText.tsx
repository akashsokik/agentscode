/**
 * The issue's title and description, edited in place, within the model's limits (120 and 4000).
 * The title wraps but is one line of text: ⏎ saves, ⎋ puts it back. The description reads as Markdown; a click (or ⏎ on it) opens a plain editor where ⌘⏎
 * saves and ⎋ cancels. Both save through the issue API (issueWrites.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../../ui/Markdown.tsx';
import { Kbd } from '../../ui/Kbd.tsx';
import { TEXTAREA, TextButton } from '../../ui/common.tsx';
import { commitEdit, descriptionToSave, TEXT_MAX, TITLE_MAX, titleToSave } from './issueViewModel.ts';
import { writeIssue } from './issueWrites.ts';

export function IssueTitle({ id, title, size = 'text-[20px]' }: {
  id: string;
  title: string;
  /** Its type size: the issue view's 20px, or the Issues page hero's 18px (InboxHero heading). */
  size?: string;
}) {
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(title), [title]);
  // Leaving mid-edit (another issue picked) saves the typed title too: blur does not fire then.
  const pending = useRef({ draft, title });
  pending.current = { draft, title };
  useEffect(() => () => {
    const next = titleToSave(pending.current.draft, pending.current.title);
    if (next) void writeIssue(id, { title: next });
  }, [id]);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    const result = await commitEdit(titleToSave(draft, title) ?? undefined, next => writeIssue(id, { title: next }));
    if (result !== 'saved') setDraft(title);
    setBusy(false);
  };
  // A textarea that grows with the title, so a long one wraps instead of being cut (one line of
  // text all the same: Enter saves, line breaks typed or pasted become spaces).
  return (
    <textarea
      aria-label="Title"
      rows={1}
      value={draft}
      maxLength={TITLE_MAX}
      aria-busy={busy || undefined}
      onChange={e => setDraft(e.target.value.replace(/[\r\n]+/g, ' '))}
      onBlur={() => void save()}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation(); setDraft(title);
          const el = e.currentTarget; // React clears currentTarget once the handler returns
          requestAnimationFrame(() => el.blur());
        }
      }}
      className={`-mx-1 block w-full resize-none overflow-hidden rounded-md bg-transparent px-1 font-sans ${size} font-semibold leading-tight text-content outline-none [field-sizing:content] hover:bg-content/4 focus:bg-content/5`}
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
  // Leaving with the editor open (another issue picked, the tab closed) saves the draft rather than
  // dropping what was typed (ACH-23); an unchanged or empty draft saves nothing.
  const pending = useRef({ editing, draft, text });
  pending.current = { editing, draft, text };
  useEffect(() => () => {
    const { editing: open, draft: typed, text: saved } = pending.current;
    const next = open ? descriptionToSave(typed, saved) : null;
    if (next) void writeIssue(id, { text: next });
  }, [id]);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    const result = await commitEdit(descriptionToSave(draft, text) ?? undefined, next => writeIssue(id, { text: next }));
    setBusy(false);
    // Refused: the editor stays open with the draft, so nothing typed is lost (the toast says why).
    if (result !== 'reverted') close();
  };
  if (editing) {
    return (
      <div className="flex flex-col gap-1.5">
        <textarea
          autoFocus
          aria-label="Description"
          value={draft}
          rows={Math.min(18, Math.max(4, draft.split('\n').length + 1))}
          maxLength={TEXT_MAX}
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
      {text.trim() ? <Markdown inert text={text} className="text-[13px] leading-[1.6] text-content/80" /> : <p className="font-sans text-[13px] text-content/40">Add a description…</p>}
    </div>
  );
}
