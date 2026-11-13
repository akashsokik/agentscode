import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { STATUS_MARKS, statusTone, statusWord, statusWordsTone, type StatusState } from '../web/ui/statusMarks.ts';

// ACH-D45: one status mark in MonoCode's style (InboxPrChecks checkMark), never a bare tick or cross.

test('each state uses MonoCode\'s circled glyph and the theme colour', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(STATUS_MARKS).map(([s, m]) => [s, m.glyph])), {
    pass: 'CheckCircle', fail: 'CircleX', pending: 'LoaderCircle', cancel: 'Minus', skip: 'CircleDashed', unknown: 'CircleHelp', warn: 'AlertCircle',
  });
  assert.equal(STATUS_MARKS.pass.tone, 'text-success');
  assert.equal(STATUS_MARKS.fail.tone, 'text-danger');
  assert.match(STATUS_MARKS.pending.tone, /animate-spin/);
  for (const m of Object.values(STATUS_MARKS)) assert.ok(!['Check', 'X', 'CheckCheck'].includes(m.glyph as string), 'never a bare tick, cross or double tick');
});

test('quiet drops the colour but keeps the glyph; words colour only failures and warnings', () => {
  assert.equal(statusTone('pass', true), 'text-content/40');
  assert.match(statusTone('pending', true), /animate-spin/);
  assert.equal(statusWordsTone('fail'), 'text-danger');
  assert.equal(statusWordsTone('warn'), 'text-warning');
  assert.equal(statusWordsTone('pass'), 'text-content/55');
  assert.equal(statusWord('pending' as StatusState), 'In progress');
});

test('the status places listed for ACH-D45 use the shared mark, not a bare tick or cross', () => {
  const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const pr = read('web/prs/PullRequestsPane.tsx');
  assert.doesNotMatch(pr, /icon: (Check|X)\b/);
  assert.match(pr, /<StatusMark state=\{state\}/);
  assert.doesNotMatch(read('web/panes/CommsPane.tsx'), /CheckCheck, className/, 'handled is no longer a double tick');
  assert.match(read('web/panes/CommsPane.tsx'), /node=\{<StatusMark state="warn" \/>\}/, 'the used-up message budget is the warn mark');
  assert.doesNotMatch(read('web/panes/CommsPane.tsx'), /AlertCircle/);
  assert.doesNotMatch(read('web/panes/Transcript.tsx'), /<X className="size-3.5 shrink-0 text-danger"/);
  assert.match(read('web/panes/PeerMessages.tsx'), /<StatusMark state=\{TONE_STATE\[tone\]\}/);
  assert.match(read('web/App.tsx'), /<StatusMark state=\{t.tone === 'error' \? 'fail' : 'pass'\}/);
});
