import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { ALL_PROJECTS } from '../projects.ts';
import { attempt, loadEntries, useApp } from '../store.ts';
import { setSuperLog, useLayout } from '../layout.ts';
import { nextLogState, peekAfter, SUPER_LOG_MIN_PANE, superLogMode } from '../superText.ts';
import { AgentSettingsDialog } from '../dialogs/AgentSettingsDialog.tsx';
import { SoulProposalNotice } from '../dialogs/Dreaming.tsx';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import { AgentStatus } from '../ui/AgentStatus.tsx';
import { Empty, HeaderButton } from '../ui/common.tsx';
import { Bot, PanelRight, Settings } from '../mono/icons.tsx';
import { Composer } from './Composer.tsx';
import { Transcript } from './Transcript.tsx';
import { OpenUIActionContext } from '../openui/context.ts';
import { PaneFrame, type PaneChrome } from './PaneFrame.tsx';
import { SuperInbox, SuperLogSidebar } from './SuperPanel.tsx';

/** One agent's session: transcript, inline approvals and the composer. */
export function AgentPane({ agentId, chrome }: { agentId: string; chrome: PaneChrome }) {
  const agent = useApp(s => s.snapshot?.agents.find(a => a.id === agentId));
  const project = useApp(s => s.snapshot?.projects.find(p => p.id === agent?.projectId));
  const entries = useApp(s => s.entries[agentId]);
  const allApprovals = useApp(s => s.snapshot?.approvals);
  const approvals = useMemo(() => (allApprovals ?? []).filter(a => a.agentId === agentId), [allApprovals, agentId]);
  const question = approvals.find(a => a.type === 'question');
  const [settings, setSettings] = useState(false);
  const logOpen = useLayout().superLog !== false;
  // In a narrow pane the log opens over the conversation, and only when you ask for it.
  const [peek, setPeek] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  // Only whether the pane is wide lives here, so resizing re-renders the pane only when that changes;
  // the sidebar measures the exact width itself.
  const wide = useWide(body, agent?.role === 'super');
  const paneWidth = wide ? SUPER_LOG_MIN_PANE : 0;
  const logMode = agent?.role === 'super' ? superLogMode(logOpen, paneWidth, peek) : 'hidden';
  // Once the pane is wide, a peek is spent: the log does not pop over the conversation when it narrows again.
  useEffect(() => {
    if (peekAfter(paneWidth, peek) !== peek) setPeek(false);
  }, [paneWidth, peek]);
  // A narrow pane only peeks: opening or closing it there never changes your choice for wide panes.
  const toggleLog = () => {
    const next = nextLogState(logMode, paneWidth, logOpen, peek);
    if (next.open !== logOpen) setSuperLog(next.open);
    setPeek(next.peek);
  };
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
          <EngineIcon engine={agent.engine} className="size-3.5" />
          <span className="shrink-0 text-[13px] text-content">{agent.name}</span>
          {/* An agent with no project works across all of them; a project agent's project is in the Overview. */}
          {agent.projectId === null ? <span className="shrink-0 text-[12px] font-normal text-content/45">{ALL_PROJECTS}</span> : null}
          <AgentStatus agent={agent} pending={approvals.length > 0} className="min-w-0 font-normal" />
        </span>
      }
      actions={(
        <>
          {agent.role === 'super' ? (
            <HeaderButton
              icon={PanelRight}
              label="Decision log"
              active={logMode !== 'hidden'}
              aria-expanded={logMode !== 'hidden'}
              aria-controls={`super-log-${agentId}`}
              onClick={toggleLog}
              data-super-log-toggle
            />
          ) : null}
          <HeaderButton icon={Settings} label="Agent settings" onClick={() => setSettings(true)} />
        </>
      )}
    >
      <WithLog
        bodyRef={body}
        log={agent.role === 'super' && logMode !== 'hidden' ? <SuperLogSidebar id={`super-log-${agentId}`} over={logMode === 'over'} focused={chrome.focused} onClose={toggleLog} /> : null}
        super={agent.role === 'super'}
      >
        {/* Buttons in the agent's ```openui-lang blocks answer it as if you had typed their message. */}
        <OpenUIActionContext.Provider value={answer}>
          <Transcript agent={agent} entries={entries} approvals={approvals} />
        </OpenUIActionContext.Provider>
        {/* A soul change a dream proposed waits here until you accept or reject it in the settings. */}
        <SoulProposalNotice agent={agent} onReview={() => setSettings(true)} />
        {/* The SuperAgent's questions wait above its composer until you answer them. */}
        {agent.role === 'super' ? <SuperInbox /> : null}
        <Composer agent={agent} project={project} question={question} onSettings={() => setSettings(true)} />
      </WithLog>
      {settings ? <AgentSettingsDialog agent={agent} onClose={() => setSettings(false)} /> : null}
    </PaneFrame>
  );
}

/**
 * The SuperAgent's pane puts its conversation and decision log side by side; every other agent's
 * pane is the conversation alone, as before.
 */
function WithLog({ super: isSuper, bodyRef, log, children }: { super: boolean; bodyRef: React.RefObject<HTMLDivElement | null>; log: ReactNode; children: ReactNode }) {
  if (!isSuper) return <>{children}</>;
  return (
    <div ref={bodyRef} className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      {log}
    </div>
  );
}

/**
 * Whether an element is at least SUPER_LOG_MIN_PANE wide, measured before the first paint (so the
 * log never shows hidden for a frame and then appears) and kept as a boolean, so a resize re-renders
 * only when it crosses the line.
 */
function useWide(ref: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    setWide(el.getBoundingClientRect().width >= SUPER_LOG_MIN_PANE);
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= SUPER_LOG_MIN_PANE));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return wide;
}
