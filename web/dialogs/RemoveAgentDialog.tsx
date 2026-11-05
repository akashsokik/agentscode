import { useState } from 'react';
import type { Agent, WorktreeCleanup } from '../../shared/types.ts';
import { api } from '../api.ts';
import { attempt } from '../store.ts';
import { Modal } from '../mono/Modal.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Segmented } from '../mono/settings.tsx';

/**
 * Confirms removing an agent, which cannot be undone: it stops, its transcript is
 * deleted and its queued messages are cancelled. `onCancel` defaults to `onClose`.
 */
export function RemoveAgentDialog({ agent, onClose, onCancel = onClose }: { agent: Agent; onClose: () => void; onCancel?: () => void }) {
  const [cleanup, setCleanup] = useState<WorktreeCleanup>('keep');
  const [busy, setBusy] = useState(false);
  const working = agent.status === 'working' || agent.status === 'waiting';

  const remove = async () => {
    setBusy(true);
    const ok = await attempt(async () => { await api.removeAgent(agent.id, cleanup); return true; });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      title={`Remove ${agent.name}?`}
      size="sm"
      onClose={onCancel}
      footer={
        <>
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <SecondaryButton danger disabled={busy} onClick={() => void remove()}>{busy ? 'Removing…' : 'Remove agent'}</SecondaryButton>
        </>
      }
    >
      <div className="px-4 pb-4 pt-2 font-sans">
        <p className="text-[12px] leading-relaxed text-content/60">
          {working ? `${agent.name} is working; removing it stops the current turn. ` : ''}
          Its transcript is deleted and its queued messages are cancelled. This cannot be undone.
        </p>
        {agent.worktree ? (
          <div className="mt-4">
            <div className="text-[13px] font-medium text-content">Its worktree</div>
            <p className="mt-1 text-[12px] leading-relaxed text-content/45">
              The branch {agent.worktree.branch} is always kept. Remove deletes the folder; Discard also deletes uncommitted changes.
            </p>
            <div className="mt-2">
              <Segmented<WorktreeCleanup>
                label="Worktree"
                value={cleanup}
                onChange={setCleanup}
                options={[{ value: 'keep', label: 'Keep' }, { value: 'remove', label: 'Remove' }, { value: 'discard', label: 'Discard' }]}
              />
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
