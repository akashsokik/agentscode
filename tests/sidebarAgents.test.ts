import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { AVATAR_SHAPES } from '../shared/avatar.ts';
import { compactAgo } from '../web/panelList.ts';
import { agentRowSlot } from '../web/sidebar/agentRail.ts';
import { AVATAR_BOUNDS, avatarFit, avatarFitTransform } from '../web/ui/avatarFit.ts';

// The sidebar's Agents list (ACH-49): one aligned slot at the right, bold for unread only, one avatar size.

const NOW = Date.UTC(2026, 10, 14, 12, 0);
const ago = (ms: number) => NOW - ms;

test('a time in one unit, so the column lines up: now, 5m, 2h, 1d', () => {
  assert.equal(compactAgo(ago(20_000), NOW), 'now');
  assert.equal(compactAgo(ago(5 * 60_000), NOW), '5m');
  assert.equal(compactAgo(ago(126 * 60_000), NOW), '2h', 'not "2h 6m"');
  assert.equal(compactAgo(ago(26 * 3_600_000), NOW), '1d');
  assert.equal(compactAgo(NOW + 60_000, NOW), 'now', 'a clock a little ahead is now');
});

test('the slot: a status mark while it needs you, works or failed; otherwise the time, with words for each', () => {
  const words = (ts: number) => `${Math.round((NOW - ts) / 60_000)} min`;
  const at = { lastActiveAt: ago(10 * 60_000), turnStartedAt: ago(3 * 60_000) };
  assert.deepEqual(agentRowSlot({ ...at, status: 'idle' }, true, words), { state: 'warn', words: 'Needs you' }, 'an approval waiting wins');
  assert.deepEqual(agentRowSlot({ ...at, status: 'waiting' }, false, words), { state: 'warn', words: 'Needs you' });
  assert.deepEqual(agentRowSlot({ ...at, status: 'working' }, false, words), { state: 'pending', words: 'Working for 3 min' });
  assert.deepEqual(agentRowSlot({ ...at, status: 'error' }, false, words), { state: 'fail', words: 'Failed' });
  assert.deepEqual(agentRowSlot({ ...at, status: 'done' }, false, words), { state: null, words: 'Active 10 min ago' });
});

test('every shape has bounds, and fitting brings each toward one size, centred, by a tenth at most', () => {
  assert.deepEqual(Object.keys(AVATAR_BOUNDS).sort(), [...AVATAR_SHAPES].sort());
  for (const shape of AVATAR_SHAPES) {
    const { scale, cx, cy } = avatarFit(shape);
    assert.ok(scale >= 0.9 && scale <= 1.1, `${shape} ${scale}`);
    const [x, y, w, h] = AVATAR_BOUNDS[shape];
    assert.ok(Math.abs(cx - (x + w / 2)) < 0.01 && Math.abs(cy - (y + h / 2)) < 0.01);
    // Fitted, the shape stays inside the 32px grid.
    assert.ok(w * scale <= 32 && h * scale <= 32, shape);
  }
  const mass = (s: (typeof AVATAR_SHAPES)[number]) => { const [, , w, h] = AVATAR_BOUNDS[s]; return Math.sqrt(w * h) * avatarFit(s).scale; };
  assert.ok(Math.abs(mass('bean') - mass('slice')) < Math.abs(Math.sqrt(27.37 * 19.84) - Math.sqrt(26.75 * 28.7)), 'the small and the big end nearer each other');
  assert.equal(avatarFitTransform('tile'), `translate(16 16) scale(${avatarFit('tile').scale}) translate(-15.95 -16)`);
});

test('the Agents row: the fitted avatar, bold only when unread, no dot, one slot of StatusMark or time, rows of 30px', () => {
  const src = fs.readFileSync(new URL('../web/sidebar/Sidebar.tsx', import.meta.url), 'utf8');
  const row = src.slice(src.indexOf('function AgentRailRow('), src.indexOf('function ChannelRailRow('));
  assert.match(row, /<AgentAvatar agent=\{agent\} fit className="size-5" \/>/);
  assert.match(row, /agent\.unread \? 'font-semibold text-content' : 'font-normal'/);
  assert.doesNotMatch(row, /UnreadDot|TerminalSpinner|AgentStateMark/, 'no dot, no spinner of its own');
  assert.match(row, /\{slot\.state \? <StatusMark state=\{slot\.state\} label=\{slot\.words\}/);
  assert.match(row, /compactAgo\(agent\.lastActiveAt, now\)/);
  assert.match(row, /flex h-5 w-6 shrink-0 items-center justify-end/, 'one fixed slot, right-aligned');
  assert.match(src, /'flex h-\[30px\] w-full min-w-0 items-center gap-2 rounded-md px-2 text-left/, 'every sidebar row a touch tighter');
});

test('the slot never moves: the row keeps one padding in every state, and the slot only goes invisible under the ... button (ACH-52)', () => {
  const src = fs.readFileSync(new URL('../web/sidebar/Sidebar.tsx', import.meta.url), 'utf8');
  const row = src.slice(src.indexOf('function AgentRailRow('), src.indexOf('function ChannelRailRow('));
  assert.match(row, /className=\{cx\(railSlotRow\(\), railRowState\(selected \|\| Boolean\(menu\)\)\)\}/, 'not railRow: its group-hover/focus-within pr-7 shifted the slot');
  const fixed = src.slice(src.indexOf('function railSlotRow('), src.indexOf('function railRowState('));
  assert.doesNotMatch(fixed, /pr-7|group-hover|group-focus-within|padding/, 'no padding that changes with hover or focus');
  assert.match(row, /flex h-5 w-6 shrink-0 items-center justify-end leading-none group-hover:invisible group-has-\[\[data-card-more\]:focus-visible\]:invisible', menu && 'invisible'/, 'the slot keeps its 24px under the ... button');
  assert.doesNotMatch(row, /group-hover:hidden/);
});

test('a project card wraps its crowded header rather than pushing status past the edge (ACH-53)', () => {
  const src = fs.readFileSync(new URL('../web/sidebar/Sidebar.tsx', import.meta.url), 'utf8');
  const card = src.slice(src.indexOf('function AgentCard('), src.indexOf('function TreeNode('));
  assert.match(card, /className="flex min-w-0 flex-wrap items-center gap-x-1\.5 gap-y-0\.5"/,
    'the name, role and non-shrinking queue/status cluster need another line when they cannot fit');
  assert.doesNotMatch(card, /overflow-hidden|overflow-x-hidden/, 'do not conceal an over-wide header');
});
