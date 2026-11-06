import { ENGINE_LABELS, type EngineInfo, type EngineKind } from './types.ts';

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

/**
 * Why a new agent cannot use this engine, or null when it can. OrcaCode's file tools only take
 * paths inside the folder it runs in, so an agent with no project could not edit any project.
 */
export function engineProblem(engine: EngineKind, info: EngineInfo | undefined, noProject: boolean): string | null {
  if (!info?.available) return `${ENGINE_LABELS[engine]} is not installed on this machine.`;
  if (engine !== 'orcacode') return null;
  if (info.version && versionBelow(info.version, ORCACODE_MIN_VERSION)) {
    return `OrcaCode ${ORCACODE_MIN_VERSION} or newer is needed (found ${info.version}). Run \`orcacode update\`, then restart AgentsCode.`;
  }
  if (noProject) return 'OrcaCode agents need a project: its file tools only work inside the folder it runs in.';
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
