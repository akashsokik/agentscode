// Every row on the Settings page (ACH-D82), as plain data: which section and group it sits in, its
// title and its one-line description. The page draws its rows from here and adds each control;
// "Search settings" matches against the same words, so a row and its search hit never disagree.
import { ENGINE_LABELS, ENGINES } from '../shared/types.ts';
import { APP_SECTIONS, type AppSettingsSection } from './settingsSections.ts';

export interface SettingEntry {
  /** The row's id, also its data-setting-id on the page. */
  id: string;
  section: AppSettingsSection;
  /** The small heading over the row's card. */
  group: string;
  title: string;
  /** One line, muted. The page may show a live one in its place (a version, an update state). */
  description: string;
  /** Other words a search should find it by. */
  keywords?: string;
}

export const SETTINGS_INDEX: readonly SettingEntry[] = [
  { id: 'theme', section: 'appearance', group: 'Look', title: 'Theme', description: 'Dark, light, or follow the system', keywords: 'dark light system mode colours' },
  { id: 'avatars', section: 'appearance', group: 'Look', title: 'Avatars', description: 'Each agent in its own colour, or all in the text colour', keywords: 'ink colour icons' },

  { id: 'awareness', section: 'messaging', group: 'Who can message', title: 'Agents can message', description: 'Replies, and members of a shared channel, always get through', keywords: 'awareness nobody same project all projects communication' },
  { id: 'message-budget', section: 'messaging', group: 'Who can message', title: 'Message budget', description: 'Messages per collaboration, replies included; 0 means no limit', keywords: 'limit hand-offs' },
  { id: 'share-activity', section: 'messaging', group: 'What agents see', title: 'Share current tasks', description: "list_agents shows each agent's task and activity" },
  { id: 'team-snapshot', section: 'messaging', group: 'What agents see', title: 'Start with a team snapshot', description: 'Agents see who is working on what before they begin', keywords: 'context' },
  { id: 'browser-eval', section: 'messaging', group: 'Browser', title: 'Browser scripts', description: 'Agents may run their own JavaScript in their browser tabs', keywords: 'browser_eval javascript' },

  ...ENGINES.map(kind => ({ id: `engine-${kind}`, section: 'engines' as const, group: 'Installed', title: ENGINE_LABELS[kind], description: 'Not found on PATH', keywords: `engine cli ${kind} models` })),
  { id: 'refresh-models', section: 'engines', group: 'Models', title: 'Model lists', description: 'Ask each CLI for the models it offers now', keywords: 'refresh models' },

  { id: 'autonomy', section: 'autonomy', group: 'Level', title: 'Autonomy', description: 'How much it does without asking you; all of it is in Decisions', keywords: 'ask standard full superagent' },
  { id: 'autonomy-actions', section: 'autonomy', group: 'Level', title: 'What it does on its own', description: 'Each step is in Decisions, with Undo where it can be undone', keywords: 'merge restart push release deploy cleanup' },
  { id: 'ask-deleteData', section: 'autonomy', group: 'Ask me first', title: 'Delete files or data', description: 'Unmerged branches, uncommitted work, an agent\'s files, a backup' },
  { id: 'ask-outsideAccounts', section: 'autonomy', group: 'Ask me first', title: 'Change outside accounts', description: 'Railway, Vercel, GitHub settings, anything with billing' },
  { id: 'ask-removeUserAgents', section: 'autonomy', group: 'Ask me first', title: 'Remove agents you made', description: 'Agents it created itself it may remove; yours stay yours' },
  { id: 'ask-forcePush', section: 'autonomy', group: 'Ask me first', title: 'Force-push a feature branch', description: 'One branch you approve, once; never main, the default branch or tags' },
  { id: 'always-safe', section: 'autonomy', group: 'At every level', title: 'What always holds', description: 'The checks that apply whatever the level', keywords: 'safe guard push check' },
  { id: 'pause', section: 'autonomy', group: 'Control', title: 'Pause the SuperAgent', description: 'It starts nothing on its own until you resume', keywords: 'resume stop' },
  { id: 'soul-line', section: 'autonomy', group: 'Control', title: 'Its standing instructions', description: 'The soul.md line to match the level; only you edit it', keywords: 'soul md' },

  { id: 'super-wake', section: 'limits', group: 'Wake-ups', title: 'Wake it when agents finish', description: 'Batched into one turn, sent only while it is idle', keywords: 'superagent fail stuck' },
  { id: 'wakes-per-hour', section: 'limits', group: 'Wake-ups', title: 'Wake-ups an hour', description: 'Past this, updates wait for the next hour' },
  { id: 'super-notify', section: 'limits', group: 'Wake-ups', title: 'Notify me when it asks', description: 'A desktop notification while you are in another app', keywords: 'notifications' },
  { id: 'daily-budget', section: 'limits', group: 'Spending', title: 'Daily budget', description: 'Dollars a day for wake-ups; 0 means no cap', keywords: 'cost money cap' },
  { id: 'creates-per-day', section: 'limits', group: 'Spending', title: 'Agents it may create a day', description: 'A cap on new agents it starts on its own', keywords: 'create agents' },
  { id: 'quiet-hours', section: 'limits', group: 'Quiet hours', title: 'Quiet hours', description: 'No wake-ups or notifications; the same time twice turns them off', keywords: 'night sleep' },

  { id: 'version', section: 'about', group: 'PodCode', title: 'Version', description: 'This build', keywords: 'build release channel' },
  { id: 'updates', section: 'about', group: 'PodCode', title: 'Updates', description: 'Updates are managed by the desktop app', keywords: 'update check install' },
  { id: 'install-command', section: 'about', group: 'PodCode', title: 'Install or update from Terminal', description: 'This build is not signed yet, so it cannot replace itself', keywords: 'terminal command unsigned' },
  { id: 'release-notes', section: 'about', group: 'PodCode', title: 'Release notes', description: 'What changed in this version', keywords: 'changelog github' },
];

/** A section's groups in order, each with its rows. */
export function sectionRows(section: AppSettingsSection): { group: string; rows: SettingEntry[] }[] {
  const rows = SETTINGS_INDEX.filter(e => e.section === section);
  return [...new Set(rows.map(e => e.group))].map(group => ({ group, rows: rows.filter(e => e.group === group) }));
}

/**
 * The rows "Search settings" finds, grouped by section in sidebar order. Every word of the query must
 * appear in the row's title, description, keywords, group, section or section group, in any case.
 */
export function searchSettings(query: string): { section: AppSettingsSection; label: string; rows: SettingEntry[] }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return APP_SECTIONS.map(s => ({
    section: s.id,
    label: s.label,
    rows: SETTINGS_INDEX.filter(e => {
      if (e.section !== s.id) return false;
      const text = `${e.title} ${e.description} ${e.keywords ?? ''} ${e.group} ${s.label} ${s.group}`.toLowerCase();
      return words.every(w => text.includes(w));
    }),
  })).filter(hit => hit.rows.length);
}
