/** Actual hook lifecycle test; only the HTTP boundary and 15s timer are controlled. */
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Agent, AgentProduced } from '../../../../shared/types.ts';
import { useOverviewData } from '../../../../web/right/overviewData.ts';

const host = document.createElement('main'); document.body.append(host);
const root = createRoot(host);
const a = { id: 'a', name: 'Ellis', status: 'working', turns: 1 } as Agent;
const calls: string[] = [];
const timers = new Map<number, () => void>(); let timerId = 0;
window.setInterval = ((fn: () => void, ms: number) => {
  if (ms !== 15_000) throw new Error(`Unexpected timer ${ms}`);
  timers.set(++timerId, fn); return timerId;
}) as typeof window.setInterval;
window.clearInterval = (id: number | undefined) => { if (id !== undefined) timers.delete(id); };
const empty: AgentProduced = { at: 1, where: null, commits: [], uncommitted: null, walkthroughs: [], reports: [] };
globalThis.fetch = async url => { calls.push(String(url)); return new Response(JSON.stringify(empty)); };
function Probe({ agent }: { agent: Agent }) {
  const data = useOverviewData(agent, false);
  return <div>{data.produced.length} outputs</div>;
}
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function render(agent: Agent) { flushSync(() => root.render(<Probe agent={agent} />)); await pause(); await pause(); }
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
async function run() {
  await render(a);
  equal(calls, ['/api/agents/a/produced?fresh=1']);
  await render({ ...a, activity: 'Reading another file' });
  equal(calls.length, 1); // activity updates must not start another git read
  await render({ ...a, status: 'done', turns: 2 });
  equal(calls.at(-1), '/api/agents/a/produced');
  for (const tick of timers.values()) tick();
  await pause(); await pause();
  equal(calls.at(-1), '/api/agents/a/produced'); equal(calls.length, 3);
  await render({ ...a, id: 'b' });
  equal(calls.at(-1), '/api/agents/b/produced?fresh=1');
  await render(a);
  equal(calls.at(-1), '/api/agents/a/produced?fresh=1');
  flushSync(() => root.render(null)); equal(timers.size, 0);
  await render(a);
  equal(calls.at(-1), '/api/agents/a/produced?fresh=1'); equal(calls.length, 6);
  flushSync(() => root.render(null)); root.unmount(); equal(timers.size, 0);
  return { passed: 7, failed: 0, checks: ['fresh on open', 'no reload for activity', 'cached at turn end', 'cached on timer', 'fresh on selection change', 'fresh on return', 'fresh on remount; timer cleaned up'], calls };
}
run().then(result => { document.body.dataset.result = 'passed'; document.body.textContent = JSON.stringify(result, null, 2); })
  .catch(error => { document.body.dataset.result = 'failed'; document.body.textContent = String(error.stack || error); });
