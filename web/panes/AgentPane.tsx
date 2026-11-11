import { useEffect, useMemo, useState } from 'react';
import { startProjectId } from '../../shared/agentProjects.ts';
import { AgentProjects } from './AgentProjects.tsx';
import { api } from '../api.ts';
import { ALL_PROJECTS } from '../projects.ts';
import { attempt, loadEntries, useApp } from '../store.ts';
import { AgentSettingsDialog, type AgentSettingsSection } from '../dialogs/AgentSettingsDialog.tsx';
import { SoulProposalNotice } from '../dialogs/Dreaming.tsx';
import { AgentStatus } from '../ui/AgentStatus.tsx';
import { Empty, HeaderButton } from '../ui/common.tsx';
import { Bot, Settings } from '../mono/icons.tsx';
import { Composer } from './Composer.tsx';
import { Transcript } from './Transcript.tsx';
import { OpenUIActionContext } from '../openui/context.ts';
import { PaneFrame, type PaneChrome } from './PaneFrame.tsx';
import { SuperInbox } from './SuperPanel.tsx';
import { AgentAvatar } from '../ui/Avatar.tsx';

/** One agent's session: transcript, inline approvals and the composer. */
export function AgentPane({ agentId, chrome }: { agentId: string; chrome: PaneChrome }) {
  const agent = useApp(s => s.snapshot?.agents.find(a => a.id === agentId));
  const project = useApp(s => s.snapshot?.projects.find(p => p.id === (agent ? startProjectId(agent) : undefined)));
  const entries = useApp(s => s.entries[agentId]);
  const allApprovals = useApp(s => s.snapshot?.approvals);
  const approvals = useMemo(() => (allApprovals ?? []).filter(a => a.agentId === agentId), [allApprovals, agentId]);
  const question = approvals.find(a => a.type === 'question');
  // Open, and on which section: undefined opens the one you had last for this agent.
  const [settings, setSettings] = useState<{ section?: AgentSettingsSection } | null>(null);
  const answer = useMemo(() => (text: string) => void attempt(() => api.send(agentId, text)), [agentId]);

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
          <AgentAvatar agent={agent} className="size-3.5" />
          <span className="shrink-0 text-[13px] text-content">{agent.name}</span>
          {/* An agent with no project works across all of them; one on several shows "first + N", hover for
              the list; a one-project agent's project is in the Overview. */}
          {agent.projectIds === null ? <span className="shrink-0 text-[12px] font-normal text-content/45">{ALL_PROJECTS}</span>
            : agent.projectIds.length === 0 ? (
              <button type="button" onClick={() => setSettings({ section: 'general' })} title="Its project choice could not be read, so it has none. Pick its projects in its settings." className="shrink-0 rounded-[5px] bg-content/7 px-1.5 text-[12px] font-normal text-content/70 hover:bg-content/12">No projects: pick some</button>
            ) : <AgentProjects agent={agent} />}
          <AgentStatus agent={agent} pending={approvals.length > 0} className="min-w-0 font-normal" />
        </span>
      }
      actions={<HeaderButton icon={Settings} label="Agent settings" onClick={() => setSettings({})} />}
    >
      {/* Buttons in the agent's ```openui-lang blocks answer it as if you had typed their message. */}
      <OpenUIActionContext.Provider value={answer}>
        <Transcript agent={agent} entries={entries} approvals={approvals} />
      </OpenUIActionContext.Provider>
      {/* A soul change a dream proposed waits here until you accept or reject it in the settings. */}
      <SoulProposalNotice agent={agent} onReview={() => setSettings({ section: 'soul' })} />
      {/* The SuperAgent's questions wait above its composer until you answer them. */}
      {agent.role === 'super' ? <SuperInbox /> : null}
      <Composer agent={agent} project={project} question={question} onSettings={() => setSettings({})} />
      {settings ? <AgentSettingsDialog agent={agent} section={settings.section} onClose={() => setSettings(null)} /> : null}
    </PaneFrame>
  );
}
