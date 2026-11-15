// ACH-55 demo (ACH-D71): Settings as a full-screen page, with the left sidebar turning into the
// settings section navigation and back. Builds settings-demo.html next to this file: one standalone
// page with the app's compiled CSS inlined (theme tokens and the exact class strings of RailAction,
// HeaderButton, Group, Row, Segmented and Toggle), and the app's hugeicons at stroke 1.75.
// Usage: node docs/demos/ACH-55/build.mts <path to the app's compiled styles-*.css>
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HugeiconsIcon } from '@hugeicons/react';
import fs from 'node:fs';
import path from 'node:path';

const lib = await import('@hugeicons/core-free-icons') as Record<string, unknown>;
const icon = (n: string, cls = 'size-4 shrink-0 opacity-70') => renderToStaticMarkup(h(HugeiconsIcon, { icon: lib[n], strokeWidth: 1.75, className: cls, 'aria-hidden': true } as never));
const css = fs.readFileSync(process.argv[2], 'utf8');

// --- The normal sidebar (NavRail): RailAction rows, sections, and the foot row ---------------------
const railAction = (ic: string, label: string, opts: { active?: boolean; hint?: string; count?: number } = {}) =>
  `<button type="button" class="relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 ${opts.active ? 'bg-selection text-content' : 'text-content/75 hover:bg-content/10 hover:text-content'}">${ic}<span class="min-w-0 flex-1 truncate text-sm font-medium leading-tight">${label}</span>${opts.count ? `<span class="text-[12px] text-content/40 tabular-nums">${opts.count}</span>` : ''}${opts.hint ? `<kbd class="inline-flex shrink-0 items-center whitespace-nowrap font-sans text-[11px] leading-4 text-content/40">${opts.hint}</kbd>` : ''}</button>`;
const blob = (c: string) => `<span class="blob" style="background:${c}"><i></i><i></i></span>`;
const railRow = (lead: string, label: string, end = '') =>
  `<div class="flex h-[30px] w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-content/65"><span class="lead">${lead}</span><span class="min-w-0 flex-1 truncate text-sm font-medium">${label}</span>${end}</div>`;
const section = (title: string, n: number, rows: string) =>
  `<div class="mt-3"><div class="flex h-7 items-center gap-1.5 px-2 text-[12px] font-medium text-content/45"><span>${title}</span><span class="text-content/30">${n}</span><span class="flex-1"></span>${icon('Add01Icon', 'size-3.5 opacity-60')}</div>${rows}</div>`;
const time = (t: string) => `<span class="text-[11px] text-content/35 tabular-nums">${t}</span>`;
const headerButton = (ic: string, label: string, id = '') =>
  `<button type="button" ${id ? `id="${id}"` : ''} title="${label}" aria-label="${label}" class="grid size-[30px] shrink-0 place-items-center rounded-md transition-[color,background-color,opacity] duration-150 hover:bg-content/8 hover:text-content text-content/45">${icon(ic, 'size-3.5')}</button>`;

const navMain = `
<div class="flex min-h-0 flex-1 flex-col gap-px overflow-hidden px-2 pt-1">
  ${railAction(icon('Add01Icon'), 'New agent', { hint: '⌘N' })}
  <div class="h-1.5"></div>
  ${railAction(icon('MessageMultiple01Icon'), 'Comms', { active: true })}
  ${railAction(icon('CircleDashedIcon'), 'Issues', { count: 3 })}
  ${railAction(icon('GitPullRequestIcon'), 'Pull requests', { count: 22 })}
  ${railAction(blob('#7c5ce0'), 'SuperAgent', { hint: '⇧⌘Space' })}
  ${section('Channels', 1, railRow('<span class="hash">#</span>', 'issues-ux'))}
  ${section('Agents', 5, [['Ada', '#d9a03a', '1d'], ['Cy', '#8fa83f', 'now'], ['Fen', '#d9773a', '1d'], ['Hal', '#a8457a', '2d'], ['Rhea', '#5d6e94', '1d']].map(([n, c, t]) => railRow(blob(c), n, time(t))).join(''))}
  ${section('Projects', 3, ['agent-comms-harness', 'orcabox', 'orca-site'].map(p => railRow(icon('Folder01Icon', 'size-4 shrink-0 opacity-60'), p)).join(''))}
</div>
<div class="flex shrink-0 items-center gap-0.5 px-2 pb-2 pt-1.5">
  <button type="button" class="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium text-content/70 transition-colors duration-150 hover:bg-content/10 hover:text-content">${icon('Note01Icon')}<span class="min-w-0 flex-1 truncate">About you</span></button>
  ${headerButton('Settings01Icon', 'Settings (⌘,)', 'gear')}
  ${headerButton('LayoutAlignLeftIcon', 'Collapse navigation')}
</div>`;

// --- The settings navigation: the same RailAction rows, Back at the foot where the gear was --------
const SECTIONS = [
  ['appearance', 'Appearance', 'PaintBoardIcon'],
  ['comms', 'Agent communication', 'MessageMultiple01Icon'],
  ['super', 'SuperAgent', 'SparklesIcon'],
  ['engines', 'Engines', 'BotIcon'],
  ['about', 'About', 'InformationCircleIcon'],
] as const;
const navSettings = `
<div class="flex min-h-0 flex-1 flex-col gap-px overflow-hidden px-2 pt-1" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
  <div class="px-2 pb-1 pt-1 text-xs font-semibold text-content/35">Settings</div>
  ${SECTIONS.map(([id, label, ic], i) => `<button type="button" role="tab" data-section="${id}" class="sec relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 text-content/75 hover:bg-content/10 hover:text-content">${icon(ic)}<span class="min-w-0 flex-1 truncate text-sm font-medium leading-tight">${label}</span><kbd class="inline-flex shrink-0 items-center whitespace-nowrap font-sans text-[11px] leading-4 text-content/40">⌘${i + 1}</kbd></button>`).join('')}
</div>
<div class="flex shrink-0 items-center gap-0.5 px-2 pb-2 pt-1.5">
  <button type="button" id="back" class="relative flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 text-content/75 hover:bg-content/10 hover:text-content">${icon('ArrowLeft01Icon')}<span class="min-w-0 flex-1 truncate text-sm font-medium leading-tight">Back</span><kbd class="inline-flex shrink-0 items-center whitespace-nowrap font-sans text-[11px] leading-4 text-content/40">Esc</kbd></button>
</div>`;

// --- The workspace the settings page covers: tab strip, Comms, the right panel ---------------------
const convo = (who: string, title: string, state: string) =>
  `<div class="px-3 py-2.5"><div class="text-[12px] text-content/45">${who}</div><div class="truncate text-[13px] font-medium text-content">${title}</div><div class="text-[12px] text-content/40">${state}</div></div>`;
const workspace = `
<div class="flex h-full min-w-0 flex-1 flex-col">
  <header class="flex h-10 shrink-0 items-stretch border-b border-stroke">
    <div class="flex items-center gap-1 px-1.5">${headerButton('ArrowLeft01Icon', 'Back')}${headerButton('ArrowRight01Icon', 'Forward')}</div>
    <div class="tab on">${icon('MessageMultiple01Icon', 'size-3.5 opacity-70')}<span>Comms</span></div>
    <div class="tab">${icon('CircleDashedIcon', 'size-3.5 opacity-70')}<span>Issues</span></div>
    <div class="flex-1"></div>
    <div class="flex items-center px-1.5">${headerButton('LayoutAlignRightIcon', 'Toggle panel')}</div>
  </header>
  <div class="flex min-h-0 flex-1">
    <div class="list border-r border-stroke">
      <div class="flex h-9 items-center gap-1 px-2 text-[12px]"><span class="seg on">All</span><span class="seg">Active</span><span class="seg">Attention</span></div>
      ${convo('SuperAgent, Cy', 'Settings: full-screen page with sidebar animation', 'Working · ACH-55')}
      ${convo('SuperAgent, Ada', 'Back and Forward through focused tabs', 'Done · ACH-31')}
      ${convo('SuperAgent, Fen, Cy', 'The user approved demo v2 (ACH-D43)', 'Stopped')}
      ${convo('SuperAgent, Hal', 'Read permissions by path', 'Done · ACH-47')}
    </div>
    <div class="min-w-0 flex-1 px-8 py-6">
      <div class="text-[18px] font-semibold text-content">Settings: full-screen page with sidebar animation</div>
      <div class="mt-4 space-y-3 text-[13px] text-content/70">
        <p><b class="text-content">SuperAgent</b> <span class="text-content/40">to</span> <b class="text-content">Cy</b> · Implementation</p>
        <p>Phase 1, demo only: Settings as a full-screen page, with the left sidebar animating into the settings section navigation and back.</p>
        <p class="text-content/40">Cy is working…</p>
      </div>
    </div>
  </div>
</div>
<aside class="right border-l border-stroke">
  <div class="flex h-10 items-center gap-2 border-b border-stroke px-3 text-[12px] font-medium text-content/70">${icon('Folder01Icon', 'size-3.5 opacity-60')}Files</div>
  <div class="space-y-1.5 px-3 py-3 text-[12px] text-content/55"><div>web/</div><div class="pl-3">App.tsx</div><div class="pl-3">layout.ts</div><div class="pl-3">sidebar/</div><div class="pl-3">dialogs/</div><div>shared/</div><div>server/</div></div>
</aside>`;

// --- The settings page: today's Settings groups, one per section, with the real Group/Row look ----
const group = (title: string, description: string, rows: string) =>
  `<section class="pt-0"><div class="flex items-end gap-4 pb-2.5"><div class="min-w-0 flex-1"><h2 class="text-[13px] font-semibold text-content">${title}</h2>${description ? `<p class="mt-1 text-[12px] leading-relaxed text-content/45">${description}</p>` : ''}</div></div><div class="overflow-hidden rounded-xl border bg-content/3 border-content/10">${rows}</div></section>`;
const row = (label: string, description: string, control: string) =>
  `<div class="settings-row flex items-start gap-6 border-b border-content/5 px-4 py-3.5 last:border-b-0"><div class="min-w-0 flex-1"><div class="text-[13px] font-medium text-content">${label}</div>${description ? `<p class="mt-1 text-[12px] leading-relaxed text-content/45">${description}</p>` : ''}</div><div class="settings-row-control flex min-w-0 max-w-[60%] shrink-0 flex-wrap items-center justify-end gap-2">${control}</div></div>`;
const segmented = (opts: string[], on: number) =>
  `<div role="radiogroup" class="inline-grid max-w-full shrink-0 gap-0.5 rounded-md border border-content/10 p-0.5 text-[12px]" style="grid-template-columns:repeat(${opts.length},minmax(0,1fr))">${opts.map((o, i) => `<button type="button" role="radio" aria-checked="${i === on}" class="min-w-0 rounded-[5px] px-2.5 py-1 transition-colors duration-150 ${i === on ? 'segmented-active bg-selection text-content' : 'text-content/50 hover:bg-content/5 hover:text-content'}">${o}</button>`).join('')}</div>`;
const toggle = (on: boolean) =>
  `<button type="button" role="switch" aria-checked="${on}" class="relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 ${on ? 'bg-accent' : 'bg-content/20 hover:bg-content/25'}"><span class="absolute top-0.5 size-4 rounded-full bg-white ${on ? 'left-4.5' : 'left-0.5'}"></span></button>`;
const num = (v: string) => `<span class="numbox">${v}</span>`;
const PAGES: Record<string, string> = {
  appearance: group('Appearance', '', row('Theme', '', segmented(['Dark', 'Light', 'System'], 0)) + row('Avatars', 'Colour gives every agent its own colour. Ink draws them all, the SuperAgent included, in the theme\'s text colour.', segmented(['Colour', 'Ink'], 0))),
  comms: group('Agent communication', 'How agents see and message each other.', row('Who can agents message?', 'Replies to messages they received always go through, and channel members can always reach each other in their channel.', segmented(['Nobody', 'Same project', 'All projects'], 2)) + row('Message budget', 'Messages per collaboration, replies and hand-offs included. 0 means unlimited.', num('12')) + row('Share current tasks', 'list_agents includes each agent\'s task summary and activity.', toggle(true)) + row('Start tasks with a team snapshot', 'Agents see who is working on what before they begin.', toggle(true)) + row('Browser scripts', 'Let agents run their own JavaScript in their browser tabs (browser_eval). Plan-only agents never can.', toggle(false))),
  super: group('SuperAgent', 'It runs your team across every project. It never edits code; agents do the work.', row('Wake it when agents finish, fail or get stuck', 'Updates are batched into one turn, and only sent while it is idle.', toggle(true)) + row('Wake-ups an hour', 'Past this, updates wait for the next hour.', num('6')) + row('Daily budget', 'Dollars a day it may spend on wake-ups. 0 means no cap.', num('10')) + row('Quiet hours', 'No wake-ups and no notifications between these times.', `${num('23:00')}<span class="text-[12px] text-content/45">to</span>${num('07:00')}`)),
  engines: group('Engines', '', ['Claude Code', 'Codex', 'OrcaCode'].map((e, i) => row(e, `v${['2.4.1', '0.98.0', '1.3.0'][i]} on PATH`, `<span class="text-[12px] text-content/45">${[7, 5, 3][i]} models</span>`)).join('')),
  about: group('About', '', row('PodCode', 'Version 0.9 · build 59fbc48', '') + row('Updates', 'Checks for a new build when the app starts.', toggle(true))),
};
const page = `
<div class="flex h-full min-w-0 flex-1 flex-col">
  <header class="flex h-10 shrink-0 items-center gap-1.5 border-b border-stroke px-4 text-[13px]"><span class="text-content/45">Settings</span><span class="text-content/30">/</span><span id="crumb" class="font-medium text-content">Appearance</span></header>
  <div class="min-h-0 flex-1 overflow-hidden"><div class="mx-auto px-8 py-8" style="max-width:720px">${Object.entries(PAGES).map(([id, html]) => `<div class="pg" data-page="${id}">${html}</div>`).join('')}</div></div>
</div>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ACH-55 Settings: full-screen page with sidebar animation</title>
<style>${css}</style>
<style>
html,body{margin:0;height:100%}
body{background:var(--color-background-base);color:var(--color-content);font:13px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;display:flex;flex-direction:column}
.bar{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12px;border-bottom:1px solid var(--color-stroke);color:color-mix(in srgb,var(--color-content) 60%,transparent)}
.bar button{border:0;border-radius:6px;padding:4px 8px;font-size:12px;background:color-mix(in srgb,var(--color-content) 8%,transparent);color:var(--color-content)}
.bar label{display:flex;align-items:center;gap:4px}
.bar .stat{margin-left:auto;font-variant-numeric:tabular-nums}
.app{position:relative;display:flex;flex:1;min-height:0;overflow:hidden}
.side{position:relative;width:248px;flex:none;display:flex;flex-direction:column}
.brand{height:40px;display:flex;align-items:center;gap:8px;padding:0 14px;font-weight:600;font-size:13px;flex:none}
.brand i{width:12px;height:14px;border-radius:5px 6px 4px 6px;background:var(--color-content);display:inline-block}
.layers{position:relative;flex:1;min-height:0}
.layer{position:absolute;inset:0;display:flex;flex-direction:column;will-change:opacity,transform}
.blob{position:relative;width:16px;height:16px;border-radius:7px 9px 6px 8px;flex:none;display:inline-flex;align-items:center;justify-content:center;gap:2px}
.blob i{width:2.5px;height:6px;border-radius:2px;background:#141414;display:block}
.lead{display:inline-grid;place-items:center;width:16px;flex:none}
.hash{color:color-mix(in srgb,var(--color-content) 45%,transparent);font-size:14px}
.main{position:relative;flex:1;min-width:0;display:flex}
.work,.settings{position:absolute;inset:0;display:flex;will-change:opacity,transform;background:var(--color-background-base)}
.tab{display:flex;align-items:center;gap:6px;padding:0 12px;font-size:13px;color:color-mix(in srgb,var(--color-content) 55%,transparent)}
.tab.on{color:var(--color-content);background:color-mix(in srgb,var(--color-content) 5%,transparent)}
.list{width:300px;flex:none}
.seg{padding:3px 10px;border-radius:5px;color:color-mix(in srgb,var(--color-content) 50%,transparent)}
.seg.on{background:var(--color-selection);color:var(--color-content)}
.right{width:240px;flex:none}
.numbox{display:inline-block;min-width:56px;padding:4px 8px;border-radius:6px;border:1px solid color-mix(in srgb,var(--color-content) 12%,transparent);font-size:12px;font-variant-numeric:tabular-nums}
.pg{display:none}.pg.on{display:block}
.sec.on{background:var(--color-selection);color:var(--color-content)}
*{box-shadow:none!important}
</style></head><body>
<div class="bar">
  <button id="play">Play: open, then close</button>
  <button id="slow">Play at 1/8 speed</button>
  <button id="theme">Switch to light</button>
  <label><input type="checkbox" id="reduce"> Reduced motion (instant swap)</label>
  <span>Open: the gear, ⌘, or the palette. Close: Back, Esc, or ⌘[.</span>
  <span class="stat" id="stat">closed</span>
</div>
<div class="app">
  <nav class="side sidebar-glass border-r border-stroke" aria-label="PodCode">
    <div class="brand"><i></i>PodCode</div>
    <div class="layers">
      <div class="layer" id="navMain">${navMain}</div>
      <div class="layer" id="navSettings">${navSettings}</div>
    </div>
  </nav>
  <div class="main">
    <div class="work" id="work">${workspace}</div>
    <div class="settings" id="settings">${page}</div>
  </div>
</div>
<script>
const DURATION = 180; // ms, ease-out
const ease = t => 1 - Math.pow(1 - t, 3);
const clamp = v => Math.max(0, Math.min(1, v));
const $ = id => document.getElementById(id);
const navMain = $('navMain'), navSettings = $('navSettings'), work = $('work'), settings = $('settings');
let p = 0, target = 0, raf = 0, speed = 1, section = 'appearance';
const reduced = () => $('reduce').checked || matchMedia('(prefers-reduced-motion: reduce)').matches;

// One progress value drives every layer: 0 is the app, 1 is Settings. Only opacity and transform
// move; nothing changes width, so the sidebar and the panes never reflow mid-motion.
function render(v) {
  p = v;
  const out = clamp(v / 0.5), inn = clamp((v - 0.45) / 0.55);
  navMain.style.opacity = 1 - out; navMain.style.transform = 'translateX(' + (-12 * v) + 'px)';
  navSettings.style.opacity = inn; navSettings.style.transform = 'translateX(' + (12 * (1 - v)) + 'px)';
  work.style.opacity = 1 - out;
  settings.style.opacity = inn; settings.style.transform = 'translateY(' + (6 * (1 - v)) + 'px)';
  navMain.style.visibility = work.style.visibility = v >= 1 ? 'hidden' : 'visible';
  navSettings.style.visibility = settings.style.visibility = v <= 0 ? 'hidden' : 'visible';
  navMain.inert = work.inert = v > 0.5; navSettings.inert = settings.inert = v <= 0.5;
  $('stat').textContent = v <= 0 ? 'closed' : v >= 1 ? 'open: ' + section : 'moving ' + Math.round(v * 100) + '%';
}
function go(to, done) {
  target = to; cancelAnimationFrame(raf);
  if (reduced()) { render(to); done && done(); return; }
  const from = p, start = performance.now(), dur = DURATION * Math.abs(to - from) * speed;
  const step = now => {
    const t = dur ? clamp((now - start) / dur) : 1;
    render(from + (to - from) * ease(t));
    if (t < 1) raf = requestAnimationFrame(step); else done && done();
  };
  raf = requestAnimationFrame(step);
}
function select(id) {
  section = id;
  document.querySelectorAll('.sec').forEach(b => { const on = b.dataset.section === id; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
  document.querySelectorAll('.pg').forEach(g => g.classList.toggle('on', g.dataset.page === id));
  $('crumb').textContent = document.querySelector('.sec[data-section="' + id + '"] span').textContent;
  render(p);
}
const open = () => go(1, () => document.querySelector('.sec.on').focus({ preventScroll: true }));
const close = () => go(0, () => $('gear').focus({ preventScroll: true }));
$('gear').onclick = open; $('back').onclick = close;
document.querySelectorAll('.sec').forEach(b => b.onclick = () => select(b.dataset.section));
const ids = [...document.querySelectorAll('.sec')].map(b => b.dataset.section);
addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); target ? close() : open(); return; }
  if (!target) return;
  if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === '[') { e.preventDefault(); close(); return; }
  if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key) && ids[e.key - 1]) { e.preventDefault(); select(ids[e.key - 1]); return; }
  const i = ids.indexOf(section);
  if (document.activeElement && document.activeElement.classList.contains('sec')) {
    let n = null;
    if (e.key === 'ArrowDown') n = ids[(i + 1) % ids.length];
    if (e.key === 'ArrowUp') n = ids[(i - 1 + ids.length) % ids.length];
    if (e.key === 'Home') n = ids[0]; if (e.key === 'End') n = ids[ids.length - 1];
    if (n) { e.preventDefault(); select(n); document.querySelector('.sec.on').focus(); }
  }
});
const play = s => { speed = s; go(1, () => setTimeout(() => go(0, () => { speed = 1; }), 900)); };
$('play').onclick = () => play(1); $('slow').onclick = () => play(8);
$('theme').onclick = () => { const l = document.documentElement.classList.toggle('theme-light'); $('theme').textContent = l ? 'Switch to dark' : 'Switch to light'; };
// For still frames: window.frame(progress, section, light).
window.frame = (v, id, light) => { cancelAnimationFrame(raf); document.documentElement.classList.toggle('theme-light', Boolean(light)); select(id || 'appearance'); target = v > 0 ? 1 : 0; render(v); return 'frame ' + v; };
select('appearance'); render(0);
if (location.hash === '#light') $('theme').click();
</script></body></html>`;

const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'settings-demo.html');
fs.writeFileSync(out, html);
console.log('wrote', out, Math.round(html.length / 1024), 'KB');
