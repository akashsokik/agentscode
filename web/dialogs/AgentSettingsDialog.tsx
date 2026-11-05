import { useEffect, useState } from 'react';
import { noProjectFolder, type Agent, type AgentRole, type MemoryEntry } from '../../shared/types.ts';
import { ROLES } from '../../shared/roles.ts';
import { api } from '../api.ts';
import { shortPath } from '../format.ts';
import { MEMORY_TEXT_MAX, MEMORY_WHY_MAX, memoryDate, SOUL_MAX, soulPath } from '../memory.ts';
import { ALL_PROJECTS, projectLabel } from '../projects.ts';
import { attempt, loadMemory, useApp } from '../store.ts';
import { HeaderButton, INPUT, PRIMARY, TEXTAREA } from '../ui/common.tsx';
import { Pencil, Trash2 } from '../mono/icons.tsx';
import { Modal } from '../mono/Modal.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Group, Row, Select } from '../mono/settings.tsx';
import { DreamingSection, SoulProposalGroup } from './Dreaming.tsx';
import { RemoveAgentDialog } from './RemoveAgentDialog.tsx';
import { submitKey } from './submitKey.ts';

export function AgentSettingsDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const home = useApp(s => s.snapshot?.home);
  const projects = useApp(s => s.snapshot?.projects);
  const project = projects?.find(p => p.id === agent.projectId);
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState<AgentRole>(agent.role);
  const [instructions, setInstructions] = useState(agent.instructions);
  // Accepting a soul proposal (or a hand edit of soul.md) changes the soul while this is open. A box
  // you have not touched follows it, so Save never writes the old soul back.
  const [soulFrom, setSoulFrom] = useState(agent.instructions);
  useEffect(() => {
    if (agent.instructions === soulFrom) return;
    setInstructions(current => (current === soulFrom ? agent.instructions : current));
    setSoulFrom(agent.instructions);
  }, [agent.instructions, soulFrom]);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const ok = await attempt(() => api.updateAgent(agent.id, { name: name.trim(), role, instructions }));
    setBusy(false);
    if (ok) onClose();
  };

  // The confirmation replaces this dialog rather than stacking on it; Cancel comes back here.
  if (removing) return <RemoveAgentDialog agent={agent} onClose={onClose} onCancel={() => setRemoving(false)} />;

  const onSubmitKey = submitKey(!busy && Boolean(name.trim()), () => void save());
  const usage = [`${agent.turns} ${agent.turns === 1 ? 'turn' : 'turns'}`, agent.costUsd ? `$${agent.costUsd.toFixed(2)}` : '', agent.tokens ? `${agent.tokens.toLocaleString()} tokens` : ''].filter(Boolean).join(', ');
  const noProject = agent.projectId === null;
  return (
    <Modal
      title={agent.name}
      description={projectLabel(agent.projectId, projects) || undefined}
      size="md"
      fitViewport
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button type="button" className={PRIMARY} disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      <div className="px-4 pb-5 pt-4">
        <Group title="Workspace">
          <Row label="Folder" description={shortPath(agent.worktree?.cwd ?? project?.path ?? (noProject ? noProjectFolder(agent.home) : ''), home)} />
          {noProject ? <Row label="Projects" description={`${ALL_PROJECTS}: it can work in any project you have added.`} /> : null}
          {agent.worktree ? <Row label="Branch" description={`${agent.worktree.branch}, from ${agent.worktree.base}`} /> : null}
          <Row label="Usage" description={`${usage}${agent.sessionId ? `. Session ${agent.sessionId.slice(0, 8)}.` : '.'}`} />
        </Group>

        <Group title="Identity">
          <Row label="Name" description="Teammates address it by this name.">
            <input value={name} maxLength={24} onChange={e => setName(e.target.value)} onKeyDown={onSubmitKey} className={`${INPUT} w-44`} />
          </Row>
          <Row label="Role" description={role === 'lead' ? 'Leads can delegate tasks and track reports.' : undefined}>
            <Select label="Role" value={role} options={ROLES.map(r => ({ value: r.id, label: r.name }))} onChange={value => setRole(value as AgentRole)} />
          </Row>
        </Group>

        <Group title="Soul" description={`Who ${agent.name} is and how it works. Only you edit it; changes reach it on its next turn.`}>
          <div className="px-4 py-3.5">
            <p className="truncate font-mono text-[11px] text-content/40" title={soulPath(agent.home)}>{shortPath(soulPath(agent.home), home)}</p>
            <textarea
              aria-label="Soul"
              value={instructions}
              maxLength={SOUL_MAX}
              onChange={e => setInstructions(e.target.value)}
              onKeyDown={onSubmitKey}
              rows={10}
              className={`${TEXTAREA} mt-2`}
              placeholder="Anything this agent should always keep in mind"
            />
            {instructions.length > SOUL_MAX * 0.9 ? (
              <p className="mt-1 text-right text-[11px] text-content/40">{instructions.length.toLocaleString()} of {SOUL_MAX.toLocaleString()} characters</p>
            ) : null}
          </div>
        </Group>

        <SoulProposalGroup agent={agent} />

        <MemorySection agent={agent} />

        <DreamingSection agent={agent} />

        <Group title="Remove">
          <Row label={`Remove ${agent.name}`} description="Stops it, deletes its transcript and cancels its queued messages.">
            <SecondaryButton danger disabled={busy} onClick={() => setRemoving(true)}>Remove agent…</SecondaryButton>
          </Row>
        </Group>
      </div>
    </Modal>
  );
}

/** What the agent has learned, kept live by memory events; each entry can be edited or deleted here. */
function MemorySection({ agent }: { agent: Agent }) {
  const entries = useApp(s => s.memory[agent.id]);
  useEffect(() => {
    void loadMemory(agent.id);
  }, [agent.id]);
  return (
    <Group title="Memory" description={`What ${agent.name} learned. Changes here save at once and reach it on its next turn.`}>
      {entries === undefined ? (
        <p className="px-4 py-3.5 text-[12px] text-content/45">Loading…</p>
      ) : entries.length === 0 ? (
        <div className="px-4 py-3.5">
          <p className="text-[13px] text-content/75">Nothing remembered yet.</p>
          <p className="mt-1 text-[12px] leading-relaxed text-content/45">
            {agent.name} saves an entry here when you tell it to remember something, or when you correct it. Each one says what it learned and why, and you can edit or delete it.
          </p>
        </div>
      ) : (
        entries.map(entry => <MemoryRow key={entry.id} agentId={agent.id} entry={entry} />)
      )}
    </Group>
  );
}

function MemoryRow({ agentId, entry }: { agentId: string; entry: MemoryEntry }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.text);
  const [why, setWhy] = useState(entry.why ?? '');
  const [busy, setBusy] = useState(false);

  const edit = () => {
    setText(entry.text);
    setWhy(entry.why ?? '');
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    // An empty why clears the stored reason; leaving it out would keep it.
    const ok = await attempt(() => api.updateMemory(agentId, entry.id, { text: text.trim(), why: why.trim() }));
    setBusy(false);
    if (ok) setEditing(false);
  };
  const forget = async () => {
    setBusy(true);
    await attempt(() => api.forgetMemory(agentId, entry.id));
    setBusy(false);
  };

  if (editing) {
    const onKey = submitKey(!busy && Boolean(text.trim()), () => void save());
    return (
      <div data-memory-entry={entry.id} className="flex flex-col gap-2 border-b border-content/5 px-4 py-3 last:border-b-0">
        <textarea autoFocus aria-label="What it remembers" value={text} maxLength={MEMORY_TEXT_MAX} onChange={e => setText(e.target.value)} onKeyDown={onKey} rows={2} className={TEXTAREA} />
        <input aria-label="Why" value={why} maxLength={MEMORY_WHY_MAX} onChange={e => setWhy(e.target.value)} onKeyDown={onKey} placeholder="Why (optional)" className={INPUT} />
        <div className="flex justify-end gap-2">
          <SecondaryButton disabled={busy} onClick={() => setEditing(false)}>Cancel</SecondaryButton>
          <button type="button" className={PRIMARY} disabled={busy || !text.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    );
  }
  return (
    <div data-memory-entry={entry.id} className="group/memory flex items-start gap-3 border-b border-content/5 px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-content">{entry.text}</p>
        {entry.why ? <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-content/45">Why: {entry.why}</p> : null}
        <p className="mt-0.5 text-[11px] text-content/35">
          <time dateTime={new Date(entry.createdAt).toISOString()} title={new Date(entry.createdAt).toLocaleString()}>{memoryDate(entry.createdAt)}</time>
          {/* Your edits and deletes of these count against dreaming in its stats. */}
          {entry.dreamId ? <span title="Written by a dream. Editing or deleting it counts as a revert in the dreaming stats."> · from a dream</span> : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover/memory:opacity-100 focus-within:opacity-100">
        <HeaderButton icon={Pencil} label="Edit" disabled={busy} onClick={edit} />
        <HeaderButton icon={Trash2} label="Delete" disabled={busy} onClick={() => void forget()} />
      </div>
    </div>
  );
}
