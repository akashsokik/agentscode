import { HttpError } from './errors.ts';
import { ALL_CODE, isActive, isCode, parseRefId, type ProjectRefs, type RefEntry } from './projectRefs.ts';
import type { RefMentions } from './refMentions.ts';
import { queryWords, sourceLine, splitLinks, type RefDetail, type RefProject, type RefSearchHit, type RefState, type RefsIndex, type RefSummary } from '../shared/refs.ts';
import type { Project } from '../shared/types.ts';

// The Notes tab's read API over the project notes store (server/projectRefs.ts) and where each id is
// cited (server/refMentions.ts). It only reads: entries are added by agents' note_add and
// decision_add, and edited by hand in the Markdown files.

/** The most results a search returns. */
export const NOTES_SEARCH_LIMIT = 60;
const GIST = 180;

export interface NotesSource {
  refs: ProjectRefs;
  mentions: RefMentions;
  projects: () => Iterable<Project>;
}

function state(entry: RefEntry): RefState {
  if (entry.kind === 'N') return 'note';
  return isActive(entry) ? 'active' : 'replaced';
}

function gist(text: string): string {
  const flat = text.replace(/[#*_`>]+/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > GIST ? `${flat.slice(0, GIST - 3).replace(/\s+\S*$/, '')}...` : flat;
}

export class NotesApi {
  private source: NotesSource;
  constructor(source: NotesSource) { this.source = source; }

  /** The codes to list: every live project's, then ALL and any folder left from a removed project. */
  private projectList(): RefProject[] {
    const { refs } = this.source;
    const live = [...this.source.projects()].filter(p => p.code);
    const codes = [...live.map(p => p.code!), ALL_CODE, ...refs.codes()].filter((c, i, all) => all.indexOf(c) === i);
    return codes.map(code => {
      const project = live.find(p => p.code === code);
      const decisions = refs.entries(code, 'D');
      const replaced = decisions.filter(d => !isActive(d)).length;
      return {
        code,
        name: project?.name ?? (code === ALL_CODE ? 'All projects' : refs.projectInfo(code)?.name ?? code),
        ...(project ? { projectId: project.id } : {}),
        decisions: decisions.length - replaced,
        notes: refs.entries(code, 'N').length,
        replaced,
      };
    });
  }

  private allEntries(codes: string[]): RefEntry[] {
    return codes.flatMap(code => [...this.source.refs.entries(code, 'D'), ...this.source.refs.entries(code, 'N')]);
  }

  /** Who each replaced decision was replaced by, read backwards: the id it replaced, by the new id. */
  private replacesMap(entries: RefEntry[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const entry of entries) if (entry.replacedBy) map.set(entry.replacedBy, entry.id);
    return map;
  }

  private summary(entry: RefEntry, replaces: Map<string, string>, counts: Map<string, number>): RefSummary {
    const { addedBy } = entry;
    return {
      id: entry.id,
      code: entry.code,
      kind: entry.kind,
      num: entry.num,
      title: entry.title,
      state: state(entry),
      status: entry.status,
      ...(entry.replacedBy ? { replacedBy: entry.replacedBy } : {}),
      ...(replaces.has(entry.id) ? { replaces: replaces.get(entry.id) } : {}),
      by: entry.by,
      ...(addedBy ? { addedBy } : {}),
      date: entry.date,
      gist: gist(entry.body),
      mentions: counts.get(entry.id) ?? 0,
    };
  }

  /** Every project and every entry, newest first within each project and kind. */
  index(): RefsIndex {
    const projects = this.projectList();
    const entries = this.allEntries(projects.map(p => p.code));
    const replaces = this.replacesMap(entries);
    const counts = this.source.mentions.counts();
    const order = new Map(projects.map((p, i) => [p.code, i]));
    const sorted = entries
      .map(e => this.summary(e, replaces, counts))
      .sort((a, b) => (order.get(a.code)! - order.get(b.code)!) || a.kind.localeCompare(b.kind) || b.num - a.num);
    return { projects, entries: sorted };
  }

  /** One entry in full, with where it is cited. */
  get(rawId: string): RefDetail {
    const ref = parseRefId(rawId);
    if (!ref) throw new HttpError(400, 'Give an id such as ACH-D7.');
    const entry = this.source.refs.get(ref.id);
    if (!entry) throw new HttpError(404, `There is no note or decision ${ref.id}.`);
    const replaces = this.replacesMap(this.source.refs.entries(entry.code, 'D'));
    const { citations, count } = this.source.mentions.citations(entry.id);
    const links = splitLinks(entry.links);
    return {
      ...this.summary(entry, replaces, new Map([[entry.id, count]])),
      body: entry.body,
      why: entry.why,
      links: entry.links,
      commits: links.commits,
      related: links.related,
      otherLinks: links.other,
      citations,
    };
  }

  /**
   * Entries with every word of the query in their id, title, text, reason, author or links, in one
   * project or (no code) every one. Title matches come first; a match in the text or the reason
   * comes with the line it was found on. Newest first otherwise.
   */
  search(query: string, code?: string): RefSearchHit[] {
    const words = queryWords(query);
    if (!words.length) return [];
    if (code !== undefined && !isCode(code)) throw new HttpError(400, `Not a project code: ${JSON.stringify(code)}.`);
    const codes = code ? [code] : this.projectList().map(p => p.code);
    // Replaced-by and counts are read across every project, so a hit reads the same as in the list.
    const all = this.allEntries(this.projectList().map(p => p.code));
    const replaces = this.replacesMap(all);
    const counts = this.source.mentions.counts();
    const hits: (RefSearchHit & { rank: number })[] = [];
    for (const entry of all) {
      if (!codes.includes(entry.code)) continue;
      const hay = [entry.id, entry.title, entry.body, entry.why, entry.by, entry.status, ...entry.links].join('\n').toLowerCase();
      if (!words.every(w => hay.includes(w))) continue;
      const title = entry.title.toLowerCase();
      const summary = this.summary(entry, replaces, counts);
      if (words.some(w => title.includes(w))) {
        hits.push({ entry: summary, field: 'title', rank: 0 });
        continue;
      }
      const inBody = sourceLine(entry.body, words);
      if (inBody) { hits.push({ entry: summary, field: 'body', line: inBody, rank: 1 }); continue; }
      const inWhy = sourceLine(entry.why, words);
      if (inWhy) { hits.push({ entry: summary, field: 'why', line: inWhy, rank: 1 }); continue; }
      hits.push({ entry: summary, field: 'other', rank: 2 });
    }
    return hits
      .sort((a, b) => a.rank - b.rank || b.entry.date.localeCompare(a.entry.date) || b.entry.num - a.entry.num)
      .slice(0, NOTES_SEARCH_LIMIT)
      .map(({ rank: _rank, ...hit }) => hit);
  }
}
