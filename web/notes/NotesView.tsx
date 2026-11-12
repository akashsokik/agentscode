import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { queryWords, type RefDetail, type RefProject, type RefSearchHit, type RefSummary } from '../../shared/refs.ts';
import type { Agent } from '../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { open, useLayout } from '../layout.ts';
import { ChevronLeft, ChevronsUpDown, Copy, ExternalLink, Search } from '../mono/icons.tsx';
import { Popover } from '../mono/Popover.tsx';
import { useApp } from '../store.ts';
import { Loading, MenuLabel, MenuRow } from '../ui/common.tsx';
import { DetailButton, PanelEmpty, PanelList, PanelRow, PanelSection, PanelToolbar } from '../ui/PanelList.tsx';
import { authorLabel, notesSections } from '../panelList.ts';
import { Markdown } from '../ui/Markdown.tsx';
import { citeTime, Highlight, kindWord, NoteGlyph, shortDate, StaticChip, StatusPill, WhoAvatar } from './parts.tsx';
import { RefChip } from './RefChip.tsx';
import { loadRefs, openNote, setNotesCode, setNotesEverywhere, setNotesFilter, setNotesQuery, setNotesShowReplaced, useNotes, type NotesFilter } from './refsState.ts';

/*
 * The Notes tab: a project's decisions and notes, read only. One list per kind under quiet labels
 * (Decisions, Notes, Replaced); search over titles and text; an entry opens in place with its
 * decision, why, details and where it is cited. An agent on a project sees that project's; an agent
 * across all projects, the SuperAgent, or no agent at all get a project switcher.
 */

const SearchGlyph = () => <Search aria-hidden className="size-[13px] shrink-0" strokeWidth={1.75} />;

/** The project the list shows, whether it can be switched, and to which (null: any). */
function useNotesProject(agent: Agent | undefined, projects: RefProject[]): { project: RefProject | undefined; switchable: boolean; options: RefProject[]; label?: string } {
  const live = useApp(s => s.snapshot?.projects);
  const layout = useLayout();
  const picked = useNotes(s => s.code);
  const asRef = (code: string): RefProject => projects.find(p => p.code === code) ?? { code, name: code === 'ALL' ? 'All projects' : live?.find(p => p.code === code)?.name ?? code, decisions: 0, notes: 0, replaced: 0 };
  // An agent on chosen projects: its own projects' notes (the start folder's first), and with
  // several, a switcher between them and All (ACH-D15).
  const codes = agent && agent.role !== 'super' && agent.projectIds !== null
    ? agent.projectIds.flatMap(id => { const code = live?.find(p => p.id === id)?.code; return code ? [code] : []; })
    : [];
  if (codes.length === 1) return { project: asRef(codes[0]), switchable: false, options: [] };
  if (codes.length > 1) {
    const options = [...codes, 'ALL'].map(asRef);
    return { project: options.find(p => p.code === picked) ?? options[0], switchable: true, options, label: `${agent!.name} works in` };
  }
  const current = layout.projectId ? live?.find(p => p.id === layout.projectId)?.code : undefined;
  const code = picked ?? current;
  const project = projects.find(p => p.code === code)
    ?? projects.find(p => p.decisions + p.notes + p.replaced > 0)
    ?? projects[0];
  return { project, switchable: true, options: projects };
}

export function NotesView({ agent }: { agent: Agent | undefined }) {
  const index = useNotes(s => s.index);
  const error = useNotes(s => s.error);
  const openId = useNotes(s => s.openId);
  const { project, switchable, options, label } = useNotesProject(agent, index?.projects ?? []);
  // The files can be edited by hand, which sends no event: read them again whenever the tab opens.
  useEffect(() => { void loadRefs(); }, []);
  if (openId) return <NoteDetail id={openId} />;
  if (!index) return error ? <p className="p-4 font-sans text-[12px] text-danger">{error}</p> : <Loading className="px-4 py-4" />;
  if (!project) return <PanelEmpty icon={<NoteGlyph />} title="No projects yet" />;
  return <NotesList project={project} switchable={switchable} projects={options} switcherLabel={label} entries={index.entries} />;
}

function Header({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  // No line under it: the tab bar above already draws the panel's one separator.
  return <div className="flex h-10 shrink-0 items-center gap-1.5 pl-2 pr-3 font-sans">{children}{trailing}</div>;
}

function ProjectSwitcher({ project, projects, label }: { project: RefProject; projects: RefProject[]; label?: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={Boolean(anchor)}
        title="Show another project's notes"
        onClick={e => { const el = e.currentTarget; setAnchor(a => (a ? null : el)); }}
        className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-medium text-content transition-colors hover:bg-content/5"
      >
        <span className="truncate">{project.name}</span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
      </button>
      {anchor ? (
        <Popover anchor={anchor} side="bottom" align="start" width={260} onDismiss={() => setAnchor(null)} className="p-1.5">
          <div role="listbox" aria-label={label ?? 'Projects'}>
            {label ? <MenuLabel>{label}</MenuLabel> : null}
            {projects.map(p => (
              <MenuRow
                key={p.code}
                selected={p.code === project.code}
                title={<span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate">{p.name}</span><span className="font-mono text-[11px] text-content/40">{p.code}</span></span>}
                hint={p.decisions + p.notes + p.replaced ? `${p.decisions} in force, ${p.notes} ${p.notes === 1 ? 'note' : 'notes'}${p.replaced ? `, ${p.replaced} replaced` : ''}` : 'Nothing yet'}
                onSelect={() => { setAnchor(null); setNotesCode(p.code); }}
              />
            ))}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/**
 * One entry in the list, one line (ACH-D37): chip (no glyph here), title, then quiet meta: who,
 * only when it is not you, and the date; a replaced entry shows what replaced it instead. ⏎ or a
 * click opens it; right-click or ⇧F10 shows its menu.
 */
function Row({ entry, words = [] }: { entry: RefSummary; words?: readonly string[] }) {
  const old = entry.state === 'replaced';
  const author = authorLabel(entry.by);
  const status = old ? (entry.kind === 'N' ? ', outdated' : ', replaced') : '';
  return (
    <PanelRow
      id={entry.id}
      title={<span className="flex min-w-0 items-center gap-2"><StaticChip summary={entry} glyph={false} /><span className="truncate"><Highlight text={entry.title} words={words} /></span></span>}
      label={`${kindWord(entry.kind)} ${entry.id}: ${entry.title}${status}${entry.by ? `, by ${entry.by}` : ''}, ${shortDate(entry.date)}${entry.replacedBy ? `, ${entry.kind === 'N' ? 'outdated' : 'replaced'} by ${entry.replacedBy}` : entry.replaces ? `, replaces ${entry.replaces}` : ''}`}
      dim={old}
      meta={old && entry.replacedBy
        ? <span className="font-mono text-[10.5px]">→ {entry.replacedBy}</span>
        : <span>{author ? `${author} · ` : ''}{shortDate(entry.date)}</span>}
      onOpen={() => openNote(entry.id)}
      menuLabel={`${kindWord(entry.kind)} ${entry.id}`}
      menu={close => (
        <>
          <MenuRow icon={ExternalLink} title="Open" shortcut="Enter" onSelect={() => { close(); openNote(entry.id); }} />
          <MenuRow icon={Copy} title="Copy ID" onSelect={() => { close(); void navigator.clipboard?.writeText(entry.id); }} />
        </>
      )}
    />
  );
}

/** A heading inside an open entry: sentence case like the list's sections (ACH-D37). */
function SectionLabel({ label, count, className }: { label: string; count?: number; className: string }) {
  return (
    <h4 className={`flex justify-between font-sans text-[11px] font-medium text-content/50 ${className}`}>
      <span>{label}</span>
      {count !== undefined ? <span className="font-normal tabular-nums">{count}</span> : null}
    </h4>
  );
}

function NotesList({ project, switchable, projects, switcherLabel, entries }: { project: RefProject; switchable: boolean; projects: RefProject[]; switcherLabel?: string; entries: RefSummary[] }) {
  const filter = useNotes(s => s.filter);
  const query = useNotes(s => s.query);
  const everywhere = useNotes(s => s.everywhere);
  const mine = useMemo(() => entries.filter(e => e.code === project.code), [entries, project.code]);
  const { decisions, notes, replaced, counts } = notesSections(mine, filter);
  const showReplaced = useNotes(s => s.showReplaced);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header trailing={<span className="ml-auto shrink-0 font-mono text-[12px] text-content/40">{project.code}</span>}>
        {switchable ? <ProjectSwitcher project={project} projects={projects} label={switcherLabel} /> : <h3 className="min-w-0 truncate pl-1.5 text-[13px] font-medium text-content">{project.name}</h3>}
      </Header>
      {mine.length || query ? (
        <PanelToolbar
          query={query}
          onQuery={setNotesQuery}
          searchLabel="Search notes and decisions"
          filter={{ label: 'Show', value: filter, onChange: setNotesFilter, options: [{ value: 'all', label: 'All', count: counts.all }, { value: 'D', label: 'Decisions', count: counts.D }, { value: 'N', label: 'Notes', count: counts.N }] }}
        />
      ) : null}
      <PanelList label="Notes and decisions">
        {query.trim() ? (
          <SearchResults query={query} project={project} everywhere={everywhere} filter={filter} />
        ) : !mine.length ? (
          <PanelEmpty icon={<NoteGlyph />} title={`No decisions or notes for ${project.name} yet`}>Agents add them as they work; ask any agent to record one.</PanelEmpty>
        ) : !decisions.length && !notes.length && !replaced.length ? (
          <PanelEmpty icon={<NoteGlyph />} title={`No ${filter === 'D' ? 'decisions' : 'notes'} for ${project.name} yet`} />
        ) : (
          <>
            {decisions.length ? <><PanelSection label="Decisions" count={decisions.length} />{decisions.map(e => <Row key={e.id} entry={e} />)}</> : null}
            {notes.length ? <><PanelSection label="Notes" count={notes.length} />{notes.map(e => <Row key={e.id} entry={e} />)}</> : null}
            {replaced.length ? <><PanelSection label="Replaced" count={replaced.length} folded={!showReplaced} onToggle={() => setNotesShowReplaced(!showReplaced)} />{showReplaced ? replaced.map(e => <Row key={e.id} entry={e} />) : null}</> : null}
          </>
        )}
      </PanelList>
    </div>
  );
}

function SearchResults({ query, project, everywhere, filter }: { query: string; project: RefProject; everywhere: boolean; filter: NotesFilter }) {
  const [hits, setHits] = useState<RefSearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = useNotes(s => s.idsKey);
  const words = useMemo(() => queryWords(query), [query]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api.searchRefs(query, everywhere ? undefined : project.code)
        .then(r => { if (live) { setHits(r.hits); setError(null); } })
        .catch((e: Error) => { if (live) setError(e.message); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [query, project.code, everywhere, ids]);
  if (error) return <p className="px-1.5 pt-3 font-sans text-[12px] text-danger">{error}</p>;
  if (!hits) return <Loading className="px-1.5 py-3" />;
  const shown = hits.filter(h => filter === 'all' || h.entry.kind === filter);
  const where = everywhere ? 'any project' : project.name;
  if (!shown.length) {
    return (
      <PanelEmpty
        icon={<SearchGlyph />}
        title={`Nothing about "${query.trim()}" in ${where}`}
        action={everywhere ? null : <DetailButton onClick={() => setNotesEverywhere(true)}>Search every project</DetailButton>}
      />
    );
  }
  return (
    <>
      <PanelSection label={`${shown.length} ${shown.length === 1 ? 'result' : 'results'}${everywhere ? ' in every project' : ''}`} />
      {shown.map(hit => (
        <div key={hit.entry.id}>
          <Row entry={hit.entry} words={words} />
          {hit.line ? (
            <p className="-mt-0.5 truncate pb-1 pl-[30px] pr-1.5 font-sans text-[11.5px] leading-snug text-content/40">
              {hit.field === 'why' ? 'Why: ' : ''}"<Highlight text={hit.line} words={words} />"
            </p>
          ) : null}
        </div>
      ))}
    </>
  );
}

function NoteDetail({ id }: { id: string }) {
  const summary = useNotes(s => s.byId.get(id));
  const [detail, setDetail] = useState<RefDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    api.ref(id)
      .then(d => { if (live) { setDetail(d); setError(null); } })
      .catch((e: Error) => { if (live) setError(e instanceof ApiError && e.status === 404 ? `${id} is not in the notes any more.` : e.message); });
    return () => { live = false; };
    // Read again when the summary changes: a new citation or a hand edit.
  }, [id, summary]);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, [id]);
  const goBack = () => {
    // A replaced entry's row is in the folded section: open it, so the row is there to focus.
    if (summary?.state === 'replaced') setNotesShowReplaced(true);
    openNote(null);
    // Focus the row it came from once the list is back.
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-panel-row="${CSS.escape(id)}"] [data-panel-row-main]`)?.focus()));
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); goBack(); } }}>
      <Header>
        <button ref={back} type="button" aria-label="Back to the list" title="Back" onClick={goBack} className="grid size-[26px] place-items-center rounded-md text-content/55 transition-colors hover:bg-content/5 hover:text-content">
          <ChevronLeft className="size-3.5" strokeWidth={1.75} />
        </button>
        <h3 className="text-[13px] font-medium text-content">Notes</h3>
      </Header>
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-6 font-sans">
        {error ? <p className="pt-4 text-[12px] text-content/55">{error}</p>
          : !detail ? <Loading className="py-4" />
          : <DetailBody detail={detail} />}
      </div>
    </div>
  );
}

function RefWithTitle({ id }: { id: string }) {
  const other = useNotes(s => s.byId.get(id));
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {other ? <RefChip id={id} /> : <span className="font-mono">{id}</span>}
      {other ? <span className="min-w-0 truncate">{other.title}</span> : null}
    </span>
  );
}

function DetailBody({ detail }: { detail: RefDetail }) {
  const isDecision = detail.kind === 'D';
  const rows: [string, ReactNode][] = [
    [isDecision ? 'Decided by' : 'Written by', <><WhoAvatar name={detail.by} /><span className="truncate">{detail.by || 'Unknown'}{detail.date ? `, ${shortDate(detail.date)}` : ''}</span></>],
  ];
  if (detail.addedBy) rows.push(['Recorded by', <><WhoAvatar name={detail.addedBy} /><span className="truncate">{detail.addedBy}</span></>]);
  if (detail.commits.length) rows.push([detail.commits.length === 1 ? 'Commit' : 'Commits', <span className="flex flex-wrap gap-x-2 font-mono text-[var(--link-color)]">{detail.commits.map(c => <span key={c} title={c}>{c.slice(0, 7)}</span>)}</span>]);
  if (detail.related.length) rows.push(['Related', <span className="flex min-w-0 flex-col gap-1 py-1">{detail.related.map(r => <RefWithTitle key={r} id={r} />)}</span>]);
  if (detail.otherLinks.length) {
    rows.push(['Links', <span className="flex min-w-0 flex-col py-1">{detail.otherLinks.map(link => (
      /^https?:\/\//.test(link)
        ? <a key={link} href={link} target="_blank" rel="noreferrer" className="truncate text-[var(--link-color)] hover:underline">{link}</a>
        : <span key={link} className="truncate">{link}</span>
    ))}</span>]);
  }
  if (isDecision) rows.push(['Replaces', detail.replaces ? <RefWithTitle id={detail.replaces} /> : <span className="text-content/35">Nothing</span>]);
  if (!isDecision && detail.replaces) rows.push(['Replaces', <RefWithTitle id={detail.replaces} />]);
  if (detail.replacedBy) rows.push([isDecision ? 'Replaced by' : 'Outdated by', <RefWithTitle id={detail.replacedBy} />]);
  return (
    <>
      <div className="px-0 pb-1 pt-3.5">
        <div className="flex items-center gap-1.5 text-[12px] text-content/45">
          <StaticChip summary={detail} small={false} />
          <span>{kindWord(detail.kind)}</span>
          <StatusPill summary={detail} />
        </div>
        <h2 className="mt-1.5 text-[16px] font-semibold leading-[1.35] text-content">{detail.title}</h2>
      </div>
      <Markdown inert text={detail.body} className="text-[13px] leading-[1.55] text-content/85" />
      {detail.why ? (
        <>
          <SectionLabel label="Why" className="pb-1 pt-4" />
          <p className="text-[13px] leading-[1.55] text-content/70">{detail.why}</p>
        </>
      ) : null}
      <SectionLabel label="Details" className="pb-0.5 pt-4" />
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] text-[12px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="flex min-h-7 items-center text-content/45">{label}</dt>
            <dd className="flex min-h-7 min-w-0 items-center gap-1.5 text-content/85">{value}</dd>
          </div>
        ))}
      </dl>
      <SectionLabel label="Mentioned in" count={detail.mentions} className="pb-0.5 pt-4" />
      {detail.citations.length ? (
        <ul>
          {detail.citations.map(c => (
            <li key={c.key}>
              <button
                type="button"
                onClick={() => open(c.open.kind === 'agent' ? { kind: 'agent', agentId: c.open.agentId } : c.open.kind === 'channel' ? { kind: 'channel', channelId: c.open.channelId } : { kind: 'comms', conversationId: c.open.conversationId })}
                className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-[5px] text-left text-[12.5px] text-content/70 transition-colors hover:bg-content/5"
              >
                <WhoAvatar name={c.who} agentId={c.agentId} />
                <span className="min-w-0 truncate">{c.who}, {c.where}</span>
                <span className="ml-auto shrink-0 text-[12px] tabular-nums text-content/35">{citeTime(c.ts)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="py-1 text-[12px] text-content/35">Not cited anywhere yet.</p>}
    </>
  );
}
