import { useState } from 'react';
import type { ProfileEntry, ProfileProposal } from '../../shared/types.ts';
import { api } from '../api.ts';
import { MEMORY_TEXT_MAX, MEMORY_WHY_MAX, memoryDate } from '../memory.ts';
import { attempt, useApp } from '../store.ts';
import { HeaderButton, INPUT, PRIMARY, TEXTAREA } from '../ui/common.tsx';
import { Pencil, Plus, Trash2 } from '../mono/icons.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Modal } from '../mono/Modal.tsx';
import { Group } from '../mono/settings.tsx';
import { submitKey } from './submitKey.ts';

/** About you, from the sidebar: everything PodCode saved about the user, and where the file is. */
export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const file = useApp(s => s.snapshot?.profile.file);
  return (
    <Modal title="About you" size="md" fitViewport onClose={onClose}>
      <div className="px-4 pb-4 pt-4">
        <AboutYouGroup />
        {file ? (
          <p className="pt-4 text-[12px] leading-relaxed text-content/45">
            Saved in <span className="select-text break-all font-mono text-content/70">{file}</span>. Every agent reads it, whatever its project or engine.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * What PodCode knows about the user (user.md), shared by every agent: what waits for approval
 * first, then every entry, each editable and deletable, and a way to add one by hand.
 */
export function AboutYouGroup() {
  const profile = useApp(s => s.snapshot?.profile);
  const [adding, setAdding] = useState(false);
  if (!profile) return null;
  const { entries, proposals } = profile;
  return (
    <>
      {proposals.length ? (
        <Group title="Learned about you, waiting for approval" description="Agents inferred these, or several agents remembered the same thing. Accept adds it to what every agent knows; reject keeps it from being offered again.">
          {proposals.map(proposal => <ProposalRow key={proposal.id} proposal={proposal} />)}
        </Group>
      ) : null}
      <Group
        title="About you"
        description="What every agent knows about you: your style, taste and how you like to work. Agents add to it as they learn; changes here reach each agent on its next turn."
        action={adding ? null : <SecondaryButton onClick={() => setAdding(true)}><Plus className="size-3.5" strokeWidth={1.75} /> Add</SecondaryButton>}
      >
        {adding ? <EntryEditor onDone={() => setAdding(false)} /> : null}
        {entries.length === 0 && !adding ? (
          <div className="px-4 py-3.5">
            <p className="text-[13px] text-content/75">Nothing learned yet.</p>
            <p className="mt-1 text-[12px] leading-relaxed text-content/45">
              When you tell an agent how you like things done, it saves it here for every agent. Dreams add what you say outright, and ask you first about anything they infer.
            </p>
          </div>
        ) : (
          entries.map(entry => <EntryRow key={entry.id} entry={entry} />)
        )}
      </Group>
    </>
  );
}

function Meta({ at, from, dream }: { at: number; from?: string; dream?: boolean }) {
  return (
    <p className="mt-0.5 text-[11px] text-content/35">
      <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{memoryDate(at)}</time>
      {from ? <span> · from {from}</span> : null}
      {dream ? <span title="Written by a dream. Undoing that dream removes it."> · by a dream</span> : null}
    </p>
  );
}

/** Add an entry (no `entry`) or rewrite one. */
function EntryEditor({ entry, onDone }: { entry?: ProfileEntry; onDone: () => void }) {
  const [text, setText] = useState(entry?.text ?? '');
  const [why, setWhy] = useState(entry?.why ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    // An empty why clears the stored reason; leaving it out would keep it.
    const patch = { text: text.trim(), why: why.trim() };
    const ok = await attempt(() => (entry ? api.updateProfile(entry.id, patch) : api.addProfile(patch)));
    setBusy(false);
    if (ok) onDone();
  };
  const onKey = submitKey(!busy && Boolean(text.trim()), () => void save());
  return (
    <div data-profile-editor className="flex flex-col gap-2 border-b border-content/5 px-4 py-3 last:border-b-0">
      <textarea autoFocus aria-label="About you" value={text} maxLength={MEMORY_TEXT_MAX} onChange={e => setText(e.target.value)} onKeyDown={onKey} rows={2} placeholder="For example: keep replies short; no emojis." className={TEXTAREA} />
      <input aria-label="Why" value={why} maxLength={MEMORY_WHY_MAX} onChange={e => setWhy(e.target.value)} onKeyDown={onKey} placeholder="Why (optional)" className={INPUT} />
      <div className="flex justify-end gap-2">
        <SecondaryButton disabled={busy} onClick={onDone}>Cancel</SecondaryButton>
        <button type="button" className={PRIMARY} disabled={busy || !text.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

function EntryRow({ entry }: { entry: ProfileEntry }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  if (editing) return <EntryEditor entry={entry} onDone={() => setEditing(false)} />;
  const forget = async () => {
    setBusy(true);
    await attempt(() => api.forgetProfile(entry.id));
    setBusy(false);
  };
  return (
    <div data-profile-entry={entry.id} className="group/profile flex items-start gap-3 border-b border-content/5 px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-content">{entry.text}</p>
        {entry.why ? <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-content/45">Why: {entry.why}</p> : null}
        <Meta at={entry.createdAt} from={entry.from} dream={Boolean(entry.dreamId)} />
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover/profile:opacity-100 focus-within:opacity-100">
        <HeaderButton icon={Pencil} label="Edit" disabled={busy} onClick={() => setEditing(true)} />
        <HeaderButton icon={Trash2} label="Delete" disabled={busy} onClick={() => void forget()} />
      </div>
    </div>
  );
}

function ProposalRow({ proposal }: { proposal: ProfileProposal }) {
  const [busy, setBusy] = useState(false);
  const decide = async (action: 'accept' | 'reject') => {
    setBusy(true);
    await attempt(() => api.decideProfile(proposal.id, action));
    setBusy(false);
  };
  const replaces = proposal.sources?.length
    ? `Accepting removes it from ${proposal.sources.map(s => s.agentName).join(' and ')}'s memory, since every agent reads this.`
    : '';
  return (
    <div data-profile-proposal={proposal.id} className="flex items-start gap-3 border-b border-content/5 px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-content">{proposal.text}</p>
        {proposal.why ? <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-content/45">Why: {proposal.why}</p> : null}
        {replaces ? <p className="mt-0.5 text-[12px] leading-relaxed text-content/45">{replaces}</p> : null}
        <Meta at={proposal.at} from={proposal.from} dream={proposal.kind === 'dream'} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SecondaryButton disabled={busy} onClick={() => void decide('reject')}>Reject</SecondaryButton>
        <button type="button" className={PRIMARY} disabled={busy} onClick={() => void decide('accept')}>Accept</button>
      </div>
    </div>
  );
}
