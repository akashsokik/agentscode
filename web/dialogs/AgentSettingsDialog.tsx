import { useState } from 'react';
import type { Agent, AgentRole } from '../../shared/types.ts';
import { ROLES } from '../../shared/roles.ts';
import { api } from '../api.ts';
import { shortPath } from '../format.ts';
import { attempt, useApp } from '../store.ts';
import { INPUT, PRIMARY, TEXTAREA } from '../ui/common.tsx';
import { Modal } from '../mono/Modal.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Group, Row, Select } from '../mono/settings.tsx';
import { RemoveAgentDialog } from './RemoveAgentDialog.tsx';
import { submitKey } from './submitKey.ts';

export function AgentSettingsDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const home = useApp(s => s.snapshot?.home);
  const project = useApp(s => s.snapshot?.projects.find(p => p.id === agent.projectId));
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState<AgentRole>(agent.role);
  const [instructions, setInstructions] = useState(agent.instructions);
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
  return (
    <Modal
      title={agent.name}
      description={project?.name}
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
          <Row label="Folder" description={shortPath(agent.worktree?.cwd ?? project?.path ?? '', home)} />
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
          <div className="px-4 py-3.5">
            <div className="text-[13px] font-medium text-content">Standing instructions</div>
            <p className="mt-1 text-[12px] leading-relaxed text-content/45">Applies when the next session starts.</p>
            <textarea value={instructions} onChange={e => setInstructions(e.target.value)} onKeyDown={onSubmitKey} rows={4} className={`${TEXTAREA} mt-2`} />
          </div>
        </Group>

        <Group title="Remove">
          <Row label={`Remove ${agent.name}`} description="Stops it, deletes its transcript and cancels its queued messages.">
            <SecondaryButton danger disabled={busy} onClick={() => setRemoving(true)}>Remove agent…</SecondaryButton>
          </Row>
        </Group>
      </div>
    </Modal>
  );
}
