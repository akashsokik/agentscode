import { ENGINE_LABELS, type Agent, type EngineInfo, type EngineKind, type EngineModels, type ModelOption, type ServiceTier } from './types.ts';

/** The first OrcaCode with the headless contract the runner uses (--prompt-file, --mcp-config, sessionId, stdio approvals). */
export const ORCACODE_MIN_VERSION = '0.10.0';

/** True when dotted version `a` is older than `b`; an unreadable version is not treated as older. */
export function versionBelow(a: string, b: string): boolean {
  const parse = (v: string) => v.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** Why an OrcaCode without --add-dir cannot work on all projects or several, and what fixes it. */
export const ORCACODE_NO_ADD_DIR = 'This OrcaCode cannot work in more than one project: its file tools only reach the folder it runs in. Give the agent one project, or once an OrcaCode with --add-dir is out, run `orcacode update` and restart AgentsCode.';

/**
 * Why a new agent cannot use this engine, or null when it can. OrcaCode's file tools only take
 * paths inside the folder it runs in, so an agent on every project, or on several, needs an
 * OrcaCode that takes --add-dir (one per other folder). `beyondOneFolder` says it is such an agent.
 */
export function engineProblem(engine: EngineKind, info: EngineInfo | undefined, beyondOneFolder: boolean): string | null {
  if (!info?.available) return `${ENGINE_LABELS[engine]} is not installed on this machine.`;
  if (engine !== 'orcacode') return null;
  if (info.version && versionBelow(info.version, ORCACODE_MIN_VERSION)) {
    return `OrcaCode ${ORCACODE_MIN_VERSION} or newer is needed (found ${info.version}). Run \`orcacode update\`, then restart AgentsCode.`;
  }
  if (beyondOneFolder && !info.addDir) return ORCACODE_NO_ADD_DIR;
  return null;
}

/**
 * An OrcaCode agent's model is stored as `<provider>::<model>` so one string picks both; a bare id
 * (or an empty one) leaves the provider to OrcaCode's saved choice. Model ids may contain `/` and `:`.
 */
export const ORCACODE_MODEL_SEP = '::';

export function orcacodeModelValue(provider: string, model: string): string {
  return `${provider}${ORCACODE_MODEL_SEP}${model}`;
}

export function splitOrcacodeModel(value: string): { provider: string | null; model: string } {
  const at = value.indexOf(ORCACODE_MODEL_SEP);
  if (at <= 0) return { provider: null, model: value };
  return { provider: value.slice(0, at), model: value.slice(at + ORCACODE_MODEL_SEP.length) };
}

/**
 * The model an agent runs: its own pick, or for Default the listed model the CLI default names
 * (by label), when there is one.
 */
export function currentModel(agent: Pick<Agent, 'model'>, models: EngineModels | undefined): ModelOption | undefined {
  const listed = models?.models ?? [];
  if (agent.model) return listed.find(m => m.value === agent.model);
  return listed.find(m => m.label === models?.defaultLabel || m.value === models?.defaultLabel);
}

/** The service tiers the agent's model offers beyond Standard; none when the model is unknown. */
export function serviceTiers(agent: Pick<Agent, 'model'>, models: EngineModels | undefined): ServiceTier[] {
  return currentModel(agent, models)?.serviceTiers ?? [];
}
