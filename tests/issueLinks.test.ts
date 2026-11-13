import './isolate.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Project } from '../shared/types.ts';
import { SuperStore } from '../server/superAgent.ts';
import { IssueLinks, type MergedIssuePr } from '../server/issueLinks.ts';
import { MergeRecords, WorkService } from '../server/work.ts';
import { RefMentions } from '../server/refMentions.ts';
import { Store } from '../server/store.ts';
import { harness, tempDir } from './helpers.ts';
import { createApp } from '../server/app.ts';

const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function setup() {
  const dir = tempDir('issue-links');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init');
  git(repo, 'commit', '--allow-empty', '-m', 'base');
  const project = { id: 'p1', code: 'ACH', name: 'app', path: repo, exists: true, isGit: true } as Project;
  const store = new SuperStore(path.join(dir, 'data'), () => 'ACH');
  const issue = store.addIssue({ text: 'Ship the issue', projectId: 'p1', by: 'user' }, 1000);
  const links = new IssueLinks(store);
  const records = new MergeRecords(path.join(dir, 'work'));
  const work = new WorkService(records, { agents: () => [], messages: () => [], agentsDir: path.join(dir, 'agents'), dataDir: dir, knownRef: () => true, onMerges: (p, r) => { links.localMerges(p, r); } });
  return { dir, repo, project, store, issue, links, work, records };
}
function branch(repo: string, name: string, message = 'work') {
  git(repo, 'checkout', '-b', name);
  fs.writeFileSync(path.join(repo, 'work.txt'), message);
  git(repo, 'add', 'work.txt');
  git(repo, 'commit', '-m', message);
  git(repo, 'checkout', 'main');
  git(repo, 'merge', '--no-ff', name, '-m', `Merge ${name}`);
  return git(repo, 'rev-parse', 'HEAD');
}

test('local merges close through the store with git activity; restarting and reverting never close reopened work', async () => {
  const t = setup();
  const hash = branch(t.repo, 'feat/ACH-1-ship');
  await t.work.view([t.project], true);
  assert.equal(t.store.issue(t.issue.id).status, 'done');
  assert.deepEqual(t.store.issue(t.issue.id).activity.at(-1)?.by, { kind: 'git' });
  assert.match(t.store.issue(t.issue.id).activity.at(-1)?.text ?? '', new RegExp(hash));
  const n = t.store.issue(t.issue.id).activity.length;
  await t.work.view([t.project], true);
  assert.equal(t.store.issue(t.issue.id).activity.length, n);
  t.store.updateIssue(t.issue.id, { status: 'todo' });
  git(t.repo, 'revert', '-m', '1', '--no-edit', hash);
  const restarted = new IssueLinks(new SuperStore(path.join(t.dir, 'data'), () => 'ACH'));
  restarted.localMerges(t.project, t.records.list(fs.realpathSync(t.repo)));
  await t.work.view([t.project], true);
  assert.equal(t.store.issue(t.issue.id).status, 'todo');
  // A different merge after the reopen, at a deterministic time (git reflog uses whole seconds).
  git(t.repo, 'checkout', 'feat/ACH-1-ship');
  fs.writeFileSync(path.join(t.repo, 'followup.txt'), 'follow-up');
  git(t.repo, 'add', 'followup.txt');
  git(t.repo, 'commit', '-m', 'follow-up');
  git(t.repo, 'checkout', 'main');
  const future = new Date(Date.now() + 2000).toISOString();
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', 'feat/ACH-1-ship', '-m', 'Merge feat/ACH-1-ship again'], { cwd: t.repo, env: { ...env, GIT_COMMITTER_DATE: future }, stdio: 'pipe' });
  await t.work.view([t.project], true);
  assert.equal(t.store.issue(t.issue.id).status, 'done');
  assert.match(t.store.issue(t.issue.id).activity.at(-1)?.text ?? '', new RegExp(git(t.repo, 'rev-parse', 'HEAD')));
});

test('explicit branch links work without a key, but canceled and other-project issues are untouched', async () => {
  const t = setup();
  t.store.updateIssue(t.issue.id, { branch: 'fix/no-key' });
  const other = t.store.addIssue({ text: 'other project', projectId: 'p2', by: 'user' }, 1000);
  t.store.updateIssue(other.id, { branch: 'fix/no-key' });
  const canceled = t.store.addIssue({ text: 'canceled', projectId: 'p1', by: 'user' }, 1000);
  t.store.updateIssue(canceled.id, { branch: 'fix/no-key', status: 'canceled' });
  branch(t.repo, 'fix/no-key');
  await t.work.view([t.project], true);
  assert.equal(t.store.issue(t.issue.id).status, 'done');
  assert.equal(t.store.issue(other.id).status, 'todo');
  assert.equal(t.store.issue(canceled.id).status, 'canceled');
});

test('GitHub merged PRs match branch, title or body and require merge evidence; old PRs do not reclose', () => {
  for (const field of ['branch', 'title', 'body'] as const) {
    const t = setup();
    const pr: MergedIssuePr = { repo: 'a/b', number: 12, projects: [{ id: 'p1' }], state: 'merged', branch: 'fix/x', title: 'ship', body: '', mergedAt: new Date(5000).toISOString(), mergeCommit: 'a'.repeat(40), [field]: `feat/${t.issue.key}-ship` };
    assert.equal(t.links.githubMerges([{ ...pr, state: 'closed' }, { ...pr, mergeCommit: null }]), 0);
    assert.equal(t.links.githubMerges([pr]), 1);
    assert.equal(t.store.issue(t.issue.id).status, 'done');
    assert.match(t.store.issue(t.issue.id).activity.at(-1)?.text ?? '', /a\/b#12/);
    t.store.updateIssue(t.issue.id, { status: 'todo' }, 6000);
    assert.equal(new IssueLinks(t.store).githubMerges([pr]), 0);
    assert.equal(t.links.githubMerges([{ ...pr, mergeCommit: 'b'.repeat(40), mergedAt: new Date(7000).toISOString() }]), 1);
  }
});

test('decision links find full branch commit messages and handoff/report citations, never issue ids', async () => {
  const t = setup();
  branch(t.repo, 'feat/ACH-1-ship', 'Implement the issue\n\nUse ACH-D41 and ALL-D1. Refs: ACH-12, ACH-N3.');
  await t.work.view([t.project], true);
  const state = new Store(path.join(t.dir, 'state'));
  state.load();
  const mentions = new RefMentions(state);
  state.messages.push({ id: 'handoff', fromAgentId: 'lead', fromName: 'Lead', toAgentId: 'dev', toName: 'Dev', conversationId: 'c1', ts: 2000, text: 'Implement ACH-1 under ACH-D43.', status: 'delivered' } as typeof state.messages[number]);
  state.messages.push({ id: 'report', replyTo: 'handoff', fromAgentId: 'dev', fromName: 'Dev', toAgentId: 'lead', toName: 'Lead', conversationId: 'c1', ts: 3000, text: 'Done under ALL-D7.', status: 'delivered', report: { outcome: 'passed', summary: 'Kept ACH-D14.', evidence: 'Checked ACH-D7.' } } as typeof state.messages[number]);
  t.store.updateIssue(t.issue.id, { delegationId: 'handoff' });
  await t.links.indexCommits(t.project, 'main', [], mentions);
  const links = mentions.issueDecisions(t.store.issue(t.issue.id));
  assert.deepEqual(links.map(l => l.id), ['ACH-D14', 'ACH-D41', 'ACH-D43', 'ACH-D7', 'ALL-D1', 'ALL-D7']);
  assert.equal(links.find(l => l.id === 'ACH-D41')?.citations[0].source, 'commit');
  assert.equal(mentions.decisionIssues('ACH-D41', t.store.issues())[0].key, 'ACH-1');
  assert.deepEqual(mentions.decisionIssues('ACH-12', t.store.issues()), []);
});

test('issue decisions and reverse decision issues are exposed through validated read-only APIs', async () => {
  const h = harness();
  const refs = path.join(h.store.dataDir, 'projects', 'ALL');
  fs.mkdirSync(refs, { recursive: true });
  fs.writeFileSync(path.join(refs, 'decisions.md'), '# Decisions (ALL)\n\n## ALL-D1  Keep identities\n- decided by: You\n- date: 2026-11-13\n- status: active\n\nUse the shared key matcher.\n');
  h.manager.addIssue({ text: 'Issue for the API' });
  const issue = h.manager.superView().issues[0];
  h.store.messages.push({ id: 'msg-api', fromAgentId: 'lead', fromName: 'Lead', toAgentId: 'dev', toName: 'Dev', conversationId: 'c', ts: 1000, text: `${issue.key} uses ALL-D1.`, status: 'delivered' } as typeof h.store.messages[number]);
  const server = createApp(h.manager).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = (route: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`;
  try {
    const decisions = await (await fetch(url(`/api/issues/${issue.key}/decisions`))).json() as { decisions: { id: string }[] };
    assert.deepEqual(decisions.decisions.map(d => d.id), ['ALL-D1']);
    const reverse = await (await fetch(url('/api/refs/ALL-D1/issues'))).json() as { issues: { key: string }[] };
    assert.deepEqual(reverse.issues.map(i => i.key), [issue.key]);
    assert.equal((await fetch(url('/api/issues/missing/decisions'))).status, 404);
    assert.equal((await fetch(url('/api/refs/ALL-D99/issues'))).status, 404);
    assert.equal((await fetch(url('/api/refs/ALL-12/issues'))).status, 400);
    assert.equal((await fetch(url(`/api/issues/${issue.id}/decisions`), { method: 'POST' })).status, 404);
  } finally {
    server.close();
    await h.manager.shutdown();
  }
});

test('decisions are indexed for an unmerged keyed branch even when no worktree is on it', async () => {
  const t = setup();
  git(t.repo, 'checkout', '-b', 'feat/ACH-1-unmerged');
  git(t.repo, 'commit', '--allow-empty', '-m', 'Use ACH-D43 for ACH-1');
  git(t.repo, 'checkout', 'main');
  const state = new Store(path.join(t.dir, 'state')); state.load();
  const mentions = new RefMentions(state);
  await t.links.indexCommits(t.project, 'main', [], mentions);
  assert.deepEqual(mentions.issueDecisions(t.issue).map(d => d.id), ['ACH-D43']);
});

test('fast-forward merges use the existing reflog entries as merge evidence', async () => {
  const t = setup();
  git(t.repo, 'checkout', '-b', 'feat/ACH-1-ff');
  git(t.repo, 'commit', '--allow-empty', '-m', 'Ship ACH-1');
  const tip = git(t.repo, 'rev-parse', 'HEAD');
  git(t.repo, 'checkout', 'main');
  git(t.repo, 'merge', '--ff-only', 'feat/ACH-1-ff');
  await t.work.view([t.project], true);
  assert.equal(t.store.issue(t.issue.id).status, 'done');
  assert.match(t.store.issue(t.issue.id).activity.at(-1)?.text ?? '', new RegExp(tip));
});
