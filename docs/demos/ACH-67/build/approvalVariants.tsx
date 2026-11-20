/** Real React/DOM action-parity regression. Built offline by buildApprovalVariants.mts. */
import { createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Approval, ApprovalDecision } from '../../../../shared/types.ts';
import { api } from '../../../../web/api.ts';
import { QuestionPrompt } from '../../../../web/panes/Composer.tsx';
import { ApprovalRow } from '../../../../web/panes/Transcript.tsx';
import { QuestionForm } from '../../../../web/mono/QuestionForm.tsx';
import type { UserQuestionReply } from '../../../../web/mono/userQuestion.ts';

const host = document.createElement('main');
document.body.append(host);
const root = createRoot(host);
const calls: { id: string; decision: ApprovalDecision }[] = [];
api.resolveApproval = async (id, decision) => { calls.push({ id, decision }); return { ok: true }; };
// This harness must never contact a running app or provider, even after a regression.
globalThis.fetch = async () => { throw new Error('Unexpected network request in isolated component test'); };
const approval: Approval = {
  id: 'variant-approval', agentId: 'fixture-agent', createdAt: 1_790_000_000_000,
  type: 'tool', toolName: 'Bash', title: 'Run the local checks', detail: 'npm test',
  description: 'Only the temporary fixture.', canAlwaysAllow: true,
};
const question: Approval = { ...approval, type: 'question', questions: [{
  question: 'Which empty state?', header: 'Empty state', multiSelect: false,
  options: [{ label: 'Helpful hint', description: '' }, { label: 'Minimal', description: '' }],
}] };
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function equal(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
function button(label: string) {
  const el = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === label || b.textContent?.trim().startsWith(label + ' '));
  if (!el) throw new Error(`Missing button ${label}: ${host.textContent}`);
  if (el.disabled) throw new Error(`Disabled button ${label}`);
  return el;
}
async function click(label: string) { button(label).click(); await pause(); }
async function input(selector: string, value: string) {
  const el = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!el) throw new Error(`Missing input ${selector}`);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await pause();
}
async function mount(node: ReactElement) {
  flushSync(() => root.render(null));
  calls.length = 0;
  flushSync(() => root.render(node));
  await pause();
  equal(calls, [], 'Rendering never answers an approval');
}
async function parity(name: string, render: (compact: boolean) => ReactElement, interact: (compact: boolean) => Promise<void>, expected: ApprovalDecision) {
  for (const compact of [false, true]) {
    await mount(render(compact));
    await interact(compact);
    equal(calls, [{ id: approval.id, decision: expected }], `${name}, compact=${compact}`);
  }
  return name;
}

async function run() {
  const passed: string[] = [];
  passed.push(await parity('question option uses the same approval answer action',
    compact => <QuestionPrompt approval={question} compact={compact} />,
    async compact => { await click('Helpful hint'); if (!compact) await click('Continue'); },
    { allow: true, answers: { 'Which empty state?': 'Helpful hint' } }));
  passed.push(await parity('team question names the asker without changing the original answer key',
    compact => <QuestionPrompt approval={question} compact={compact} asker={{name:'Rowan'}} />,
    async compact => {
      if(!host.textContent?.includes('Rowan asks: Which empty state?'))throw new Error('Missing team question asker');
      await click('Helpful hint'); if(!compact)await click('Continue');
    }, { allow: true, answers: { 'Which empty state?': 'Helpful hint' } }));
  passed.push(await parity('custom answer uses the existing QuestionForm and answer action',
    compact => <QuestionPrompt approval={question} compact={compact} />,
    async compact => {
      if (compact) await click('Another answer');
      await click('Other');
      await input('textarea, input', '  Use an example  ');
      await click('Continue');
    }, { allow: true, answers: { 'Which empty state?': 'Use an example' } }));
  passed.push(await parity('skip uses the same denied approval action',
    compact => <QuestionPrompt approval={question} compact={compact} />,
    async compact => { if (compact) await click('Another answer'); await click('Skip'); },
    { allow: false, message: 'The user skipped the question.' }));
  passed.push(await parity('allow preserves the approval identity and scope',
    compact => <ApprovalRow approval={approval} compact={compact} />,
    async () => { await click('Allow'); }, { allow: true, always: false }));
  passed.push(await parity('always allow preserves the existing explicit action',
    compact => <ApprovalRow approval={approval} compact={compact} />,
    async () => { await click('Always allow'); }, { allow: true, always: true }));
  passed.push(await parity('denial sends the same trimmed note without an early decision',
    compact => <ApprovalRow approval={approval} compact={compact} />,
    async () => { await click('Deny'); equal(calls, [], 'Deny first opens the note'); await input('input', '  Use the fixture only  '); await click('Send'); },
    { allow: false, always: false, message: 'Use the fixture only' }));
  passed.push(await parity('plan approval keeps its existing approval flow',
    compact => <ApprovalRow approval={{ ...approval, type: 'plan', plan: 'Check the temporary fixture.' }} compact={compact} />,
    async () => { await click('Approve plan'); }, { allow: true, always: false }));

  const replies: { id: number; reply: UserQuestionReply }[] = [];
  for (const compact of [false, true]) {
    replies.length = 0;
    await mount(createElement(QuestionForm, { compact, prompt: { requestId: 23, questions: [{
      id: 'q', prompt: 'Choose checks', multiSelect: true, allowCustom: true,
      options: [{ id: 'types', label: 'Types' }, { id: 'suite', label: 'Suite' }],
    }] }, onReply: (id, reply) => { replies.push({ id, reply }); } }));
    await click('Types'); await click('Suite');
    equal(replies, [], 'Multiselect waits for Continue');
    await click('Continue');
    equal(replies, [{ id: 23, reply: { kind: 'answered', answers: { q: ['types', 'suite'] } } }], `QuestionForm compact=${compact}`);
  }
  passed.push('QuestionForm variants submit the same multiselect reply');
  flushSync(() => root.render(null));
  root.unmount();
  return { passed: passed.length, failed: 0, checks: passed };
}

// An automation client waits for data-result then reads the JSON in the page.
run().then(result => {
  document.body.dataset.result = 'passed';
  document.body.textContent = JSON.stringify(result, null, 2);
}).catch(error => {
  document.body.dataset.result = 'failed';
  document.body.textContent = String(error.stack || error);
});
