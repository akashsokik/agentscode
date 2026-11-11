import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { queryWords, type RefDetail, type RefProject, type RefSearchHit, type RefSummary } from '../../shared/refs.ts';
import type { Agent } from '../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { open, useLayout } from '../layout.ts';
import { ChevronLeft, ChevronsUpDown, Search, X } from '../mono/icons.tsx';
import { Popover } from '../mono/Popover.tsx';
import { useApp } from '../store.ts';
import { Loading, MenuRow } from '../ui/common.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { citeTime, Highlight, kindWord, NoteGlyph, shortDate, StaticChip, StatusPill, WhoAvatar } from './parts.tsx';
import { RefChip } from './RefChip.tsx';
import { loadRefs, openNote, setNotesCode, setNotesEverywhere, setNotesFilter, setNotesQuery, useNotes, type NotesFilter } from './refsState.ts';

/*
 * The Notes tab: a project's decisions and notes, read only. One list per kind under quiet labels
 * (Decisions, Notes, Replaced); search over titles and text; an entry opens in place with its
 * decision, why, details and where it is cited. An agent on a project sees that project's; an agent
 * across all projects, the SuperAgent, or no agent at all get a project switcher.
 */

const SearchGlyph = () => <Search aria-hidden className="size-[13px] shrink-0" strokeWidth={1.75} />;

/** The project the list shows, and whether it can be switched. */
function useNotesProject(agent: Agent | undefined, projects: RefProject[]): { project: RefProject | undefined; switchable: boolean } {
  const live = useApp(s => s.snapshot?.projects);
  const layout = useLayout();
  const picked = useNotes(s => s.code);
  const own = agent && agent.role !== 'super' && agent.projectId !== null ? live?.find(p => p.id === agent.projectId)?.code : undefined;
  if (own) return { project: projects.find(p => p.code === own) ?? { code: own, name: live?.find(p => p.code === own)?.name ?? own, decisions: 0, notes: 0, replaced: 0 }, switchable: false };
  const current = layout.projectId ? live?.find(p => p.id === layout.projectId)?.code : undefined;
  const code = picked ?? current;
  const project = projects.find(p => p.code === code)
    ?? projects.find(p => p.decisions + p.notes + p.replaced > 0)
    ?? projects[0];
  return { project, switchable: true };
}

export function NotesView({ agent }: { agent: Agent | undefined }) {
  const index = useNotes(s => s.index);
  const error = useNotes(s => s.error);
  const openId = useNotes(s => s.openId);
  const { project, switchable } = useNotesProject(agent, index?.projects ?? []);
  // The files can be edited by hand, which sends no event: read them again whenever the tab opens.
  useEffect(() => { void loadRefs(); }, []);
  if (openId) return <NoteDetail id={openId} />;
  if (!index) return error ? <p className="p-4 font-sans text-[12px] text-danger">{error}</p> : <Loading className="px-4 py-4" />;
  if (!project) return <EmptyState icon={<NoteGlyph className="size-[18px]" />}>No projects yet.</EmptyState>;
  return <NotesList project={project} switchable={switchable} projects={index.projects} entries={index.entries} />;
}

function Header({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  // No line under it: the tab bar above already draws the panel's one separator.
  return <div className="flex h-10 shrink-0 items-center gap-1.5 pl-2 pr-3 font-sans">{children}{trailing}</div>;
}

function ProjectSwitcher({ project, projects }: { project: RefProject; projects: RefProject[] }) {
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
          <div role="listbox" aria-label="Projects">
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

const FILTERS: { value: NotesFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'D', label: 'Decisions' },
  { value: 'N', label: 'Notes' },
];

function Tools({ query }: { query: string }) {
  const filter = useNotes(s => s.filter);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-2 px-1 pb-1.5">
      <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[7px] bg-content/5 px-2 text-[12.5px] text-content/35 focus-within:text-content">
        <SearchGlyph />
        <input
          ref={input}
          value={query}
          onChange={e => setNotesQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); setNotesQuery(''); } }}
          placeholder="Search"
          aria-label="Search notes and decisions"
          className="min-w-0 flex-1 bg-transparent text-content outline-none placeholder:text-content/35"
        />
        {query ? (
          <button type="button" aria-label="Clear the search" onClick={() => { setNotesQuery(''); input.current?.focus(); }} className="grid size-4 shrink-0 place-items-center rounded text-content/40 hover:text-content">
            <X className="size-3" strokeWidth={1.75} />
          </button>
        ) : null}
      </label>
      <div role="group" aria-label="Show" className="inline-grid shrink-0 grid-cols-3 gap-0.5 rounded-[7px] bg-content/5 p-0.5 text-[12px]">
        {FILTERS.map(f => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setNotesFilter(f.value)}
            className={`rounded-[5px] px-[9px] py-[3px] transition-colors ${filter === f.value ? 'bg-content/10 text-content' : 'text-content/55 hover:text-content/80'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SectionLabel({ label, count, className = 'px-1.5 pb-1.5 pt-3.5' }: { label: string; count?: number; className?: string }) {
  return (
    <h4 className={`flex justify-between font-sans text-[11px] font-medium uppercase tracking-[0.04em] text-content/40 ${className}`}>
      <span>{label}</span>
      {count !== undefined ? <span className="tabular-nums">{count}</span> : null}
    </h4>
  );
}

/** One entry in the list: chip, title, date; who below, and what it replaced or what replaced it. */
function Row({ entry, words = [], hint }: { entry: RefSummary; words?: readonly string[]; hint?: ReactNode }) {
  const old = entry.state === 'replaced';
  const extra = entry.replacedBy ? [entry.kind === 'N' ? 'Outdated by' : 'Replaced by', entry.replacedBy] : entry.replaces ? ['Replaces', entry.replaces] : null;
  return (
    <>
      <button
        type="button"
        data-note-row={entry.id}
        onClick={() => openNote(entry.id)}
        aria-label={`${kindWord(entry.kind)} ${entry.id}: ${entry.title}${old ? (entry.kind === 'N' ? ', outdated' : ', replaced') : ''}`}
        className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-[7px] px-1.5 py-[7px] text-left font-sans text-[13px] transition-colors hover:bg-content/5 focus-visible:bg-content/7 focus-visible:outline-none ${old ? 'opacity-50' : ''}`}
      >
        <StaticChip summary={entry} />
        <span className="truncate text-content/90"><Highlight text={entry.title} words={words} /></span>
        <span className="text-[12px] tabular-nums text-content/35">{shortDate(entry.date)}</span>
        <span className="col-start-2 col-end-4 flex min-w-0 items-center gap-1.5 text-[12px] text-content/40">
          <WhoAvatar name={entry.by} />
          <span className="truncate">{entry.by || 'Unknown'}</span>
          {extra ? (
            <>
              <span className="text-content/35">·</span>
              <span className="shrink-0">{extra[0]} <span className="font-mono">{extra[1]}</span></span>
            </>
          ) : null}
        </span>
      </button>
      {hint}
    </>
  );
}

function EmptyState({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-7 py-10 text-center font-sans text-[12px] leading-normal text-content/55">
      <span aria-hidden className="text-content/55">{icon}</span>
      <span>{children}</span>
      {action}
    </div>
  );
}

function NotesList({ project, switchable, projects, entries }: { project: RefProject; switchable: boolean; projects: RefProject[]; entries: RefSummary[] }) {
  const filter = useNotes(s => s.filter);
  const query = useNotes(s => s.query);
  const everywhere = useNotes(s => s.everywhere);
  const mine = useMemo(() => entries.filter(e => e.code === project.code), [entries, project.code]);
  const shown = (e: RefSummary) => filter === 'all' || e.kind === filter;
  const decisions = mine.filter(e => e.state === 'active' && shown(e));
  const notes = mine.filter(e => e.state === 'note' && shown(e));
  const replaced = mine.filter(e => e.state === 'replaced' && shown(e));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header trailing={<span className="ml-auto shrink-0 font-mono text-[12px] text-content/40">{project.code}</span>}>
        {switchable ? <ProjectSwitcher project={project} projects={projects} /> : <h3 className="min-w-0 truncate pl-1.5 text-[13px] font-medium text-content">{project.name}</h3>}
      </Header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3 pt-1">
        {mine.length || query ? <Tools query={query} /> : null}
        {query.trim() ? (
          <SearchResults query={query} project={project} everywhere={everywhere} filter={filter} />
        ) : !mine.length ? (
          <EmptyState icon={<NoteGlyph className="size-[18px]" />}>
            No decisions or notes for {project.name} yet.<br />Agents add them as they work; ask any agent to record one.
          </EmptyState>
        ) : !decisions.length && !notes.length && !replaced.length ? (
          <EmptyState icon={<NoteGlyph className="size-[18px]" />}>No {filter === 'D' ? 'decisions' : 'notes'} for {project.name} yet.</EmptyState>
        ) : (
          <>
            {decisions.length ? <><SectionLabel label="Decisions" count={decisions.length} />{decisions.map(e => <Row key={e.id} entry={e} />)}</> : null}
            {notes.length ? <><SectionLabel label="Notes" count={notes.length} />{notes.map(e => <Row key={e.id} entry={e} />)}</> : null}
            {replaced.length ? <><SectionLabel label="Replaced" count={replaced.length} />{replaced.map(e => <Row key={e.id} entry={e} />)}</> : null}
          </>
        )}
      </div>
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
      <EmptyState
        icon={<SearchGlyph />}
        action={everywhere ? null : (
          <button type="button" onClick={() => setNotesEverywhere(true)} className="text-[12px] text-[var(--link-color)] hover:underline">Search every project</button>
        )}
      >
        Nothing about "{query.trim()}" in {where}.
      </EmptyState>
    );
  }
  return (
    <>
      <SectionLabel label={`${shown.length} ${shown.length === 1 ? 'result' : 'results'}${everywhere ? ' in every project' : ''}`} />
      {shown.map(hit => (
        <Row
          key={hit.entry.id}
          entry={hit.entry}
          words={words}
          hint={hit.line ? (
            <p className="-mt-1 pb-1 pl-10 pr-1.5 font-sans text-[11.5px] leading-snug text-content/35">
              {hit.field === 'why' ? 'Why: ' : ''}"<Highlight text={hit.line} words={words} />"
            </p>
          ) : null}
        />
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
    openNote(null);
    // Focus the row it came from once the list is back.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-note-row="${id}"]`)?.focus());
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
