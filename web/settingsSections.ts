// The agent settings dialog's sections: which one opens, which one a key moves to, and remembering
// the last one per agent. Pure apart from the storage helpers, so it is tested directly.

/** The dialog's sections, one shown at a time so a long memory or dream log never buries the rest. */
export type AgentSettingsSection = 'general' | 'soul' | 'memory' | 'dreaming';

export const SECTIONS: { id: AgentSettingsSection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'soul', label: 'Soul' },
  { id: 'memory', label: 'Memory' },
  { id: 'dreaming', label: 'Dreaming' },
];

const IDS = SECTIONS.map(s => s.id);

export function isSection(value: unknown): value is AgentSettingsSection {
  return typeof value === 'string' && (IDS as string[]).includes(value);
}

/**
 * The section the dialog opens on: the one asked for (a deep link, such as the soul-change notice
 * opening Soul), else the one you were last on for this agent, else General.
 */
export function openingSection(requested: AgentSettingsSection | undefined, remembered: unknown): AgentSettingsSection {
  if (requested) return requested;
  return isSection(remembered) ? remembered : 'general';
}

/**
 * Where a key takes the section nav, or null when the key is not the nav's: arrows step (and
 * wrap), Home and End jump, and Cmd or Ctrl with 1 to 4 picks a section directly.
 */
export function sectionForKey(
  current: AgentSettingsSection,
  key: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean },
  inNav: boolean,
): AgentSettingsSection | null {
  if ((key.metaKey || key.ctrlKey) && !key.altKey && !key.shiftKey && /^[1-9]$/.test(key.key)) {
    return IDS[Number(key.key) - 1] ?? null;
  }
  if (!inNav || key.metaKey || key.ctrlKey || key.altKey) return null;
  const index = IDS.indexOf(current);
  // Left and Right too: in a narrow window the nav is a row.
  if (key.key === 'ArrowDown' || key.key === 'ArrowRight') return IDS[(index + 1) % IDS.length];
  if (key.key === 'ArrowUp' || key.key === 'ArrowLeft') return IDS[(index - 1 + IDS.length) % IDS.length];
  if (key.key === 'Home') return IDS[0];
  if (key.key === 'End') return IDS[IDS.length - 1];
  return null;
}

const STORAGE_KEY = 'agentscode:agent-settings-section';

function readAll(storage: Pick<Storage, 'getItem'> | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** The section last open for this agent, as stored (check it with isSection). */
export function rememberedSection(agentId: string, storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): unknown {
  return readAll(storage)[agentId];
}

export function rememberSection(agentId: string, section: AgentSettingsSection, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(storage), [agentId]: section }));
  } catch { /* storage full or blocked: forgetting is fine */ }
}
