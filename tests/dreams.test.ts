import assert from 'node:assert/strict';
import test from 'node:test';
import {
  averageText, baselineMissing, comparable, compare, costText, countsText, dreamCounts, lineDiff, MIN_DREAMS, MIN_SESSIONS, opText, percentText,
  rate, readiness, rejectedText, sparkPath, sparkPoints, trend, undoState, type OpLike, type StatsLike,
} from '../web/dreams.ts';

const op = (o: Partial<OpLike> & Pick<OpLike, 'op'>): OpLike => ({ result: 'applied', ...o });

test('a dream counts only the ops it applied', () => {
  const counts = dreamCounts([
    op({ op: 'add', text: 'a' }),
    op({ op: 'add', text: 'b' }),
    op({ op: 'remove', ids: ['x'] }),
    op({ op: 'merge', ids: ['y', 'z'], text: 'c' }),
    op({ op: 'update', ids: ['w'], text: 'd', result: 'rejected' }),
  ]);
  assert.deepEqual(counts, { added: 2, removed: 1, updated: 1 });
  assert.equal(countsText(counts), '+2 -1 ~1');
  assert.equal(countsText({ added: 0, removed: 3, updated: 0 }), '-3');
  assert.equal(countsText({ added: 0, removed: 0, updated: 0 }), 'no changes');
});

test('ops read as one line each', () => {
  assert.equal(opText(op({ op: 'add', ids: [], text: 'Never use emojis.' })), 'Add: Never use emojis.');
  assert.equal(opText(op({ op: 'merge', ids: ['3f2a9c1d', 'b71e04aa'], text: 'Run tests first.' })), 'Merge 3f2a9c1d, b71e04aa: Run tests first.');
  assert.equal(opText(op({ op: 'remove', ids: ['3f2a9c1d'] })), 'Remove 3f2a9c1d');
});

test('only the latest dream that changed memory can be undone', () => {
  const dreams = [
    { id: 'd3', status: 'applied', ops: [op({ op: 'add' })] },
    { id: 'd2', status: 'applied', ops: [op({ op: 'add' })] },
    { id: 'd1', status: 'rolled-back', ops: [op({ op: 'remove' })] },
  ];
  assert.deepEqual(undoState(dreams, 'd3'), { can: true });
  assert.deepEqual(undoState(dreams, 'd2'), { can: false, why: 'A later dream changed memory since.' });
  assert.deepEqual(undoState(dreams, 'd1'), { can: false, why: 'It changed nothing.' });
  assert.deepEqual(undoState([{ ...dreams[0], undoneAt: 1 }], 'd3'), { can: false, why: 'Already undone.' });
  assert.deepEqual(undoState([{ id: 'd4', status: 'applied', ops: [op({ op: 'add', result: 'rejected' })] }], 'd4'), { can: false, why: 'It changed nothing.' });
  assert.deepEqual(undoState(dreams, 'gone'), { can: false, why: 'This dream is gone.' });
  // Later dreams that changed nothing, failed, were rolled back, were undone, or only proposed a soul change do not block it.
  const later = [
    { id: 'd9', status: 'failed', ops: [] },
    { id: 'd8', status: 'nothing', ops: [op({ op: 'add', result: 'rejected' })] },
    { id: 'd7', status: 'rolled-back', ops: [op({ op: 'add' })] },
    { id: 'd6', status: 'applied', undoneAt: 5, ops: [op({ op: 'add' })] },
    { id: 'd5', status: 'applied', ops: [] },
    { id: 'd4', status: 'applied', ops: [op({ op: 'merge', ids: ['a', 'b'] })] },
  ];
  assert.deepEqual(undoState(later, 'd4'), { can: true });
});

test('better or worse needs three sessions on each side', () => {
  assert.equal(MIN_SESSIONS, 3);
  assert.deepEqual(comparable(stats({ sessions: 3 }), stats({ sessions: 3 })), { can: true });
  const one = comparable(stats({ sessions: 8 }), stats({ sessions: 1 }));
  assert.equal(one.can, false);
  assert.match(!one.can ? one.why : '', /needs 3 sessions on each side \(8 with dreaming, 1 with it off\)/);
  assert.equal(comparable(stats({ sessions: 2 }), stats({ sessions: 9 })).can, false);
  assert.equal(comparable(undefined, stats({ sessions: 9 })).can, false);
});

test('the soul diff keeps common lines and marks the rest', () => {
  const before = 'You are Fen.\nRead the diff first.\nBe brief.\n';
  const after = 'You are Fen.\nRead the diff and the tests first.\nBe brief.\nSay how you checked it.';
  assert.deepEqual(lineDiff(before, after), [
    { kind: 'same', text: 'You are Fen.' },
    { kind: 'del', text: 'Read the diff first.' },
    { kind: 'add', text: 'Read the diff and the tests first.' },
    { kind: 'same', text: 'Be brief.' },
    { kind: 'add', text: 'Say how you checked it.' },
  ]);
  assert.deepEqual(lineDiff('', 'New soul.'), [{ kind: 'add', text: 'New soul.' }]);
  assert.deepEqual(lineDiff('Old soul.', ''), [{ kind: 'del', text: 'Old soul.' }]);
});

test('numbers with nothing behind them read as n/a', () => {
  assert.equal(rate(1, 0), null);
  assert.equal(rate(1, 4), 0.25);
  assert.equal(percentText(0.123), '12%');
  assert.equal(percentText(null), 'n/a');
  assert.equal(averageText(5 / 3), '1.7');
  assert.equal(averageText(null), 'n/a');
  assert.equal(costText(0), '$0');
  assert.equal(costText(0.004), '<$0.01');
  assert.equal(costText(1.234), '$1.23');
  assert.equal(rejectedText({ 'unknown entry': 1, 'no user evidence': 3, secret: 0 }), '3 no user evidence, 1 unknown entry');
  assert.equal(rejectedText({}), '');
});

test('a trend needs three sessions and compares the last third with the first', () => {
  assert.equal(trend([3, 2]), null);
  assert.equal(trend([4, 3, 3, 2, 1, 1]), 'falling');
  assert.equal(trend([0, 1, 1, 2, 3, 3]), 'rising');
  assert.equal(trend([2, 2, 2.1, 2]), 'flat');
});

test('comparing with dreaming off knows which way is better', () => {
  assert.equal(compare(0.1, 0.3, true), 'better');
  assert.equal(compare(0.3, 0.1, true), 'worse');
  assert.equal(compare(0.8, 0.5, false), 'better');
  assert.equal(compare(0.21, 0.2, true), 'same');
  assert.equal(compare(null, 0.2, true), null);
});

test('sparklines fit their box, oldest on the left, flat series in the middle', () => {
  const points = sparkPoints([0, 2, 1], 100, 20, 2);
  assert.deepEqual(points, [{ x: 2, y: 18 }, { x: 50, y: 2 }, { x: 98, y: 10 }]);
  assert.equal(sparkPath(points), 'M2.0 18.0 L50.0 2.0 L98.0 10.0');
  assert.deepEqual(sparkPoints([3, 3], 100, 20).map(p => p.y), [10, 10]);
  assert.deepEqual(sparkPoints([5], 100, 20), [{ x: 50, y: 10 }]);
  assert.deepEqual(sparkPoints([], 100, 20), []);
});

const stats = (s: Partial<StatsLike>): StatsLike => ({ dreams: 0, corrections: 0, sessions: 0, rejectedByReason: {}, ...s });

test('too little data says so instead of showing numbers', () => {
  assert.equal(readiness(undefined).dreams, false);
  assert.match(readiness(stats({ dreams: 0 })).why!, /No dreams yet/);
  const two = readiness(stats({ dreams: MIN_DREAMS - 1 }));
  assert.equal(two.dreams, false);
  assert.match(two.why!, /Only 2 dreams so far.*after 3/);
  const fewCorrections = readiness(stats({ dreams: 4, corrections: 3 }));
  assert.deepEqual([fewCorrections.dreams, fewCorrections.corrections], [true, false]);
  assert.match(fewCorrections.why!, /Only 3 corrections so far/);
  assert.deepEqual(readiness(stats({ dreams: 4, corrections: 5 })), { dreams: true, corrections: true });
});

test('no session with dreaming off means no baseline', () => {
  assert.match(baselineMissing(undefined)!, /nothing to compare against/);
  assert.match(baselineMissing(stats({ sessions: 0 }))!, /Turn dreaming off for one agent/);
  assert.equal(baselineMissing(stats({ sessions: 4 })), undefined);
});

test('readiness counts the corrections the dreams judged, not the per-session counts from code', () => {
  // Plenty of corrections counted from transcripts, but the dreams judged only two: too few for a repeat rate.
  const judged = { ...stats({ dreams: 6, corrections: 2, sessions: 3 }), correctionsPerSession: [5, 5, 5] } as StatsLike;
  const ready = readiness(judged);
  assert.deepEqual([ready.dreams, ready.corrections], [true, false]);
  assert.match(ready.why!, /^Only 2 corrections so far/);
  assert.match(readiness(stats({ dreams: 6, corrections: 1 })).why!, /^Only 1 correction so far/);
  assert.equal(readiness(stats({ dreams: 6, corrections: 5 })).corrections, true);
});

test('a ratio with nothing behind it reads n/a, never NaN or 0%', () => {
  for (const missing of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(percentText(missing), 'n/a');
    assert.equal(averageText(missing), 'n/a');
  }
  assert.equal(percentText(rate(0, 0)), 'n/a', 'no corrections yet is not 0%');
  assert.equal(percentText(0), '0%', 'a real zero stays 0%');
  assert.equal(percentText(rate(0, 4)), '0%');
  assert.equal(averageText(0), '0');
});
