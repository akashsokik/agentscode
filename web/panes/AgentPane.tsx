import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { ALL_PROJECTS } from '../projects.ts';
import { attempt, loadEntries, useApp } from '../store.ts';
import { AgentSettingsDialog } from '../dialogs/AgentSettingsDialog.tsx';
import { SoulProposalNotice } from '../dialogs/Dreaming.tsx';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import { AgentStatus } from '../ui/AgentStatus.tsx';
import { Empty, HeaderButton } from '../ui/common.tsx';
import { Bot, Settings } from '../mono/icons.tsx';
import { Composer } from './Composer.tsx';
import { Transcript } from './Transcript.tsx';
import { PaneFrame, type PaneChrome } from './PaneFrame.tsx';

/** One agent's session: transcript, inline approvals and the composer. */
export function AgentPane({ agentId, chrome }: { agentId: string; chrome: PaneChrome }) {
  const agent = useApp(s => s.snapshot?.agents.find(a => a.id === agentId));
  const project = useApp(s => s.snapshot?.projects.find(p => p.id === agent?.projectId));
  const entries = useApp(s => s.entries[agentId]);
  const allApprovals = useApp(s => s.snapshot?.approvals);
  const approvals = useMemo(() => (allApprovals ?? []).filter(a => a.agentId === agentId), [allApprovals, agentId]);
  const question = approvals.find(a => a.type === 'question');
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    void loadEntries(agentId);
  }, [agentId]);

  // Opening the session marks its news as read.
  useEffect(() => {
    if (agent?.unread && chrome.focused) void attempt(() => api.seen(agentId));
  }, [agent?.unread, chrome.focused, agentId]);

  if (!agent) {
    return <PaneFrame chrome={chrome} title="Agent removed"><Empty icon={Bot} title="This agent was removed." /></PaneFrame>;
  }

  // MonoCode's header: the name and how it is doing; what it is on lives in the Overview.
  return (
    <PaneFrame
      chrome={chrome}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <EngineIcon engine={agent.engine} className="size-3.5" />
          <span className="shrink-0 text-[13px] text-content">{agent.name}</span>
          {/* An agent with no project works across all of them; a project agent's project is in the Overview. */}
          {agent.projectId === null ? <span className="shrink-0 text-[12px] font-normal text-content/45">{ALL_PROJECTS}</span> : null}
          <AgentStatus agent={agent} pending={approvals.length > 0} className="min-w-0 font-normal" />
        </span>
      }
      actions={<HeaderButton icon={Settings} label="Agent settings" onClick={() => setSettings(true)} />}
    >
      <Transcript agent={agent} entries={entries} approvals={approvals} />
      {/* A soul change a dream proposed waits here until you accept or reject it in the settings. */}
      <SoulProposalNotice agent={agent} onReview={() => setSettings(true)} />
      <Composer agent={agent} project={project} question={question} onSettings={() => setSettings(true)} />
      {settings ? <AgentSettingsDialog agent={agent} onClose={() => setSettings(false)} /> : null}
    </PaneFrame>
  );
}
