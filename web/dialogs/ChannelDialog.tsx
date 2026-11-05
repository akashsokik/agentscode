import { useEffect, useState } from 'react';
import type { Channel } from '../../shared/types.ts';
import { api } from '../api.ts';
import { open } from '../layout.ts';
import { attempt, useApp } from '../store.ts';
import { AgentPicker } from '../ui/AgentPicker.tsx';
import { INPUT, PRIMARY } from '../ui/common.tsx';
import { Modal } from '../mono/Modal.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Group, Row } from '../mono/settings.tsx';
import { submitKey } from './submitKey.ts';

/** The name the server saves, as channelName in server/comms/channels.ts makes it. */
function slug(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#+/, '').replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Create a channel, or change one: name, topic and members from any project. */
export function ChannelDialog({ channel, onClose, onNewAgent }: { channel?: Channel; onClose: () => void; onNewAgent?: () => void }) {
  const agents = useApp(s => s.snapshot?.agents) ?? [];
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [members, setMembers] = useState<string[]>(channel?.memberIds ?? []);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // An armed delete disarms itself if it is not confirmed soon.
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = window.setTimeout(() => setConfirmDelete(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);

  const finalName = slug(name);
  const crossProject = new Set(agents.filter(a => members.includes(a.id)).map(a => a.projectId)).size > 1;

  const save = async () => {
    setBusy(true);
    const input = { name: name.trim(), topic: topic.trim(), memberIds: members };
    const saved = await attempt(() => (channel ? api.updateChannel(channel.id, input) : api.createChannel(input)));
    setBusy(false);
    if (!saved) return;
    if (!channel) open({ kind: 'channel', channelId: saved.id });
    onClose();
  };

  const onSubmitKey = submitKey(!busy && Boolean(finalName), () => void save());

  const remove = async () => {
    if (!channel) return;
    setBusy(true);
    const ok = await attempt(async () => { await api.removeChannel(channel.id); return true; });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      title={channel ? `#${channel.name}` : 'New channel'}
      description={channel ? 'Channel settings' : 'A room where you and agents from any project work together.'}
      size="md"
      fitViewport
      onClose={onClose}
      footer={
        <>
          {members.length ? <span className="mr-auto font-sans text-[12px] text-content/45">{members.length} {members.length === 1 ? 'member' : 'members'}</span> : null}
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button type="button" className={PRIMARY} disabled={busy || !finalName} onClick={() => void save()}>
            {channel ? 'Save' : 'Create channel'}
          </button>
        </>
      }
    >
      <div className="px-4 pb-5 pt-4">
        <Group title="Channel">
          <Row label="Name" description={name.trim() && finalName !== name.trim() ? (finalName ? `Saved as #${finalName}.` : 'Needs a letter or number.') : 'Lowercase letters, numbers and hyphens.'}>
            <span className="flex w-52 items-center gap-1 font-mono text-[12px] text-content/45">
              #<input autoFocus={!channel} value={name} maxLength={40} onChange={e => setName(e.target.value)} onKeyDown={onSubmitKey} placeholder="release-prep" className={`${INPUT} font-mono`} spellCheck={false} />
            </span>
          </Row>
          <Row label="Topic" description="Optional. Agents see it with every post.">
            <input value={topic} maxLength={250} onChange={e => setTopic(e.target.value)} onKeyDown={onSubmitKey} placeholder="What this channel is for" className={`${INPUT} w-52`} />
          </Row>
        </Group>

        <Group
          title="Members"
          description="Search across every project. A mention starts that agent in its own session and project, and members can reach each other here whatever the team settings say."
        >
          {agents.length ? <AgentPicker value={members} onChange={setMembers} /> : (
            <Row label="No agents yet" description="Create agents in any project, then add them here.">
              {onNewAgent ? <SecondaryButton onClick={() => { onClose(); onNewAgent(); }}>New agent</SecondaryButton> : null}
            </Row>
          )}
        </Group>
        {crossProject ? <p className="px-1 pt-2 text-[12px] leading-relaxed text-content/45">These members work in different projects. Each one sees the others' workspace paths, so they can read each other's code when they need to.</p> : null}

        {channel ? (
          <Group title="Delete">
            <Row label={`Delete #${channel.name}`} description="Removes the channel and its posts. The agents and their transcripts stay.">
              {/* Deleting takes every post with it, so the first click only arms the button. */}
              <SecondaryButton danger disabled={busy} onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}>
                {confirmDelete ? 'Click again to delete' : 'Delete channel'}
              </SecondaryButton>
            </Row>
          </Group>
        ) : null}
      </div>
    </Modal>
  );
}
