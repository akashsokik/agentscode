import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineKind, EngineModels, ModelOption, ModelProvider, ServiceTier } from '../shared/types.ts';
import { orcacodeModelValue } from '../shared/engines.ts';

// Ask each CLI which models it offers. Neither call sends a prompt, so neither costs tokens.

const CLAUDE_FALLBACK: ModelOption[] = [
  { value: 'opus', label: 'Opus', description: 'Latest Opus', efforts: [] },
  { value: 'sonnet', label: 'Sonnet', description: 'Latest Sonnet', efforts: [] },
  { value: 'haiku', label: 'Haiku', description: 'Latest Haiku', efforts: [] },
  { value: 'fable', label: 'Fable', description: 'Latest Fable', efforts: [] },
];

/** Claude Code's fast mode, offered as a service tier on the models that support it. */
export const CLAUDE_FAST: ServiceTier = { id: 'fast', name: 'Fast', description: 'Faster output at a higher price' };

export function emptyModels(kind: EngineKind): EngineModels {
  return {
    defaultLabel: 'CLI default',
    defaultEffort: null,
    models: kind === 'claude' ? CLAUDE_FALLBACK : [],
    efforts: [],
    discovered: false,
  };
}

function unionEfforts(models: ModelOption[]): string[] {
  const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const rank = (effort: string) => (order.includes(effort) ? order.indexOf(effort) : order.length);
  return [...new Set(models.flatMap((m) => m.efforts))].sort((a, b) => rank(a) - rank(b));
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function discoverClaudeModels(binPath: string | null): Promise<EngineModels> {
  // A prompt stream that never yields: the CLI starts and answers control requests, but no turn runs.
  const idle: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  const q = query({
    prompt: idle,
    options: {
      cwd: os.homedir(),
      pathToClaudeCodeExecutable: binPath ?? undefined,
      settingSources: [], // no hooks or plugins needed just to list models
      strictMcpConfig: true,
      permissionMode: 'default',
    },
  });
  try {
    const list = await withTimeout(q.supportedModels(), 45_000);
    const defaultRow = list.find((m) => m.value === 'default');
    const models: ModelOption[] = list
      .filter((m) => m.value !== 'default')
      .map((m) => ({
        value: m.value,
        label: m.displayName,
        description: m.description,
        efforts: m.supportedEffortLevels ?? [],
        ...(m.supportsFastMode ? { serviceTiers: [CLAUDE_FAST] } : {}),
      }));
    // A model pinned in ~/.claude/settings.json overrides the account default.
    const settings = readJson(path.join(os.homedir(), '.claude', 'settings.json'));
    const pinned = typeof settings?.model === 'string' ? settings.model : null;
    const pinnedRow = pinned ? models.find((m) => m.value === pinned) : undefined;
    const accountDefault = defaultRow?.description.split(/\s+\S\s+/)[0] || defaultRow?.resolvedModel || 'account default';
    const effortSetting = typeof settings?.effortLevel === 'string' ? settings.effortLevel : null;
    return {
      defaultLabel: pinned ? (pinnedRow?.label ?? pinned) : accountDefault,
      defaultEffort: effortSetting,
      models,
      efforts: unionEfforts(models),
      discovered: true,
    };
  } finally {
    q.close();
  }
}

export interface CodexModel {
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  supported_reasoning_levels?: { effort?: string }[];
  service_tiers?: { id?: string; name?: string; description?: string }[];
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

function codexCatalog(binPath: string): Promise<CodexModel[]> {
  return new Promise((resolve) => {
    execFile(binPath, ['debug', 'models'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const parse = (text: string) => {
        const data = JSON.parse(text);
        return (Array.isArray(data) ? data : data.models) as CodexModel[];
      };
      try {
        if (!err) return resolve(parse(stdout));
      } catch {
        // fall through to the cache
      }
      try {
        resolve(parse(fs.readFileSync(path.join(codexHome(), 'models_cache.json'), 'utf8')));
      } catch {
        resolve([]);
      }
    });
  });
}

/** Top-level `key = "value"` from config.toml (before the first [table]). */
function codexConfigValue(key: string): string | null {
  try {
    const text = fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8').split(/^\s*\[/m)[0];
    return text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The tiers a Codex model offers beyond Standard, from its catalog entry (`priority` is Fast). */
export function codexTiers(model: CodexModel): { serviceTiers?: ServiceTier[] } {
  const tiers = (model.service_tiers ?? []).flatMap((t) => (t.id && t.id !== 'default' ? [{ id: t.id, name: t.name || t.id, ...(t.description ? { description: t.description } : {}) }] : []));
  return tiers.length ? { serviceTiers: tiers } : {};
}

export async function discoverCodexModels(binPath: string | null): Promise<EngineModels> {
  if (!binPath) return emptyModels('codex');
  const catalog = await codexCatalog(binPath);
  const models: ModelOption[] = catalog
    .filter((m) => m.slug && m.visibility !== 'hide')
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((m) => ({
      value: m.slug!,
      label: m.display_name ?? m.slug!,
      description: m.description ?? '',
      efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort ?? '').filter(Boolean),
      ...codexTiers(m),
    }));
  const configured = codexConfigValue('model');
  return {
    defaultLabel: configured ? (models.find((m) => m.value === configured)?.label ?? configured) : 'Codex default',
    defaultEffort: codexConfigValue('model_reasoning_effort'),
    models,
    efforts: unionEfforts(models),
    discovered: models.length > 0,
  };
}

/** OrcaCode's config folder, where it keeps the provider and the last model per provider. */
function orcacodeConfigDir(): string {
  if (process.env.ORCA_CONFIG_DIR?.trim()) return process.env.ORCA_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME?.trim()) return path.join(process.env.XDG_CONFIG_HOME, 'orcacode');
  return path.join(os.homedir(), '.config', 'orcacode');
}

/** Context windows from the last catalogs, by picker value (`provider::id`, or a bare id from 0.10). */
const orcacodeWindows = new Map<string, number>();

export function orcacodeContextWindow(model: string, provider?: string | null): number | undefined {
  return (provider ? orcacodeWindows.get(orcacodeModelValue(provider, model)) : undefined) ?? orcacodeWindows.get(model);
}

/** `gpt-6-sol  272k ctx` lines from `orcacode --list-models`; the size is optional. */
export function parseOrcacodeModels(text: string): { id: string; window?: number }[] {
  return text.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)([km])?\s+ctx)?\s*$/i);
    if (!match) return [];
    const size = match[2] ? Number(match[2]) * (match[3]?.toLowerCase() === 'm' ? 1_000_000 : match[3] ? 1000 : 1) : undefined;
    return [{ id: match[1], window: size }];
  });
}

// OrcaCode passes --effort to the provider; a model that does not list its levels gets these.
const ORCACODE_EFFORTS = ['low', 'medium', 'high'];

function runWithError(binPath: string, args: string[]): Promise<{ stdout: string | null; stderr: string }> {
  return new Promise((resolve) => {
    execFile(binPath, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ stdout: err ? null : stdout, stderr: String(stderr ?? '') }));
  });
}

async function run(binPath: string, args: string[]): Promise<string | null> {
  return (await runWithError(binPath, args)).stdout;
}

/** A few words on why a provider's model list failed; never the error text itself, which can quote a key. */
export function listingProblem(stderr: string): string {
  if (/\b401\b|\b403\b|unauthori[sz]ed|authentication|api key|x-api-key/i.test(stderr)) return 'key rejected';
  if (/connection refused|connect error|dns|timed out|timeout/i.test(stderr)) return 'not reachable';
  return 'could not list models';
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

interface OrcaProviderRow { label?: unknown; name?: unknown; configured?: unknown; model?: unknown }
interface OrcaModelRow { id?: unknown; name?: unknown; contextWindow?: unknown; efforts?: unknown }

/** `--list-providers --json` (orcacode 0.11+), or null when this orcacode cannot say. */
export function parseOrcacodeProviders(text: string | null): { active: string | null; providers: (ModelProvider & { model: string | null })[] } | null {
  const data = parseJson(text);
  if (!data || !Array.isArray(data.providers)) return null;
  const providers = (data.providers as OrcaProviderRow[]).flatMap((row) => {
    if (typeof row.label !== 'string' || !row.label) return [];
    return [{
      id: row.label,
      name: typeof row.name === 'string' && row.name ? row.name : row.label,
      configured: row.configured === true,
      model: typeof row.model === 'string' && row.model ? row.model : null,
    }];
  });
  return { active: typeof data.active === 'string' ? data.active : null, providers };
}

/** One provider's `--list-models --json`, as picker options under that provider. */
export function parseOrcacodeModelList(text: string | null, provider: ModelProvider): { options: ModelOption[]; windows: [string, number][] } | null {
  const data = parseJson(text);
  if (!data || !Array.isArray(data.models)) return null;
  const options: ModelOption[] = [];
  const windows: [string, number][] = [];
  for (const row of data.models as OrcaModelRow[]) {
    if (typeof row.id !== 'string' || !row.id) continue;
    const value = orcacodeModelValue(provider.id, row.id);
    const window = typeof row.contextWindow === 'number' && row.contextWindow > 0 ? row.contextWindow : undefined;
    if (window) windows.push([value, window]);
    const efforts = Array.isArray(row.efforts) ? row.efforts.filter((e): e is string => typeof e === 'string') : ORCACODE_EFFORTS;
    options.push({
      value,
      label: typeof row.name === 'string' && row.name ? row.name : row.id,
      description: [row.id !== row.name && typeof row.name === 'string' && row.name ? row.id : '', window ? `${Math.round(window / 1000)}k context` : ''].filter(Boolean).join(' · '),
      efforts,
      group: provider.name,
    });
  }
  return { options, windows };
}

export async function discoverOrcacodeModels(binPath: string | null): Promise<EngineModels> {
  if (!binPath) return emptyModels('orcacode');
  // orcacode 0.11+: every provider, and each set-up one's catalog. None of this sends a prompt.
  const listed = parseOrcacodeProviders(await run(binPath, ['--list-providers', '--json']));
  if (listed) {
    const catalogs = await Promise.all(listed.providers.filter(p => p.configured).map(async (provider) => {
      const { stdout, stderr } = await runWithError(binPath, ['--provider', provider.id, '--list-models', '--json']);
      const catalog = parseOrcacodeModelList(stdout, provider);
      return { provider, catalog, problem: catalog ? undefined : listingProblem(stderr) };
    }));
    const problems = new Map(catalogs.flatMap(c => (c.problem ? [[c.provider.id, c.problem] as const] : [])));
    const models: ModelOption[] = [];
    for (const { catalog } of catalogs) {
      if (!catalog) continue;
      models.push(...catalog.options);
      for (const [value, window] of catalog.windows) orcacodeWindows.set(value, window);
    }
    const active = listed.providers.find(p => p.id === listed.active);
    return {
      defaultLabel: active ? `${active.name}${active.model ? ` · ${active.model}` : ''}` : 'OrcaCode default',
      defaultEffort: null,
      models,
      efforts: models.length ? unionEfforts(models) : [],
      discovered: models.length > 0,
      providers: listed.providers.map(({ id, name, configured }) => ({ id, name, configured, ...(problems.has(id) ? { problem: problems.get(id) } : {}) })),
    };
  }
  // orcacode 0.10: the saved provider's catalog only, as `id  272k ctx` lines.
  const catalog = parseOrcacodeModels((await run(binPath, ['--list-models'])) ?? '');
  for (const entry of catalog) if (entry.window) orcacodeWindows.set(entry.id, entry.window);
  const models: ModelOption[] = catalog.map((m) => ({
    value: m.id,
    label: m.id,
    description: m.window ? `${Math.round(m.window / 1000)}k context` : '',
    efforts: ORCACODE_EFFORTS,
  }));
  const config = readJson(path.join(orcacodeConfigDir(), 'config.json'));
  const provider = typeof config?.provider === 'string' ? config.provider : null;
  const saved = provider && config?.models && typeof config.models === 'object' ? (config.models as Record<string, unknown>)[provider] : null;
  return {
    defaultLabel: typeof saved === 'string' ? saved : 'OrcaCode default',
    defaultEffort: null,
    models,
    efforts: models.length ? ORCACODE_EFFORTS : [],
    discovered: models.length > 0,
  };
}
