// ACH-59 demo (ACH-D81): the Settings page reworked toward the user's reference: a compact section
// sidebar under small group headers with a search field, a centred ~600px column with a large page
// title, small headings over flat rounded cards of rows (title and one-line description left,
// control right). Back in two places: A at the sidebar foot (today, ACH-D77), B beside the Settings
// title at the top (as in the reference). Builds settings-layout-demo.html next to this file, with
// the app's compiled CSS inlined so Group, Row, Select and Toggle use their real class strings.
// Usage: node docs/demos/ACH-59/build.mts <path to the app's compiled styles-*.css>
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HugeiconsIcon } from '@hugeicons/react';
import fs from 'node:fs';
import path from 'node:path';

const lib = await import('@hugeicons/core-free-icons') as Record<string, unknown>;
const icon = (n: string, cls = 'size-4 shrink-0 opacity-70') => renderToStaticMarkup(h(HugeiconsIcon, { icon: lib[n], strokeWidth: 1.75, className: cls, 'aria-hidden': true } as never));
const css = fs.readFileSync(process.argv[2], 'utf8');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// --- Controls: the real class strings of Toggle, Select's trigger, INPUT and a quiet text button ---
const toggle = (on: boolean, disabled = false) => `<button type="button" role="switch" aria-checked="${on}" ${disabled ? 'disabled' : ''} class="tgl relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${on ? 'bg-accent' : 'bg-content/20 hover:bg-content/25'}"><span class="absolute top-0.5 size-4 rounded-full bg-white transition-[left] duration-200 ${on ? 'left-4.5' : 'left-0.5'}"></span></button>`;
const select = (value: string) => `<div class="relative w-40 max-w-52"><button type="button" class="flex w-full items-center justify-between gap-2 rounded-md border bg-content/5 px-2 py-1 text-left text-[12px] text-content transition-colors duration-150 hover:border-content/20 border-content/10"><span class="min-w-0 truncate">${value}</span>${icon('ArrowDown01Icon', 'size-3.5 shrink-0 text-content/50')}</button></div>`;
const input = (value: string, w = 'w-20') => `<span class="${w} inline-block rounded-md border border-content/15 bg-transparent px-2 py-1 text-[12px] text-content tabular-nums">${value}</span>`;
const textButton = (label: string) => `<button type="button" class="rounded-md px-2 py-1 text-[12px] font-medium text-content/70 transition-colors duration-150 hover:bg-content/8 hover:text-content">${label}</button>`;
const quiet = (text: string) => `<span class="text-[12px] text-content/45">${text}</span>`;

// --- Row and Group: today's components, with the reference's spacing (see NOTES.md) ---------------
type R = [title: string, description: string, control: string];
const row = ([title, description, control]: R) =>
  `<div class="settings-row flex items-center gap-6 border-b border-content/5 px-4 py-3 last:border-b-0" data-search="${esc(`${title} ${description}`.toLowerCase())}"><div class="min-w-0 flex-1"><div class="text-[13px] font-medium text-content">${title}</div>${description ? `<p class="mt-0.5 truncate text-[12px] text-content/45">${description}</p>` : ''}</div><div class="flex shrink-0 items-center justify-end gap-2">${control}</div></div>`;
const group = (heading: string, rows: R[]) =>
  `<section class="grp pt-8 first:pt-0"><h2 class="pb-2.5 text-[13px] font-semibold text-content">${heading}</h2><div class="overflow-hidden rounded-xl border border-content/10 bg-content/3">${rows.map(row).join('')}</div></section>`;

// --- Sections, regrouped (today's five, SuperAgent split in two; "Agent communication" is Messaging) --
type Page = { id: string; label: string; icon: string; group: string; groups: [string, R[]][] };
const PAGES: Page[] = [
  { id: 'appearance', label: 'Appearance', icon: 'PaintBoardIcon', group: '', groups: [
    ['Look', [
      ['Theme', 'Dark, light, or follow the system', select('Dark')],
      ['Avatars', 'Each agent in its own colour, or all in the text colour', select('Colour')],
    ]],
  ] },
  { id: 'messaging', label: 'Messaging', icon: 'MessageMultiple01Icon', group: 'Agents', groups: [
    ['Who can message', [
      ['Agents can message', 'Replies, and members of a shared channel, always get through', select('All projects')],
      ['Message budget', 'Messages per collaboration, replies included; 0 means no limit', input('12')],
    ]],
    ['What agents see', [
      ['Share current tasks', "list_agents shows each agent's task and activity", toggle(true)],
      ['Start with a team snapshot', 'Agents see who is working on what before they begin', toggle(true)],
    ]],
    ['Browser', [
      ['Browser scripts', 'Agents may run their own JavaScript in their browser tabs', toggle(false)],
    ]],
  ] },
  { id: 'engines', label: 'Engines', icon: 'BotIcon', group: 'Agents', groups: [
    ['Installed', [
      ['Claude Code', 'v2.4.1 at /opt/homebrew/bin/claude', quiet('7 models')],
      ['Codex', 'v0.98.0 at /opt/homebrew/bin/codex', quiet('5 models')],
      ['OrcaCode', 'v1.3.0 at ~/.local/bin/orcacode', quiet('3 models')],
    ]],
    ['Models', [
      ['Model lists', 'Ask each CLI for the models it offers now', textButton('Refresh')],
    ]],
  ] },
  { id: 'autonomy', label: 'Autonomy', icon: 'SparklesIcon', group: 'SuperAgent', groups: [
    ['Level', [
      ['Autonomy', 'How much it does without asking you; all of it is in Decisions', select('Full')],
      ['What it does on its own', 'Merges, restarts, cleanup and more, each with Undo', textButton('Show')],
    ]],
    ['Ask me first', [
      ['Delete files or data', 'Unmerged branches, uncommitted work, a backup', toggle(true)],
      ['Change outside accounts', 'Railway, Vercel, GitHub settings, anything with billing', toggle(true)],
      ['Remove agents you made', 'Agents it created itself it may remove', toggle(true)],
      ['Force-push a feature branch', 'One branch you approve, once; never main or tags', toggle(true)],
    ]],
  ] },
  { id: 'limits', label: 'Limits', icon: 'Clock01Icon', group: 'SuperAgent', groups: [
    ['Wake-ups', [
      ['Wake it when agents finish', 'Batched into one turn, sent only while it is idle', toggle(true)],
      ['Wake-ups an hour', 'Past this, updates wait for the next hour', input('6')],
      ['Notify me when it asks', 'A desktop notification while you are elsewhere', toggle(true)],
    ]],
    ['Spending', [
      ['Daily budget', 'Dollars a day for wake-ups; 0 means no cap', input('$10')],
      ['Agents it may create a day', 'Not used on Full autonomy', `<span class="opacity-40">${input('25')}</span>`],
    ]],
    ['Quiet hours', [
      ['Quiet hours', 'No wake-ups or notifications; the same time twice turns them off', `${input('23:00', 'w-16')}${quiet('to')}${input('07:00', 'w-16')}`],
    ]],
  ] },
  { id: 'about', label: 'About', icon: 'InformationCircleIcon', group: 'PodCode', groups: [
    ['PodCode', [
      ['Version', '0.3.1, build 4981a51', quiet('Stable')],
      ['Updates', 'Up to date', textButton('Check')],
      ['Release notes', 'What changed in 0.3.1', textButton('Open')],
    ]],
  ] },
];

// --- The sidebar: brand row (A) or "<- Settings" (B), search, grouped compact rows, Back (A) ---------
const navRow = (p: Page) => `<button type="button" data-page="${p.id}" class="nav flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-content/70 transition-colors duration-150 hover:bg-content/8 hover:text-content">${icon(p.icon, 'size-3.5 shrink-0 opacity-70')}<span class="min-w-0 flex-1 truncate">${p.label}</span></button>`;
const groups = [...new Set(PAGES.map(p => p.group))];
const navList = groups.map(g => `<div class="${g ? 'mt-4' : ''} flex flex-col gap-px">${g ? `<div class="px-2 pb-1 text-[11px] font-medium text-content/40">${g}</div>` : ''}${PAGES.filter(p => p.group === g).map(navRow).join('')}</div>`).join('');
const search = `<label class="mx-2 mb-2 flex h-7 items-center gap-2 rounded-md border border-content/10 bg-content/5 px-2 text-[12px] text-content/40">${icon('Search01Icon', 'size-3.5 shrink-0 opacity-70')}<input class="q min-w-0 flex-1 bg-transparent text-content outline-none placeholder:text-content/40" placeholder="Search settings"></label>`;
const sidebar = (back: 'A' | 'B') => `
<nav class="side sidebar-glass flex flex-col border-r border-stroke">
  ${back === 'A'
    ? `<div class="flex h-10 shrink-0 items-center gap-2 pl-3.5 text-[13px] font-semibold text-content/85"><i class="brand"></i>PodCode</div><div class="px-4 pb-1.5 pt-1 text-[11px] font-medium text-content/40">Settings</div>`
    : `<div class="flex h-10 shrink-0 items-center px-2"><button type="button" class="back flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-semibold text-content transition-colors duration-150 hover:bg-content/8">${icon('ArrowLeft01Icon', 'size-3.5 shrink-0 opacity-80')}Settings</button></div>`}
  ${search}
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden px-2">${navList}</div>
  ${back === 'A' ? `<div class="shrink-0 px-2 pb-2 pt-1.5"><button type="button" class="back flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium text-content/75 transition-colors duration-150 hover:bg-content/10 hover:text-content">${icon('ArrowLeft01Icon')}<span>Back</span></button></div>` : ''}
</nav>`;

const pageHtml = (p: Page) => `<div class="pg" data-page="${p.id}"><h1 class="pb-6 text-[20px] font-semibold tracking-[-0.01em] text-content">${p.label}</h1>${p.groups.map(([hd, rows]) => group(hd, rows)).join('')}</div>`;
const windowHtml = (back: 'A' | 'B') => `
<div class="win" data-back="${back}">
  ${sidebar(back)}
  <main class="min-w-0 flex-1 overflow-y-auto">
    <div class="mx-auto w-full px-8 py-12" style="max-width:664px">
      ${PAGES.map(pageHtml).join('')}
      <div class="results"><h1 class="pb-6 text-[20px] font-semibold text-content">Search</h1><div class="hits"></div><p class="none hidden text-[13px] text-content/45">Nothing matches.</p></div>
    </div>
  </main>
</div>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ACH-59 Settings layout</title>
<style>${css}</style>
<style>
html,body{margin:0}
body{background:var(--color-background-base);color:var(--color-content);font:13px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;padding:20px 24px}
.bar{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:12px;color:color-mix(in srgb,var(--color-content) 60%,transparent)}
.bar button{border:0;border-radius:6px;padding:4px 8px;font-size:12px;background:color-mix(in srgb,var(--color-content) 8%,transparent);color:var(--color-content)}
.bar button.on{background:var(--color-selection)}
.opt{margin:0 0 6px;font-size:12px;color:color-mix(in srgb,var(--color-content) 55%,transparent)}
.opt b{color:var(--color-content);font-weight:600}
.win{display:flex;height:760px;border:1px solid var(--color-stroke);border-radius:10px;overflow:hidden;background:var(--color-background-base);margin-bottom:28px}
.side{width:216px;flex:none}
.brand{width:11px;height:13px;border-radius:4px 5px 3px 5px;background:var(--color-content);display:inline-block}
.nav.on{background:var(--color-selection);color:var(--color-content)}
.pg,.results{display:none}.pg.on,.results.on{display:block}
.tgl{cursor:pointer}
*{box-shadow:none!important}
</style></head><body>
<div class="bar">
  <button id="theme">Switch to light</button>
  <span>Click a section, or type in Search settings. Toggles toggle. Flat, theme colours only.</span>
</div>
<p class="opt"><b>Option A (recommended): Back at the sidebar foot</b>, where the gear was (ACH-D77, as today). The PodCode row stays at the top; "Settings" heads the list.</p>
${windowHtml('A')}
<p class="opt"><b>Option B: Back beside the Settings title at the top</b>, as in the reference. The foot is empty; the window's top-left reads "&larr; Settings".</p>
${windowHtml('B')}
<script>
const wins = [...document.querySelectorAll('.win')];
function show(win, id) {
  win.querySelectorAll('.nav').forEach(b => b.classList.toggle('on', b.dataset.page === id));
  win.querySelectorAll('.pg').forEach(p => p.classList.toggle('on', p.dataset.page === id));
  win.querySelector('.results').classList.remove('on');
  win.querySelector('.q').value = '';
}
function find(win, q) {
  q = q.trim().toLowerCase();
  if (!q) { show(win, win.dataset.last || 'messaging'); return; }
  win.querySelectorAll('.pg').forEach(p => p.classList.remove('on'));
  win.querySelectorAll('.nav').forEach(b => b.classList.remove('on'));
  const hits = win.querySelector('.hits'); hits.replaceChildren();
  let n = 0;
  win.querySelectorAll('.pg').forEach(p => {
    const rows = [...p.querySelectorAll('.settings-row')].filter(r => r.dataset.search.includes(q));
    if (!rows.length) return;
    n += rows.length;
    const sec = document.createElement('section'); sec.className = 'pt-8 first:pt-0';
    const hd = document.createElement('h2'); hd.className = 'pb-2.5 text-[13px] font-semibold text-content'; hd.textContent = p.querySelector('h1').textContent;
    const card = document.createElement('div'); card.className = 'overflow-hidden rounded-xl border border-content/10 bg-content/3';
    rows.forEach(r => card.appendChild(r.cloneNode(true)));
    sec.append(hd, card);
    hits.appendChild(sec);
  });
  win.querySelector('.none').classList.toggle('hidden', n > 0);
  win.querySelector('.results').classList.add('on');
}
wins.forEach(win => {
  win.querySelectorAll('.nav').forEach(b => b.onclick = () => { win.dataset.last = b.dataset.page; show(win, b.dataset.page); });
  win.querySelector('.q').oninput = e => find(win, e.target.value);
  win.addEventListener('click', e => { const t = e.target.closest('.tgl'); if (!t || t.disabled) return; const on = t.getAttribute('aria-checked') !== 'true'; t.setAttribute('aria-checked', on); t.classList.toggle('bg-accent', on); t.classList.toggle('bg-content/20', !on); const k = t.firstChild; k.classList.toggle('left-4.5', on); k.classList.toggle('left-0.5', !on); });
  show(win, 'messaging');
});
const b = document.getElementById('theme');
b.onclick = () => { const l = document.documentElement.classList.toggle('theme-light'); b.textContent = l ? 'Switch to dark' : 'Switch to light'; };
window.demo = (page, light, query) => { document.documentElement.classList.toggle('theme-light', Boolean(light)); wins.forEach(w => { w.dataset.last = page; show(w, page); if (query) { w.querySelector('.q').value = query; find(w, query); } }); return 'ok'; };
if (location.hash === '#light') b.click();
</script></body></html>`;

const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'settings-layout-demo.html');
fs.writeFileSync(out, html);
console.log('wrote', out, Math.round(html.length / 1024), 'KB');
