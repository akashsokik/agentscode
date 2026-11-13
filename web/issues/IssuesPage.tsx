import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { isOpenIssue } from '../../shared/issues.ts';
import type { SuperIssue } from '../../shared/types.ts';
import { api } from '../api.ts';
import { CircleDashed, ListFilter, Search as SearchIcon, SlidersHorizontal } from '../mono/icons.tsx';
import type { PopoverAnchor } from '../mono/Popover.tsx';
import { PaneFrame, type PaneChrome } from '../panes/PaneFrame.tsx';
import { Composer } from '../panes/SuperPanel.tsx';
import { attempt, useApp } from '../store.ts';
import { ChipButton, Empty, HeaderButton } from '../ui/common.tsx';
import { Kbd } from '../ui/Kbd.tsx';
import { DetailButton, focusAdd, PanelEmpty, PanelList, PanelSection, PanelToolbar } from '../ui/PanelList.tsx';
import { useNow } from '../ui/useNow.ts';
import { DisplayMenu, FilterChips, FilterMenu } from './IssueFilters.tsx';
import { IssueRow, restoreFocus } from './issueParts.tsx';
import { isPageKey } from './pageKeys.ts';
import {
  activeFilters, displayedIssues, inView, ISSUE_VIEWS, issuesPage, localDay, readDisplay, saveDisplay,
  type IssueFilters, type IssueNames, type IssueProperty, type IssuesDisplay, type IssuesViewName,
} from './issuesView.ts';

// The Issues page (ACH-D42, ACH-D43 phase 3): every issue across the projects, in the views All,
// Active, Backlog and Mine, with Filter (F) and its chips, Display (⇧V) for grouping, order and row
// properties, and wide one-line rows. Built from the panel list's pieces (ACH-D23): PaneFrame,
// PanelToolbar, PanelSection, PanelRow, ContextMenu rows and mono's Popover, Segmented and Toggle.
// An issue opens in place for now; the full issue view comes in phase 4.

const EMPTY_VIEW: Record<IssuesViewName, string> = {
  all: 'No issues yet.',
  active: 'Nothing is active. Issues past the backlog, from Todo to Needs you, show here.',
  backlog: 'The backlog is empty.',
  mine: 'Nothing is waiting on you. Issues assigned to you or needing you show here.',
};

export function IssuesPage({ chrome }: { chrome: PaneChrome }) {
  const issues = useApp(s => s.snapshot?.super.issues);
  const agents = useApp(s => s.snapshot?.agents);
  const projects = useApp(s => s.snapshot?.projects);
  const now = useNow();
  const today = localDay(now);
  const [view, setView] = useState<IssuesViewName>('active');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<IssueFilters>({});
  const [display, setDisplayState] = useState<IssuesDisplay>(() => readDisplay());
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [projectId, setProjectId] = useState('');
  // Each menu remembers what had focus when it opened, to give it back on close.
  const [filterMenu, setFilterMenu] = useState<{ anchor: PopoverAnchor; start?: IssueProperty; opener: Element | null } | null>(null);
  const [displayMenu, setDisplayMenu] = useState<{ anchor: PopoverAnchor; opener: Element | null } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // The trigger buttons, found in the pane when a key opens their menu (the buttons take no ref).
  const trigger = (name: 'filter' | 'display') => root.current?.closest('section')?.querySelector<HTMLElement>(`[data-issues-${name}]`) ?? null;

  const names = useMemo<IssueNames>(() => ({
    agent: id => agents?.find(a => a.id === id)?.name,
    project: id => projects?.find(p => p.id === id)?.name,
  }), [agents, projects]);
  const page = issuesPage(issues, { view, filters, query, display }, names, today);
  const open = (issues ?? []).filter(isOpenIssue).length;
  const filtering = Boolean(query.trim() || activeFilters(filters).length);

  const setDisplay = (next: IssuesDisplay) => { setDisplayState(next); saveDisplay(next); };
  const openFilter = (start?: IssueProperty, anchor: PopoverAnchor = trigger('filter')) => setFilterMenu({ anchor, start, opener: document.activeElement });
  const openDisplay = (anchor: PopoverAnchor) => setDisplayMenu({ anchor, opener: document.activeElement });
  const closeFilter = () => { restoreFocus(filterMenu?.opener ?? null, trigger('filter')); setFilterMenu(null); };
  const closeDisplay = () => { restoreFocus(displayMenu?.opener ?? null, trigger('display')); setDisplayMenu(null); };
  const closeAdd = () => { setAdding(false); focusAdd(root.current); };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!isPageKey(e)) return;
    if (e.key === 'f' && !e.shiftKey) { e.preventDefault(); openFilter(); return; }
    if (e.key === 'V' && e.shiftKey) { e.preventDefault(); openDisplay(trigger('display')); return; }
    // J and K move between rows, as the arrow keys do.
    if ((e.key === 'j' || e.key === 'k') && !e.shiftKey) {
      const rows = [...(root.current?.querySelectorAll<HTMLElement>('[data-panel-row-main]') ?? [])];
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const next = rows[at < 0 ? 0 : at + (e.key === 'j' ? 1 : -1)];
      if (next) { e.preventDefault(); next.focus(); }
    }
  };

  const title = (
    <span className="flex items-center gap-2">
      <CircleDashed className="size-3.5 text-content/55" strokeWidth={1.75} />
      <span className="text-content">Issues</span>
      {issues ? <span className="font-normal text-content/45">{open} open</span> : null}
    </span>
  );
  const actions = (
    <HeaderButton data-issues-display icon={SlidersHorizontal} label="Display options" title="Display options (⇧V)" active={Boolean(displayMenu)} onClick={e => (displayMenu ? closeDisplay() : openDisplay(e.currentTarget))} />
  );

  const row = (issue: SuperIssue) => (
    <IssueRow key={issue.id} issue={issue} properties={display.properties} today={today} now={now} expanded={expanded === issue.id} onOpen={() => setExpanded(id => (id === issue.id ? null : issue.id))} />
  );

  return (
    <PaneFrame chrome={chrome} title={title} actions={actions}>
      <div ref={root} onKeyDown={onKeyDown} className="@container/issues flex min-h-0 flex-1 flex-col font-sans">
        <PanelToolbar
          query={query}
          onQuery={setQuery}
          searchLabel="Search issues"
          filter={{ label: 'View', value: view, onChange: setView, options: ISSUE_VIEWS.map(v => ({ value: v.view, label: v.label, count: page.counts[v.view] })) }}
          onAdd={() => setAdding(a => !a)}
          addLabel="Add an issue"
        >
          <ChipButton data-issues-filter aria-haspopup="dialog" aria-expanded={Boolean(filterMenu)} title="Filter (F)" onClick={e => (filterMenu ? closeFilter() : openFilter(undefined, e.currentTarget))}>
            <ListFilter aria-hidden className="size-3" strokeWidth={1.75} />
            Filter
            <Kbd spec="F" quiet className="hidden @min-[36rem]/issues:inline-flex" />
          </ChipButton>
        </PanelToolbar>
        {adding ? (
          <Composer placeholder="Add an issue" label="New issue" onClose={closeAdd} onAdd={async text => Boolean(await attempt(() => api.addIssue({ text, projectId: projectId || null })))}>
            <select aria-label="Project" value={projectId} onChange={e => setProjectId(e.target.value)} className="h-5 max-w-40 truncate rounded bg-content/5 px-1 text-[11px] text-content/65 outline-none">
              <option value="">Any project</option>
              {(projects ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Composer>
        ) : null}
        <FilterChips filters={filters} names={names} onChange={setFilters} onEdit={(property, el) => openFilter(property, el)} />
        {issues && !issues.length && !adding ? (
          <Empty icon={CircleDashed} title="No issues yet" action={<DetailButton onClick={() => setAdding(true)}>Add issue</DetailButton>}>
            Issues are what you want done. The SuperAgent works through them top down, giving each to a free agent.
          </Empty>
        ) : (
          <PanelList label="Issues">
            {page.groups.map(g => {
              // Closed groups fold, unless opened, searched or filtered for.
              const folded = g.closed && !unfolded.has(g.key) && !query.trim() && !filters.status?.includes(g.key);
              const toggle = g.closed ? () => setUnfolded(s => { const next = new Set(s); if (next.has(g.key)) next.delete(g.key); else next.add(g.key); return next; }) : undefined;
              return (
                <section key={g.key} aria-label={g.label}>
                  <PanelSection label={g.label} count={g.items.length} folded={toggle ? folded : undefined} onToggle={toggle} />
                  {folded ? null : g.items.map(row)}
                </section>
              );
            })}
            {!page.shown ? (
              filtering && page.inView
                ? <PanelEmpty icon={<SearchIcon strokeWidth={1.5} />} title="No issues match" action={<DetailButton onClick={() => { setFilters({}); setQuery(''); }}>Clear filters</DetailButton>} />
                : <p className="px-1.5 py-3 text-[12px] text-content/50">{EMPTY_VIEW[view]}</p>
            ) : null}
          </PanelList>
        )}
      </div>
      {filterMenu ? (
        <FilterMenu
          key={filterMenu.start ?? 'all'}
          anchor={filterMenu.anchor}
          start={filterMenu.start}
          issues={displayedIssues(issues, display).filter(g => inView(g, view))}
          filters={filters}
          onChange={setFilters}
          names={names}
          today={today}
          onClose={closeFilter}
        />
      ) : null}
      {displayMenu ? <DisplayMenu anchor={displayMenu.anchor} display={display} onChange={setDisplay} onClose={closeDisplay} /> : null}
    </PaneFrame>
  );
}
