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
const AGENT_IDS: readonly AgentSettingsSection[] = IDS;

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
 * wrap), Home and End jump, and Cmd or Ctrl with a digit picks that section directly. `ids` is the
 * list the nav shows: the agent dialog's by default, or the app's Settings page's (APP_SECTION_IDS).
 */
export function sectionForKey<T extends string = AgentSettingsSection>(
  current: T,
  key: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean },
  inNav: boolean,
  ids: readonly T[] = AGENT_IDS as readonly string[] as readonly T[],
): T | null {
  if ((key.metaKey || key.ctrlKey) && !key.altKey && !key.shiftKey && /^[1-9]$/.test(key.key)) {
    return ids[Number(key.key) - 1] ?? null;
  }
  if (!inNav || key.metaKey || key.ctrlKey || key.altKey) return null;
  const index = ids.indexOf(current);
  // Left and Right too: in a narrow window the nav is a row.
  if (key.key === 'ArrowDown' || key.key === 'ArrowRight') return ids[(index + 1) % ids.length];
  if (key.key === 'ArrowUp' || key.key === 'ArrowLeft') return ids[(index - 1 + ids.length) % ids.length];
  if (key.key === 'Home') return ids[0];
  if (key.key === 'End') return ids[ids.length - 1];
  return null;
}

/**
 * The app's Settings page sections (ACH-D77, ACH-D82), in the order the sidebar lists them, under
 * their group headers ('' for none). No shortcuts pick them (ACH-D81).
 */
export type AppSettingsSection = 'appearance' | 'messaging' | 'engines' | 'autonomy' | 'limits' | 'about';

export const APP_SECTIONS: { id: AppSettingsSection; label: string; group: string }[] = [
  { id: 'appearance', label: 'Appearance', group: '' },
  { id: 'messaging', label: 'Messaging', group: 'Agents' },
  { id: 'engines', label: 'Engines', group: 'Agents' },
  { id: 'autonomy', label: 'Autonomy', group: 'SuperAgent' },
  { id: 'limits', label: 'Limits', group: 'SuperAgent' },
  { id: 'about', label: 'About', group: 'PodCode' },
];

export const APP_SECTION_IDS: readonly AppSettingsSection[] = APP_SECTIONS.map(s => s.id);

/** The sidebar's groups in order, each with its sections. */
export function sectionGroups(): { group: string; sections: typeof APP_SECTIONS }[] {
  const groups = [...new Set(APP_SECTIONS.map(s => s.group))];
  return groups.map(group => ({ group, sections: APP_SECTIONS.filter(s => s.group === group) }));
}

/**
 * Section ids from before ACH-D82, kept as aliases for deep links and saved layouts: Agent
 * communication is Messaging, and the SuperAgent link (its wake-ups, budgets and quiet hours,
 * openSettingsAt('super')) lands on Limits.
 */
export const SECTION_ALIASES: Readonly<Record<string, AppSettingsSection>> = { comms: 'messaging', super: 'limits' };

export function isAppSection(value: unknown): value is AppSettingsSection {
  return typeof value === 'string' && (APP_SECTION_IDS as readonly string[]).includes(value);
}

/** A section id, or an old one, as today's section; undefined for anything else. */
export function appSection(value: unknown): AppSettingsSection | undefined {
  if (isAppSection(value)) return value;
  return typeof value === 'string' && Object.hasOwn(SECTION_ALIASES, value) ? SECTION_ALIASES[value] : undefined;
}

const STORAGE_KEY = 'podcode:agent-settings-section';

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
