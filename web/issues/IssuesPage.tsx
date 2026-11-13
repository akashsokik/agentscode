import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { isOpenIssue } from '../../shared/issues.ts';
import { api } from '../api.ts';
import { open } from '../layout.ts';
import { CircleDashed, ListFilter, Plus, SlidersHorizontal } from '../mono/icons.tsx';
import type { PopoverAnchor } from '../mono/Popover.tsx';
import { PaneFrame, type PaneChrome } from '../panes/PaneFrame.tsx';
import { Composer } from '../panes/SuperPanel.tsx';
import { attempt, useApp } from '../store.ts';
import { Empty, HeaderButton, Loading } from '../ui/common.tsx';
import { InboxFilterTabs, InboxGroup, InboxLayout, InboxList, InboxSearch } from '../ui/Inbox.tsx';
import { DetailButton } from '../ui/PanelList.tsx';
import { useNow } from '../ui/useNow.ts';
import { DisplayMenu, FilterChips, FilterMenu } from './IssueFilters.tsx';
import { IssueCard, IssueInboxDetail } from './IssueInbox.tsx';
import { restoreFocus } from './issueParts.tsx';
import { propertyKey } from './view/issueViewModel.ts';
import type { PropertySidebarHandle } from './view/PropertySidebar.tsx';
import { showIssueInList } from './openIssue.ts';
import { isPageKey } from './pageKeys.ts';
import {
  activeFilters, displayedIssues, inView, ISSUE_VIEWS, issuesPage, localDay, neighbourAfterLeaving, readDisplay, revealIssue, saveDisplay, shownIssueId,
  type IssueFilters, type IssueNames, type IssueProperty, type IssuesDisplay, type IssuesViewName,
} from './issuesView.ts';

// The Issues page (ACH-D42, ACH-D43): every issue across the projects, in the views All, Active,
// Backlog and Mine, with Filter (F) and its chips and Display (Shift+V). Laid out like Comms on the
// shared web/ui/Inbox.tsx (ACH-D54): the list rail on the left, grouped by status, and the selected
// issue's detail on the right (IssueInbox.tsx, Ada's issue view pieces). A click, Enter or the arrow
// keys (and J/K) select an issue; nothing unfolds in place and nothing jumps to another tab.

const EMPTY_VIEW: Record<IssuesViewName, string> = {
  all: 'No issues yet.',
  active: 'Nothing is active. Issues past the backlog, from Todo to Needs you, show here.',
  backlog: 'The backlog is empty.',
  mine: 'Nothing is waiting on you. Issues assigned to you or needing you show here.',
};

export function IssuesPage({ chrome, issueId }: { chrome: PaneChrome; /** The selected issue (ACH-D54): picked in the list, or opened from the right panel. */ issueId?: string }) {
  const issues = useApp(s => s.snapshot?.super.issues);
  const agents = useApp(s => s.snapshot?.agents);
  const projects = useApp(s => s.snapshot?.projects);
  const now = useNow();
  const today = localDay(now);
  const [view, setView] = useState<IssuesViewName>('active');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<IssueFilters>({});
  const [display, setDisplayState] = useState<IssuesDisplay>(() => readDisplay());
  const [adding, setAdding] = useState(false);
  const [projectId, setProjectId] = useState('');
  // Each menu remembers what had focus when it opened, to give it back on close.
  const [filterMenu, setFilterMenu] = useState<{ anchor: PopoverAnchor; start?: IssueProperty; opener: Element | null } | null>(null);
  const [displayMenu, setDisplayMenu] = useState<{ anchor: PopoverAnchor; opener: Element | null } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // The header's buttons, found in the pane when a key or a closed menu needs them (they take no ref).
  const trigger = (name: 'filter' | 'display' | 'add') => root.current?.closest('section')?.querySelector<HTMLElement>(`[data-issues-${name}]`) ?? null;

  const names = useMemo<IssueNames>(() => ({
    agent: id => agents?.find(a => a.id === id)?.name,
    project: id => projects?.find(p => p.id === id)?.name,
  }), [agents, projects]);
  const page = issuesPage(issues, { view, filters, query, display }, names, today);
  // The list in order, for the keyboard and for the first-issue fallback, as Comms does.
  const listed = page.groups.flatMap(g => g.items);
  const listedIds = listed.map(g => g.id);
  const asked = issueId ? issues?.find(g => g.id === issueId) : undefined;
  // The issue the detail shows stays put while it is listed (ACH-23): a live update that reorders
  // the list never swaps it by itself (issuesView.ts shownIssueId).
  const lastShown = useRef<string | undefined>(undefined);
  const shownId = shownIssueId(listedIds, issueId, Boolean(asked), lastShown.current);
  const selected = shownId ? issues?.find(g => g.id === shownId) : undefined;
  const sidebar = useRef<PropertySidebarHandle>(null);
  // In a narrow pane, moving with the keyboard only highlights (the list stays); a click, Enter, or
  // an issue asked for from elsewhere opens the detail, as picking on purpose does in Comms.
  const [peek, setPeek] = useState(false);
  const movedTo = useRef<string | undefined>(undefined);
  const detailOpen = Boolean(asked) && !peek;
  const lastFocusedCard = useRef<string | undefined>(undefined);
  const focusCard = (id: string) => requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-inbox-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: false }));
  /** Select an issue on purpose (a click, Enter): the detail opens, in a narrow pane too. */
  const select = (id: string) => { movedTo.current = undefined; setPeek(false); showIssueInList(id); };
  /** Select without opening a narrow pane's detail (the arrows, J/K, a neighbour after a removal). */
  const highlight = (id: string) => { movedTo.current = id; showIssueInList(id); };
  /** Esc in the detail, or its Back: to the list, on the issue it showed. */
  const back = () => {
    const id = selected?.id;
    movedTo.current = undefined;
    setPeek(false);
    open({ kind: 'issues' });
    if (id) focusCard(id);
  };
  useEffect(() => { if (issueId && issueId !== movedTo.current) setPeek(false); }, [issueId]);
  // When the shown issue leaves the list on its own (removed, canceled out of the view), select its
  // neighbour; when the card that had focus left, focus its neighbour. Not when the view, filters or
  // search changed: that is the user narrowing the list.
  const listKey = JSON.stringify([view, filters, query, display]);
  const before = useRef<{ ids: string[]; key: string } | null>(null);
  useLayoutEffect(() => {
    const prev = before.current;
    before.current = { ids: listedIds, key: listKey };
    if (!prev || prev.key !== listKey) return;
    const was = lastShown.current;
    const next = was ? neighbourAfterLeaving(prev.ids, listedIds, was) : null;
    if (next) highlight(next);
    const focused = lastFocusedCard.current;
    const lost = !document.activeElement || document.activeElement === document.body;
    const nextFocus = focused && lost ? neighbourAfterLeaving(prev.ids, listedIds, focused) : null;
    if (nextFocus) focusCard(nextFocus);
    // Only when the list itself changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listedIds.join(' '), listKey]);
  useLayoutEffect(() => { lastShown.current = selected?.id; });
  // A new view, filter or search starts the list at its top, as MonoCode's inbox does.
  useEffect(() => {
    const scroller = root.current?.querySelector('ul[aria-label="Issues"]')?.parentElement;
    if (scroller) scroller.scrollTop = 0;
  }, [view, filters, query]);
  // An issue asked for (from the right panel, say): make sure its card shows, then focus it.
  useEffect(() => {
    if (!asked) return;
    const change = revealIssue(asked, { view, filters, query, display }, today);
    if (change?.view) setView(change.view);
    if (change?.filters) setFilters(change.filters);
    if (change?.query !== undefined) setQuery(change.query);
    focusCard(asked.id);
    // Only when a different issue is asked for, not on every list change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId, Boolean(asked)]);
  const openCount = (issues ?? []).filter(isOpenIssue).length;
  const filtering = Boolean(query.trim() || activeFilters(filters).length);

  const setDisplay = (next: IssuesDisplay) => { setDisplayState(next); saveDisplay(next); };
  const openFilter = (start?: IssueProperty, anchor: PopoverAnchor = trigger('filter')) => setFilterMenu({ anchor, start, opener: document.activeElement });
  const openDisplay = (anchor: PopoverAnchor) => setDisplayMenu({ anchor, opener: document.activeElement });
  const closeFilter = () => { restoreFocus(filterMenu?.opener ?? null, trigger('filter')); setFilterMenu(null); };
  const closeDisplay = () => { restoreFocus(displayMenu?.opener ?? null, trigger('display')); setDisplayMenu(null); };
  const closeAdd = () => { setAdding(false); trigger('add')?.focus(); };
  /** The next issue up or down from the selected one, selected; its id, for the list to focus. */
  const move = (step: -1 | 1) => {
    const at = listed.findIndex(g => g.id === selected?.id);
    const next = listed[Math.max(0, Math.min(listed.length - 1, at + step))];
    if (next) { setPeek(true); highlight(next.id); }
    return next?.id;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!isPageKey(e)) return;
    if (e.key === 'f' && !e.shiftKey) { e.preventDefault(); openFilter(); return; }
    if (e.key === 'V' && e.shiftKey) { e.preventDefault(); openDisplay(trigger('display')); return; }
  };
  // J and K move the selection in the rail, as the arrow keys do (InboxLayout's onRailKeyDown).
  const onRailKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!isPageKey(e) || e.shiftKey) return;
    if (e.key === 'j' || e.key === 'k') {
      const id = move(e.key === 'j' ? 1 : -1);
      if (id) { e.preventDefault(); focusCard(id); }
      return;
    }
    // S, P, D and L work on the selected issue from the list too, as in its detail (ACH-23).
    const property = propertyKey(e, e.target);
    if (!property || !selected) return;
    e.preventDefault();
    // A narrow pane shows the detail first, so the picker opens on its row.
    if (!detailOpen) {
      select(selected.id);
      requestAnimationFrame(() => requestAnimationFrame(() => sidebar.current?.open(property)));
    } else sidebar.current?.open(property);
  };

  const title = (
    <span className="flex items-center gap-2">
      <CircleDashed className="size-3.5 text-content/55" strokeWidth={1.75} />
      <span className="text-content">Issues</span>
      {issues ? <span className="font-normal text-content/45">{openCount} open</span> : null}
    </span>
  );
  const actions = (
    <>
      <HeaderButton data-issues-filter icon={ListFilter} label="Filter" title="Filter (F)" active={Boolean(filterMenu) || activeFilters(filters).length > 0} onClick={e => (filterMenu ? closeFilter() : openFilter(undefined, e.currentTarget))} />
      <HeaderButton data-issues-display icon={SlidersHorizontal} label="Display options" title="Display options (⇧V)" active={Boolean(displayMenu)} onClick={e => (displayMenu ? closeDisplay() : openDisplay(e.currentTarget))} />
      <HeaderButton data-issues-add icon={Plus} label="Add an issue" title="Add an issue" active={adding} onClick={() => (adding ? closeAdd() : setAdding(true))} />
    </>
  );

  const empty = !page.shown
    ? (filtering && page.inView ? 'No issues match. Clear the search or the filters to see more.' : EMPTY_VIEW[view])
    : undefined;

  return (
    <PaneFrame chrome={chrome} title={title} actions={actions}>
      <div
        ref={root}
        onKeyDown={onKeyDown}
        onFocus={e => { const id = (e.target as HTMLElement).dataset?.inboxId; if (id) lastFocusedCard.current = id; }}
        className="flex min-h-0 flex-1 flex-col font-sans"
      >
        {!issues ? <Loading /> : !issues.length && !adding ? (
          <Empty icon={CircleDashed} title="No issues yet" action={<DetailButton onClick={() => setAdding(true)}>Add issue</DetailButton>}>
            Issues are what you want done. The SuperAgent works through them top down, giving each to a free agent.
          </Empty>
        ) : (
          <InboxLayout
            detailOpen={detailOpen}
            onRailKeyDown={onRailKeyDown}
            toolbar={<>
              {/* Counts only where they need you (Mine), as the Pull requests rail: four labels fit the rail's width then. */}
              <InboxFilterTabs label="View" options={ISSUE_VIEWS.map(v => ({ value: v.view, label: v.label, count: v.view === 'mine' ? page.counts.mine : undefined, attention: v.view === 'mine' }))} value={view} onChange={setView} fit />
              <InboxSearch value={query} onChange={setQuery} placeholder="Filter issues" />
              <FilterChips filters={filters} names={names} onChange={setFilters} onEdit={(property, el) => openFilter(property, el)} />
              {adding ? (
                <Composer placeholder="Add an issue" label="New issue" onClose={closeAdd} onAdd={async text => Boolean(await attempt(() => api.addIssue({ text, projectId: projectId || null })))}>
                  <select aria-label="Project" value={projectId} onChange={e => setProjectId(e.target.value)} className="h-5 max-w-40 truncate rounded bg-content/5 px-1 text-[11px] text-content/65 outline-none">
                    <option value="">Any project</option>
                    {(projects ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Composer>
              ) : null}
            </>}
            list={(
              <InboxList label="Issues" onMove={move} empty={empty}>
                {page.groups.map(g => (
                  <Fragment key={g.key}>
                    {display.groupBy !== 'none' ? <InboxGroup label={g.label} count={g.items.length} /> : null}
                    {g.items.map(issue => <IssueCard key={issue.id} issue={issue} active={selected?.id === issue.id} onSelect={() => select(issue.id)} properties={display.properties} today={today} now={now} />)}
                  </Fragment>
                ))}
              </InboxList>
            )}
            detail={selected && issues ? <IssueInboxDetail key={selected.id} issue={selected} issues={issues} now={now} sidebar={sidebar} onBack={back} /> : null}
          />
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
