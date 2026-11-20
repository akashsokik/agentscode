/** Saved visibility is per panel type. An opened hidden view is transient, never a preference edit. */
export const PANEL_VIEWS = {
  agent: ['overview', 'comms', 'changes', 'notes', 'work'],
  super: ['overview', 'decisions', 'issues', 'routines', 'comms', 'notes', 'work'],
} as const;
export type PanelType = keyof typeof PANEL_VIEWS;
export type PanelView = (typeof PANEL_VIEWS)[PanelType][number];
export const PANEL_VIEW_LABELS: Record<PanelView, string> = { overview: 'Overview', comms: 'Comms', changes: 'Changes', notes: 'Notes', work: 'Work', decisions: 'Decisions', issues: 'Issues', routines: 'Routines' };
export type PanelTabPreferences = Partial<Record<PanelType, readonly string[]>>;

export function enabledPanelTabs(type: PanelType, saved: unknown): PanelView[] {
  const canonical: readonly PanelView[] = PANEL_VIEWS[type];
  if (!Array.isArray(saved)) return [...canonical];
  const enabled = canonical.filter(view => saved.includes(view));
  return enabled.length ? enabled : [...canonical];
}
export function visiblePanelTabs(type: PanelType, saved: unknown, active: string): PanelView[] {
  const enabled = enabledPanelTabs(type, saved);
  return PANEL_VIEWS[type].filter(view => enabled.includes(view) || view === active);
}
export function togglePanelTab(type: PanelType, saved: unknown, active: string, target: PanelView): PanelView[] {
  const enabled = enabledPanelTabs(type, saved);
  if (target === active || !(PANEL_VIEWS[type] as readonly string[]).includes(target)) return enabled;
  if (enabled.includes(target) && enabled.length === 1) return enabled;
  const next = enabled.includes(target) ? enabled.filter(v => v !== target) : [...enabled, target];
  return PANEL_VIEWS[type].filter(view => next.includes(view));
}
