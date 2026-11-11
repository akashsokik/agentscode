import { useEffect, useMemo, useState } from 'react';
import { ENGINES, type AgentRole, type Autonomy, type EngineKind } from '../../shared/types.ts';
import { ROLES, rolePreset } from '../../shared/roles.ts';
import { engineProblem } from '../../shared/engines.ts';
import { api } from '../api.ts';
import { AUTONOMY, effortLabel, notSetUp } from '../format.ts';
import { open } from '../layout.ts';
import { SOUL_MAX } from '../memory.ts';
import { attempt, useApp } from '../store.ts';
import { EngineIcon, ENGINE_NAMES as ENGINE_LABEL } from '../ui/EngineIcon.tsx';
import { AGENT_NAMES } from '../quick/route.ts';
import { INPUT, PRIMARY, TEXTAREA } from '../ui/common.tsx';
import { Modal } from '../mono/Modal.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Group, Row, Select, Toggle } from '../mono/settings.tsx';
import { submitKey } from './submitKey.ts';
import { AvatarGlyph } from '../ui/Avatar.tsx';
import { agentLook, freshLook, type AvatarLook } from '../../shared/avatar.ts';
import { beyondOneFolder, choiceValue, initialChoice, type ProjectsChoice } from '../projectPicker.ts';
import { ProjectsPicker } from './ProjectsPicker.tsx';

const NAMES = AGENT_NAMES;

/** `projectId` null opens with No project chosen; undefined starts from the first project. */
export function NewAgentDialog({ projectId, onClose, onAddProject }: { projectId?: string | null; onClose: () => void; onAddProject: () => void }) {
  const snapshot = useApp(s => s.snapshot);
  const projects = snapshot?.projects ?? [];
  const engines = snapshot?.engines;
  const taken = useMemo(() => new Set((snapshot?.agents ?? []).map(a => a.name.toLowerCase())), [snapshot?.agents]);
  const [name, setName] = useState(() => NAMES.find(n => !taken.has(n.toLowerCase())) ?? '');
  const [engine, setEngine] = useState<EngineKind>(() => ENGINES.find(kind => engines?.[kind].available) ?? 'claude');
  // The look it will have: a free one, which Shuffle rerolls; Agent Settings changes it later.
  const allAgents = useApp(s => s.snapshot?.agents);
  const takenLooks = useMemo(() => (allAgents ?? []).map(a => agentLook(a)), [allAgents]);
  const [look, setLook] = useState<AvatarLook>(() => freshLook(takenLooks));
  // All projects, or the chosen ones with the start folder first (ACH-D15).
  const [choice, setChoice] = useState<ProjectsChoice>(() => initialChoice(projectId, projects[0]?.id));
  const [role, setRole] = useState<AgentRole>('dev');
  const [instructions, setInstructions] = useState(rolePreset('dev').instructions);
  const [autonomy, setAutonomy] = useState<Autonomy>(rolePreset('dev').autonomy);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [worktree, setWorktree] = useState(false);
  const [branch, setBranch] = useState('');
  const [useMcp, setUseMcp] = useState(false);
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);

  const models = snapshot?.models[engine];
  const projectIds = choiceValue(choice);
  const noProject = projectIds === null;
  // The start folder: the worktree, if any, is a branch of it; the others are used in place.
  const selectedProject = projects.find(p => p.id === projectIds?.[0]);
  const others = (projectIds ?? []).slice(1).flatMap(id => projects.filter(p => p.id === id));
  const efforts = (model ? models?.models.find(m => m.value === model)?.efforts : undefined) ?? models?.efforts ?? [];
  const problem = engineProblem(engine, engines?.[engine], beyondOneFolder(choice));
  const engineReady = !problem;

  useEffect(() => { setModel(''); setEffort(''); }, [engine]);
  useEffect(() => { if (!selectedProject?.isGit) setWorktree(false); }, [selectedProject?.isGit]);

  const pickRole = (next: string) => {
    const preset = rolePreset(next as AgentRole);
    setRole(preset.id);
    setInstructions(preset.instructions);
    setAutonomy(preset.autonomy);
  };

  const create = async () => {
    setBusy(true);
    const agent = await attempt(() => api.createAgent({
      // null is All projects; Create is disabled while Choose has nothing picked (undefined).
      name: name.trim(), engine, projectIds: projectIds === undefined ? [] : projectIds, role, instructions, autonomy, model, effort, avatar: look,
      worktree: !noProject && worktree, branch: (!noProject && worktree && branch.trim()) || undefined, useMcp: engine === 'claude' && useMcp, task: task.trim() || undefined,
    }));
    setBusy(false);
    if (agent) {
      open({ kind: 'agent', agentId: agent.id });
      onClose();
    }
  };

  const onSubmitKey = submitKey(!busy && Boolean(name.trim()) && projectIds !== undefined && engineReady, () => void create());

  return (
    <Modal
      title="New agent"
      description="A Claude Code, Codex or OrcaCode session that can message its teammates."
      size="md"
      fitViewport
      onClose={onClose}
      footer={
        <>
          {problem ? <span className="mr-auto font-sans text-[12px] text-warning">{problem}</span> : null}
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button type="button" className={PRIMARY} disabled={busy || !name.trim() || projectIds === undefined || !engineReady} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create agent'}
          </button>
        </>
      }
    >
      <div className="px-4 pb-5 pt-4">
        <Group title="Agent">
          <Row label="Name" description="Teammates address each other by name.">
            <span className="flex items-center gap-2">
              <AvatarGlyph look={look} seed="new-agent" className="size-7" />
              <input autoFocus value={name} maxLength={24} onChange={e => setName(e.target.value)} onKeyDown={onSubmitKey} className={`${INPUT} w-44`} />
            </span>
          </Row>
          <Row label="Avatar" description="A look no other agent has. Change it any time in its settings.">
            <SecondaryButton onClick={() => setLook(freshLook(takenLooks))}>Shuffle</SecondaryButton>
          </Row>
          <div className="border-b border-content/5 px-4 py-3.5">
            <ProjectsPicker
              choice={choice}
              onChange={setChoice}
              projects={projects}
              agents={allAgents ?? []}
              engine={engine}
              onAddProject={() => { onClose(); onAddProject(); }}
            />
          </div>
          <Row label="Engine" description={engines?.[engine].available ? `${engines[engine].path} (v${engines[engine].version})` : 'Not installed on this machine.'}>
            <Select label="Engine" value={engine} onChange={value => setEngine(value as EngineKind)} options={ENGINES.map(kind => ({ value: kind, icon: <EngineIcon engine={kind} className="size-4" />, label: engines?.[kind].available ? ENGINE_LABEL[kind] : `${ENGINE_LABEL[kind]} (not installed)` }))} />
          </Row>
          <Row label="Role" description={role === 'lead' ? 'Leads can delegate tasks and track reports.' : undefined}>
            <Select label="Role" value={role} options={ROLES.map(r => ({ value: r.id, label: r.name }))} onChange={pickRole} />
          </Row>
        </Group>

        <Group title="Model and access">
          <Row label="Model" description={notSetUp(models)}>
            <Select
              label="Model"
              value={model}
              searchable={(models?.models.length ?? 0) > 12}
              options={[{ value: '', label: `Default${models?.discovered ? ` (${models.defaultLabel})` : ''}` }, ...(models?.models ?? []).map(m => ({ value: m.value, label: m.label, group: m.group }))]}
              onChange={setModel}
            />
          </Row>
          {efforts.length ? (
            <Row label="Reasoning effort">
              <Select
                label="Reasoning effort"
                value={effort}
                options={[{ value: '', label: `Default${models?.defaultEffort ? ` (${models.defaultEffort})` : ''}` }, ...efforts.map(value => ({ value, label: effortLabel(value, null) }))]}
                onChange={setEffort}
              />
            </Row>
          ) : null}
          <Row label="Access" description={AUTONOMY.find(a => a.value === autonomy)?.hint}>
            <Select label="Access" value={autonomy} options={AUTONOMY.map(a => ({ value: a.value, label: a.label }))} onChange={value => setAutonomy(value as Autonomy)} />
          </Row>
        </Group>

        {noProject && engine !== 'claude' ? null : <Group title="Workspace">
          {noProject ? null : <Row label="Own git worktree" description={!selectedProject?.isGit ? 'Available when the start folder is inside a git repository.' : others.length
            ? `A new branch in its own folder for ${selectedProject.name}, the start folder. ${others.map(p => p.name).join(' and ')} ${others.length === 1 ? 'is' : 'are'} used as ${others.length === 1 ? 'it is' : 'they are'}, in place: changes there land in your own ${others.length === 1 ? 'copy' : 'copies'}.`
            : 'A new branch in its own folder, so it never collides with you or other agents.'}>
            <Toggle label="Own git worktree" on={worktree} disabled={!selectedProject?.isGit} onChange={setWorktree} />
          </Row>}
          {worktree && !noProject ? (
            <Row label="Branch" description="Leave empty for a generated name.">
              <input value={branch} onChange={e => setBranch(e.target.value)} onKeyDown={onSubmitKey} placeholder={`agent/${name.trim().toLowerCase() || 'name'}-xxxx`} className={`${INPUT} w-52`} />
            </Row>
          ) : null}
          {engine === 'claude' ? (
            <Row label="Load my MCP servers" description="Off by default: they can add many tokens to every session. Team comms tools are always on.">
              <Toggle label="Load my MCP servers" on={useMcp} onChange={setUseMcp} />
            </Row>
          ) : null}
        </Group>}

        <Group title="Soul" description="Who this agent is and how it works. Saved as soul.md in its own folder; only you edit it.">
          <div className="p-3"><textarea value={instructions} maxLength={SOUL_MAX} onChange={e => setInstructions(e.target.value)} onKeyDown={onSubmitKey} rows={4} className={TEXTAREA} placeholder="Anything this agent should always keep in mind" /></div>
        </Group>

        <Group title="First task" description="Optional. The agent starts on it right away.">
          <div className="p-3"><textarea value={task} onChange={e => setTask(e.target.value)} onKeyDown={onSubmitKey} rows={3} className={TEXTAREA} placeholder="What should it work on?" /></div>
        </Group>
      </div>
    </Modal>
  );
}
