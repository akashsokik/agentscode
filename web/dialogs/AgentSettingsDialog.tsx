import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { noProjectFolder, type Agent, type AgentRole, type MemoryEntry } from '../../shared/types.ts';
import { ROLES } from '../../shared/roles.ts';
import { api } from '../api.ts';
import { shortPath } from '../format.ts';
import { MEMORY_TEXT_MAX, MEMORY_WHY_MAX, memoryDate, SOUL_MAX, soulPath } from '../memory.ts';
import { ALL_PROJECTS, projectLabel } from '../projects.ts';
import { attempt, loadDreams, loadMemory, useApp } from '../store.ts';
import { HeaderButton, INPUT, PRIMARY, TEXTAREA } from '../ui/common.tsx';
import { Pencil, Trash2 } from '../mono/icons.tsx';
import { Modal } from '../mono/Modal.tsx';
import { useLockOverscroll } from '../mono/useLockOverscroll.ts';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Group, Row, Select } from '../mono/settings.tsx';
import { DreamingSection, SoulProposalGroup } from './Dreaming.tsx';
import { RemoveAgentDialog } from './RemoveAgentDialog.tsx';
import { submitKey } from './submitKey.ts';
import { AvatarPicker } from './AvatarPicker.tsx';
import { AgentAvatar } from '../ui/Avatar.tsx';
import { agentLook, type AvatarLook } from '../../shared/avatar.ts';
import { startProjectId } from '../../shared/agentProjects.ts';
import { choiceFrom, choiceValue, sameChoice, type ProjectsChoice } from '../projectPicker.ts';
import { ProjectsPicker } from './ProjectsPicker.tsx';
import { IS_MAC } from '../platform.ts';
import { openingSection, rememberedSection, rememberSection, SECTIONS, sectionForKey, type AgentSettingsSection } from '../settingsSections.ts';

export type { AgentSettingsSection };

/** Ask the app to open Settings at a group (the SuperAgent's limits live there, once, for every agent). */
export function openSettingsAt(group: 'super'): void {
  window.dispatchEvent(new CustomEvent('agentscode:open-settings', { detail: { group } }));
}

/**
 * An agent's settings, one section at a time (General, Soul, Memory, Dreaming) beside a section nav.
 * It opens on the section asked for (a deep link), else the last one you had open for this agent.
 */
export function AgentSettingsDialog({ agent, onClose, section: requested }: { agent: Agent; onClose: () => void; section?: AgentSettingsSection }) {
  const [section, setSectionState] = useState<AgentSettingsSection>(() => openingSection(requested, rememberedSection(agent.id)));
  const setSection = (next: AgentSettingsSection) => {
    setSectionState(next);
    rememberSection(agent.id, next);
  };
  const tabs = useRef(new Map<AgentSettingsSection, HTMLButtonElement>());
  const ids = `agent-settings-${agent.id}`;
  /** Arrow keys in the nav move and focus; Cmd or Ctrl with 1 to 4 picks a section from anywhere in the dialog. */
  const onKey = (event: KeyboardEvent<HTMLElement>, inNav: boolean) => {
    const next = sectionForKey(section, event, inNav);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    setSection(next);
    if (inNav) tabs.current.get(next)?.focus();
  };
  const scroller = useRef<HTMLDivElement | null>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  // Each section opens at its top, not wherever the last one was scrolled to.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [section]);
  const memoryCount = useApp(s => s.memory[agent.id]?.length);
  const proposal = useApp(s => Boolean(s.dreams[agent.id]?.proposal));
  useEffect(() => {
    void loadMemory(agent.id);
    void loadDreams(agent.id);
  }, [agent.id]);
  const home = useApp(s => s.snapshot?.home);
  const projects = useApp(s => s.snapshot?.projects);
  const project = projects?.find(p => p.id === startProjectId(agent));
  // Its projects (ACH-D15); a worktree keeps its start folder where it is.
  const [choice, setChoice] = useState<ProjectsChoice>(() => choiceFrom(agent.projectIds, agent.worktree ? startProjectId(agent) ?? undefined : undefined));
  const chosen = choiceValue(choice);
  const projectsChanged = agent.role !== 'super' && chosen !== undefined && !sameChoice(chosen, agent.projectIds);
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState<AgentRole>(agent.role);
  const [look, setLook] = useState<AvatarLook>(() => agentLook(agent));
  const lookChanged = agent.role !== 'super' && JSON.stringify(look) !== JSON.stringify(agentLook(agent));
  const allAgents = useApp(s => s.snapshot?.agents);
  const others = useMemo(() => (allAgents ?? []).filter(a => a.id !== agent.id).map(a => agentLook(a)), [allAgents, agent.id]);
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
    const ok = await attempt(() => api.updateAgent(agent.id, { name: name.trim(), role, instructions, ...(lookChanged ? { avatar: look } : {}), ...(projectsChanged ? { projectIds: chosen } : {}) }));
    setBusy(false);
    if (ok) onClose();
  };

  // The confirmation replaces this dialog rather than stacking on it; Cancel comes back here.
  if (removing) return <RemoveAgentDialog agent={agent} onClose={onClose} onCancel={() => setRemoving(false)} />;

  const onSubmitKey = submitKey(!busy && Boolean(name.trim()) && chosen !== undefined, () => void save());
  const usage = [`${agent.turns} ${agent.turns === 1 ? 'turn' : 'turns'}`, agent.costUsd ? `$${agent.costUsd.toFixed(2)}` : '', agent.tokens ? `${agent.tokens.toLocaleString()} tokens` : ''].filter(Boolean).join(', ');
  const noProject = agent.projectIds === null;
  const alsoNames = (agent.projectIds ?? []).slice(1).flatMap(id => (projects ?? []).filter(p => p.id === id).map(p => p.name));
  return (
    <Modal
      title={agent.name}
      description={projectLabel(agent.projectIds, projects) || undefined}
      size="lg"
      fitViewport
      className="h-[min(680px,calc(100dvh-32px))]"
      onClose={onClose}
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button type="button" className={PRIMARY} disabled={busy || !name.trim() || chosen === undefined} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      <div className="h-full pt-3" onKeyDownCapture={event => onKey(event, false)}>
      {/* Beside the section in a wide window; a compact row above it in a narrow one. Hairlines only. */}
      <div className="flex h-full min-h-0 flex-col border-t border-content/7 sm:flex-row">
        <div
          role="tablist"
          aria-label="Agent settings sections"
          onKeyDown={event => onKey(event, true)}
          className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-content/7 p-2 sm:w-36 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r"
        >
          {SECTIONS.map((item, index) => (
            <button
              key={item.id}
              ref={el => { if (el) tabs.current.set(item.id, el); else tabs.current.delete(item.id); }}
              type="button"
              role="tab"
              id={`${ids}-tab-${item.id}`}
              aria-selected={section === item.id}
              aria-controls={`${ids}-panel`}
              tabIndex={section === item.id ? 0 : -1}
              title={`${item.label} (${IS_MAC ? 'Cmd' : 'Ctrl'}+${index + 1})`}
              onClick={() => setSection(item.id)}
              className={`flex shrink-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${section === item.id ? 'bg-selection text-content' : 'text-content/60 hover:bg-content/5 hover:text-content'}`}
            >
              <span>{item.label}</span>
              {item.id === 'memory' && memoryCount ? <span className="text-[11px] tabular-nums text-content/40">{memoryCount}</span> : null}
              {item.id === 'soul' && proposal ? <><span aria-hidden className="size-1.5 rounded-full bg-accent" /><span className="sr-only">, a soul change is waiting</span></> : null}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`${ids}-panel`}
          aria-labelledby={`${ids}-tab-${section}`}
          ref={el => {
            scroller.current = el;
            lockOverscroll(el);
          }}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none px-4 pb-5 pt-4"
        >
          {section === 'general' ? (
            <>
              <Group title="Workspace">
                {agent.role === 'super' ? (
                  <Row label="Projects" description={`${ALL_PROJECTS}: it can work in any project you have added.`} />
                ) : (
                  <div className="border-b border-content/5 px-4 py-3.5">
                    <ProjectsPicker
                      choice={choice}
                      onChange={setChoice}
                      projects={projects ?? []}
                      agents={(allAgents ?? []).filter(a => a.id !== agent.id)}
                      engine={agent.engine}
                      note={`${agent.projectIds?.length === 0 ? 'Its project choice could not be read, so it has none for now: pick its projects and save. ' : ''}Changes apply from its next turn, removing a project too: until then the turn it is in keeps the projects it started with${agent.worktree ? '' : '; a new start folder begins a fresh session there'}. Notes and decisions it records go to the start folder's project unless it names another.`}
                    />
                  </div>
                )}
                <Row label="Folder" description={`${shortPath(agent.worktree?.cwd ?? project?.path ?? (noProject ? noProjectFolder(agent.home) : ''), home)}${alsoNames.length ? `, also ${alsoNames.join(' and ')}` : ''}`} />
                {agent.worktree ? <Row label="Worktree" description={`${agent.worktree.branch}, from ${agent.worktree.base}, for ${project?.name ?? 'its start folder'} only.${alsoNames.length ? ` ${alsoNames.join(' and ')} ${alsoNames.length === 1 ? 'is' : 'are'} used in place.` : ''}`} /> : null}
                <Row label="Usage" description={`${usage}${agent.sessionId ? `. Session ${agent.sessionId.slice(0, 8)}.` : '.'}`} />
              </Group>

              <Group title="Identity">
                <Row label="Name" description="Teammates address it by this name.">
                  <input value={name} maxLength={24} onChange={e => setName(e.target.value)} onKeyDown={onSubmitKey} className={`${INPUT} w-44`} />
                </Row>
                {agent.role === 'super' ? (
                  <Row label="Avatar" description="The SuperAgent keeps its own look, so it is easy to spot.">
                    <AgentAvatar agent={agent} className="size-8" />
                  </Row>
                ) : (
                  <>
                    <Row label="Avatar" description="How it looks across Podcode. Shuffle for one no other agent has." />
                    <AvatarPicker look={look} others={others} onChange={setLook} />
                  </>
                )}
                {agent.role === 'super' ? (
                  <Row label="Role" description="SuperAgent: it runs the team across every project and never edits. Remove it to stop using it." />
                ) : (
                  <Row label="Role" description={role === 'lead' ? 'Leads can delegate tasks and track reports.' : undefined}>
                    <Select label="Role" value={role} options={ROLES.map(r => ({ value: r.id, label: r.name }))} onChange={value => setRole(value as AgentRole)} />
                  </Row>
                )}
              </Group>

              {agent.role === 'super' ? (
                <Group title="Limits">
                  <Row label="Wake-ups, quiet hours, budgets and the creation cap" description="Kept once, in Settings, for everything it starts on its own.">
                    <SecondaryButton onClick={() => { onClose(); openSettingsAt('super'); }}>Open in Settings</SecondaryButton>
                  </Row>
                </Group>
              ) : null}

              <Group title="Remove">
                <Row label={`Remove ${agent.name}`} description="Stops it, deletes its transcript and cancels its queued messages.">
                  <SecondaryButton danger disabled={busy} onClick={() => setRemoving(true)}>Remove agent…</SecondaryButton>
                </Row>
              </Group>
            </>
          ) : null}

          {section === 'soul' ? (
            <>
              <SoulProposalGroup agent={agent} />

              <Group title="Soul" description={`Who ${agent.name} is and how it works. Only you edit it; changes reach it on its next turn.`}>
                <div className="px-4 py-3.5">
                  <p className="truncate font-mono text-[11px] text-content/40" title={soulPath(agent.home)}>{shortPath(soulPath(agent.home), home)}</p>
                  <textarea
                    aria-label="Soul"
                    value={instructions}
                    maxLength={SOUL_MAX}
                    onChange={e => setInstructions(e.target.value)}
                    onKeyDown={onSubmitKey}
                    rows={12}
                    className={`${TEXTAREA} mt-2`}
                    placeholder="Anything this agent should always keep in mind"
                  />
                  {instructions.length > SOUL_MAX * 0.9 ? (
                    <p className="mt-1 text-right text-[11px] text-content/40">{instructions.length.toLocaleString()} of {SOUL_MAX.toLocaleString()} characters</p>
                  ) : null}
                </div>
              </Group>
            </>
          ) : null}

          {section === 'memory' ? <MemorySection agent={agent} /> : null}

          {section === 'dreaming' ? <DreamingSection agent={agent} /> : null}
        </div>
      </div>
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
