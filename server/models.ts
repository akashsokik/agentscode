import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineKind, EngineModels, ModelOption } from '../shared/types.ts';

// Ask each CLI which models it offers. Neither call sends a prompt, so neither costs tokens.

const CLAUDE_FALLBACK: ModelOption[] = [
  { value: 'opus', label: 'Opus', description: 'Latest Opus', efforts: [] },
  { value: 'sonnet', label: 'Sonnet', description: 'Latest Sonnet', efforts: [] },
  { value: 'haiku', label: 'Haiku', description: 'Latest Haiku', efforts: [] },
  { value: 'fable', label: 'Fable', description: 'Latest Fable', efforts: [] },
];

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
      .map((m) => ({ value: m.value, label: m.displayName, description: m.description, efforts: m.supportedEffortLevels ?? [] }));
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

interface CodexModel {
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  supported_reasoning_levels?: { effort?: string }[];
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
