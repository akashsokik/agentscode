import './isolate.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Project } from '../shared/types.ts';
import { SuperStore } from '../server/superAgent.ts';
import { IssueLinks, type MergedIssuePr, type IssueLinkStore } from '../server/issueLinks.ts';
import { MergeRecords, WorkService, readGit, type GitRunner, type MergeRecord } from '../server/work.ts';
import { RefMentions } from '../server/refMentions.ts';
import { Store } from '../server/store.ts';
import { harness, tempDir } from './helpers.ts';
import { createApp } from '../server/app.ts';
import { AgentManager } from '../server/manager.ts';
import { OPEN_AUTH } from '../server/userAuth.ts';
import { HttpError } from '../server/errors.ts';

const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function setup(createdAt = 1000) {
  const dir = tempDir('issue-links');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init');
  git(repo, 'commit', '--allow-empty', '-m', 'base');
  const project = { id: 'p1', code: 'ACH', name: 'app', path: repo, exists: true, isGit: true } as Project;
  const store = new SuperStore(path.join(dir, 'data'), () => 'ACH');
  const issue = store.addIssue({ text: 'Ship the issue', projectId: 'p1', by: 'user' }, createdAt);
  const links = new IssueLinks(store);
  const records = new MergeRecords(path.join(dir, 'work'));
  const work = new WorkService(records, { agents: () => [], messages: () => [], agentsDir: path.join(dir, 'agents'), dataDir: dir, knownRef: () => true, onMerges: (p, r) => { links.localMerges(p, r); } });
  const issueRecords = new MergeRecords(path.join(dir, 'issue-links'), 'fast-forwards.json');
  return { dir, repo, project, store, issue, links, work, records, issueRecords };
}
function branch(repo: string, name: string, message = 'work', base = 'main') {
  git(repo, 'checkout', '-b', name);
  fs.writeFileSync(path.join(repo, 'work.txt'), message);
  git(repo, 'add', 'work.txt');
  git(repo, 'commit', '-m', message);
  git(repo, 'checkout', base);
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
  assert.equal(t.store.issue(t.issue.id).activity.at(-1)?.ref, hash);
  const n = t.store.issue(t.issue.id).activity.length;
  await t.work.view([t.project], true);
  assert.equal(t.store.issue(t.issue.id).activity.length, n);
  t.store.updateIssue(t.issue.id, { status: 'todo' });
  git(t.repo, 'revert', '-m', '1', '--no-edit', hash);
  const restarted = new IssueLinks(new SuperStore(path.join(t.dir, 'data'), () => 'ACH'));
  restarted.localMerges(t.project, t.records.list(fs.realpathSync(t.repo)));
  await t.work.view([t.project], true);
  assert.equal(t.store.issue(t.issue.id).status, 'todo');
  // A merge in a later whole second is unambiguously after reopening.
  git(t.repo, 'checkout', 'feat/ACH-1-ship');
  fs.writeFileSync(path.join(t.repo, 'followup.txt'), 'follow-up');
  git(t.repo, 'add', 'followup.txt');
  git(t.repo, 'commit', '-m', 'follow-up');
  git(t.repo, 'checkout', 'main');
  const laterSecond = new Date((Math.floor(Date.now() / 1000) + 1) * 1000).toISOString();
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', 'feat/ACH-1-ship', '-m', 'Merge feat/ACH-1-ship again'], { cwd: t.repo, env: { ...env, GIT_COMMITTER_DATE: laterSecond }, stdio: 'pipe' });
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
    const pr: MergedIssuePr = { repo: 'a/b', number: 12, projects: [{ id: 'p1' }], state: 'merged', branch: 'fix/x', title: 'ship', body: '', mergedAt: new Date(5000).toISOString(), mergeCommit: 'a'.repeat(40), [field]: field === 'branch' ? `feat/${t.issue.key}-ship` : `Fixes ${t.issue.key}` };
    assert.equal(t.links.githubMerges([{ ...pr, state: 'closed' }, { ...pr, mergeCommit: null }]), 0);
    assert.equal(t.links.githubMerges([pr]), 1);
    assert.equal(t.store.issue(t.issue.id).status, 'done');
    assert.match(t.store.issue(t.issue.id).activity.at(-1)?.text ?? '', /a\/b#12/);
    assert.equal(t.store.issue(t.issue.id).activity.at(-1)?.ref, `a/b#12:${'a'.repeat(40)}`);
    t.store.updateIssue(t.issue.id, { status: 'todo' }, 6000);
    assert.equal(new IssueLinks(t.store).githubMerges([pr]), 0);
    assert.equal(t.links.githubMerges([{ ...pr, mergeCommit: 'b'.repeat(40), mergedAt: new Date(7000).toISOString() }]), 1);
  }
});

test('an explicitly linked PR branch closes only its project issue without a key or closing phrase', () => {
  const t = setup();
  const branch = 'fix/explicitly-linked';
  t.store.updateIssue(t.issue.id, { branch });
  const other = t.store.addIssue({ text: 'Other project', projectId: 'p2', by: 'user' }, 1000);
  t.store.updateIssue(other.id, { branch });
  const pr: MergedIssuePr = { repo: 'a/b', number: 3, projects: [{ id: 'p1' }], state: 'merged', branch, title: 'Follow-up work', body: `See ${t.issue.key}`, mergedAt: new Date(5000).toISOString(), mergeCommit: 'a'.repeat(40) };
  assert.equal(t.links.githubMerges([{ ...pr, branch: 'fix/another' }]), 0);
  assert.equal(t.store.issue(t.issue.id).status, 'todo');
  assert.equal(t.links.githubMerges([{ ...pr, title: 'Revert the work' }]), 0);
  assert.equal(t.links.githubMerges([pr]), 1);
  assert.equal(t.store.issue(t.issue.id).status, 'done');
  assert.equal(t.store.issue(other.id).status, 'todo');
});

test('decision links find full branch commit messages and handoff/report citations, never issue ids', async () => {
  const t = setup();
  branch(t.repo, 'feat/ACH-1-ship', 'Implement the issue\n\nUse ACH-D41 and ALL-D1. Refs: ACH-12, ACH-N3.');
  await t.work.view([t.project], true);
  const state = new Store(path.join(t.dir, 'state'));
  state.load();
  state.projects.set(t.project.id, t.project);
  const mentions = new RefMentions(state);
  state.messages.push({ id: 'handoff', fromAgentId: 'lead', fromName: 'Lead', toAgentId: 'dev', toName: 'Dev', conversationId: 'c1', ts: 2000, text: 'Implement ACH-1 under ACH-D43.', status: 'delivered' } as typeof state.messages[number]);
  state.messages.push({ id: 'report', replyTo: 'handoff', fromAgentId: 'dev', fromName: 'Dev', toAgentId: 'lead', toName: 'Lead', conversationId: 'c1', ts: 3000, text: 'Done under ALL-D7.', status: 'delivered', report: { outcome: 'passed', summary: 'Kept ACH-D14.', evidence: 'Checked ACH-D7.' } } as typeof state.messages[number]);
  t.store.updateIssue(t.issue.id, { delegationId: 'handoff' });
  await t.links.indexCommits(t.project, 'main', [], mentions);
  const links = mentions.issueDecisions(t.store.issue(t.issue.id));
  assert.deepEqual(links.map(l => l.id), ['ACH-D14', 'ACH-D41', 'ACH-D43', 'ACH-D7', 'ALL-D1', 'ALL-D7']);
  const commitCitation = links.find(l => l.id === 'ACH-D41')?.citations[0];
  assert.ok(commitCitation?.source === 'commit');
  assert.equal(commitCitation.subject, 'Implement the issue');
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
  const server = createApp(h.manager, undefined, undefined, OPEN_AUTH).listen(0, '127.0.0.1');
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
  const state = new Store(path.join(t.dir, 'state')); state.load(); state.projects.set(t.project.id, t.project);
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
  const view = await t.work.view([t.project], true);
  assert.deepEqual(view.projects[0].merged, [], 'fast-forwards do not become Work merge rows');
  assert.equal(fs.existsSync(path.join(t.dir, 'work', 'merges.json')), false, 'FF evidence never creates Work merges.json');
  assert.equal(t.issueRecords.list(fs.realpathSync(t.repo)).length, 1, 'FF evidence persists only for issue links');
  assert.equal(t.store.issue(t.issue.id).status, 'done');
  assert.match(t.store.issue(t.issue.id).activity.at(-1)?.text ?? '', new RegExp(tip));
});

test('commit scans cache immutable branch ranges and invalidate when either end moves; failures retry', async () => {
  const t = setup();
  git(t.repo, 'checkout', '-b', 'feat/ACH-1-cache');
  git(t.repo, 'commit', '--allow-empty', '-m', 'Use ACH-D41');
  git(t.repo, 'checkout', 'main');
  const state = new Store(path.join(t.dir, 'state')); state.load(); state.projects.set(t.project.id, t.project);
  const mentions = new RefMentions(state);
  let logs = 0;
  let failOnce = true;
  const runner: GitRunner = async (args, cwd) => {
    if (args[0] === 'log') {
      logs++;
      assert.equal(args[1], '-500');
      assert.match(args[3], /^[a-f0-9]{40}$/);
      assert.match(args[5], /^[a-f0-9]{40}$/);
      if (failOnce) { failOnce = false; return { ok: false, out: '' }; }
    }
    return readGit(args, cwd);
  };
  await t.links.indexCommits(t.project, 'main', [], mentions, runner);
  assert.deepEqual(mentions.issueDecisions(t.issue), []);
  await t.links.indexCommits(t.project, 'main', [], mentions, runner);
  assert.equal(logs, 2, 'failed read retried');
  await t.links.indexCommits(t.project, 'main', [], mentions, runner);
  assert.equal(logs, 2, 'same branch/main pair reused');
  git(t.repo, 'commit', '--allow-empty', '-m', 'unrelated main change');
  await t.links.indexCommits(t.project, 'main', [], mentions, runner);
  assert.equal(logs, 3, 'main moved');
  git(t.repo, 'checkout', 'feat/ACH-1-cache');
  git(t.repo, 'commit', '--allow-empty', '-m', 'Also use ALL-D1');
  git(t.repo, 'checkout', 'main');
  await t.links.indexCommits(t.project, 'main', [], mentions, runner);
  assert.equal(logs, 4, 'branch moved');
  assert.deepEqual(mentions.issueDecisions(t.issue).map(d => d.id), ['ACH-D41', 'ALL-D1']);
});

test('whole-second merge timestamps close same-second creation, but reopening requires a later second', () => {
  const t = setup(1001);
  const hash = branch(t.repo, 'feat/ACH-1-time');
  const record: MergeRecord = { hash, branch: 'feat/ACH-1-time', at: 1000, tree: git(t.repo, 'rev-parse', 'HEAD^{tree}'), tip: git(t.repo, 'rev-parse', 'HEAD^2'), parent: git(t.repo, 'rev-parse', 'HEAD^1'), subject: 'Merge feat/ACH-1-time', names: [], refs: [] };
  const first = new IssueLinks(t.store, () => 1500);
  assert.equal(first.localMerges(t.project, [record]), 1);
  t.store.updateIssue(t.issue.id, { status: 'todo' }, 2001);
  const restarted = new IssueLinks(new SuperStore(path.join(t.dir, 'data'), () => 'ACH'), () => 2500);
  assert.equal(restarted.localMerges(t.project, [record]), 0);
  git(t.repo, 'checkout', 'feat/ACH-1-time');
  git(t.repo, 'commit', '--allow-empty', '-m', 'more work');
  git(t.repo, 'checkout', 'main');
  git(t.repo, 'merge', '--no-ff', 'feat/ACH-1-time', '-m', 'Merge feat/ACH-1-time again');
  const next = { ...record, hash: git(t.repo, 'rev-parse', 'HEAD'), at: 2000 };
  assert.equal(restarted.localMerges(t.project, [record, next]), 0, 'same-second order is ambiguous');
  assert.equal(t.store.issue(t.issue.id).status, 'todo');
  assert.equal(restarted.localMerges(t.project, [record, next, { ...next, hash: 'c'.repeat(40), at: 3000 }]), 1);
  assert.equal(t.store.issue(t.issue.id).status, 'done');
  assert.equal(restarted.localMerges(t.project, [record, next]), 0);
});

test('identical reports keep separate issue bindings and the correct conversation, including transcript copies', () => {
  const t = setup();
  const second = t.store.addIssue({ text: 'Second issue', projectId: 'p1', by: 'user' }, 1002);
  t.store.updateIssue(t.issue.id, { delegationId: 'd1' });
  t.store.updateIssue(second.id, { delegationId: 'd2' });
  const state = new Store(path.join(t.dir, 'state')); state.load(); state.projects.set(t.project.id, t.project);
  for (const [n, replyTo] of ['d1', 'd2'].entries()) {
    const message = { id: `r${n}`, replyTo, fromAgentId: 'dev', fromName: 'Dev', toAgentId: 'lead', toName: 'Lead', conversationId: `c${n}`, ts: 1000 + n, text: 'Done under ACH-D43.', status: 'delivered' } as typeof state.messages[number];
    state.messages.push(message);
    state.appendEntry({ id: `peer:r${n}`, agentId: 'lead', kind: 'peer', ts: message.ts, text: message.text, peer: message });
  }
  const check = (mentions: RefMentions) => {
    const issues = t.store.issues();
    const first = mentions.issueDecisions(issues[0])[0].citations[0];
    const second = mentions.issueDecisions(issues[1])[0].citations[0];
    assert.ok(first.source !== 'commit' && second.source !== 'commit');
    assert.deepEqual(first.open, { kind: 'comms', conversationId: 'c0' });
    assert.deepEqual(second.open, { kind: 'comms', conversationId: 'c1' });
    assert.equal(mentions.decisionIssues('ACH-D43', issues).length, 2);
    assert.equal(mentions.counts().get('ACH-D43'), 1, 'Notes still deduplicates identical text');
  };
  check(new RefMentions(state));
  state.messages.length = 0;
  check(new RefMentions(state));
});

test('fast-forward to a merge commit records its actual tip and includes both sides in citation scans', async () => {
  const t = setup();
  git(t.repo, 'checkout', '-b', 'feat/ACH-1-stack');
  git(t.repo, 'commit', '--allow-empty', '-m', 'First-parent work under ACH-D43');
  git(t.repo, 'checkout', '-b', 'helper');
  git(t.repo, 'commit', '--allow-empty', '-m', 'Helper under ALL-D1');
  git(t.repo, 'checkout', 'feat/ACH-1-stack');
  git(t.repo, 'merge', '--no-ff', 'helper', '-m', 'Combine helper under ALL-D7');
  const tip = git(t.repo, 'rev-parse', 'HEAD');
  git(t.repo, 'checkout', 'main');
  git(t.repo, 'merge', '--ff-only', 'feat/ACH-1-stack');
  await t.work.view([t.project], true);
  assert.equal(t.issueRecords.list(fs.realpathSync(t.repo)).find(r => r.branch === 'feat/ACH-1-stack')?.tip, tip);
  assert.deepEqual((await t.work.view([t.project])).projects[0].merged, [], 'FF-to-merge also stays out of Work merge rows');
  const state = new Store(path.join(t.dir, 'state')); state.load(); state.projects.set(t.project.id, t.project);
  const mentions = new RefMentions(state);
  await t.links.indexCommits(t.project, 'main', [], mentions);
  assert.deepEqual(mentions.issueDecisions(t.issue).map(d => d.id), ['ACH-D43', 'ALL-D1', 'ALL-D7']);
});

test('all observed local merge identities are consumed while closed, durably across reopen and restart', () => {
  const t = setup(1001);
  const template: MergeRecord = { hash: 'a'.repeat(40), branch: 'feat/ACH-1-consumed', at: 2000, tree: '', tip: '', subject: 'Merge the issue branch', names: [], refs: [] };
  const links = new IssueLinks(t.store, () => 2100);
  assert.equal(links.localMerges(t.project, [template]), 1);
  const second = { ...template, hash: 'b'.repeat(40) };
  assert.equal(links.localMerges(t.project, [template, second]), 0);
  assert.equal(t.store.issue(t.issue.id).status, 'done');
  assert.match(t.store.issue(t.issue.id).activity.at(-1)?.text ?? '', /b{40}/);
  assert.equal(t.store.issue(t.issue.id).activity.at(-1)?.kind, 'comment');
  t.store.updateIssue(t.issue.id, { status: 'todo' }, 2500);
  const restarted = new IssueLinks(new SuperStore(path.join(t.dir, 'data'), () => 'ACH'), () => 2900);
  assert.equal(restarted.localMerges(t.project, [template, second]), 0);
  assert.equal(t.store.issue(t.issue.id).status, 'todo');
  assert.equal(restarted.localMerges(t.project, [template, second, { ...template, hash: 'c'.repeat(40) }]), 0);
  assert.equal(restarted.localMerges(t.project, [{ ...template, hash: 'd'.repeat(40), at: 3000 }]), 1);
});

test('all observed GitHub PR merges are consumed while closed and keyed by PR identity and merge hash', () => {
  const t = setup(1001);
  const links = new IssueLinks(t.store, () => 2100);
  const first: MergedIssuePr = { repo: 'a/b', number: 1, projects: [{ id: 'p1' }], state: 'merged', branch: 'feat/ACH-1-work', title: 'Ship', mergedAt: new Date(2000).toISOString(), mergeCommit: 'a'.repeat(40) };
  assert.equal(links.githubMerges([first]), 1);
  const second = { ...first, number: 2, mergeCommit: 'b'.repeat(40) };
  assert.equal(links.githubMerges([first, second]), 0);
  t.store.updateIssue(t.issue.id, { status: 'todo' }, 2500);
  const restarted = new IssueLinks(new SuperStore(path.join(t.dir, 'data'), () => 'ACH'), () => 2900);
  assert.equal(restarted.githubMerges([first, second]), 0);
  assert.equal(t.store.issue(t.issue.id).status, 'todo');
  assert.equal(restarted.githubMerges([{ ...first, number: 3 }]), 0, 'same-second order is ambiguous');
  assert.equal(restarted.githubMerges([{ ...first, number: 4, mergedAt: new Date(3000).toISOString() }]), 1, 'another later PR merge is a new event even with the same commit');
});

test('an unseen historical merge in the reopening second cannot reclose, locally or on GitHub', () => {
  const t = setup(1001);
  const a: MergeRecord = { hash: 'a'.repeat(40), branch: 'feat/ACH-1-safe', at: 2000, tree: '', tip: '', subject: 'Merge the issue branch', names: [], refs: [] };
  const links = new IssueLinks(t.store, () => 2100);
  assert.equal(links.localMerges(t.project, [a]), 1);
  t.store.updateIssue(t.issue.id, { status: 'todo' }, 2500);
  const restarted = new IssueLinks(new SuperStore(path.join(t.dir, 'data'), () => 'ACH'), () => 3000);
  const unseen = { ...a, hash: 'b'.repeat(40) };
  assert.equal(restarted.localMerges(t.project, [a, unseen]), 0);
  assert.equal(t.store.issue(t.issue.id).status, 'todo');
  const pr: MergedIssuePr = { repo: 'a/b', number: 2, projects: [{ id: 'p1' }], state: 'merged', branch: a.branch, title: 'Ship', mergedAt: new Date(2000).toISOString(), mergeCommit: unseen.hash };
  assert.equal(restarted.githubMerges([pr]), 0);
  assert.equal(t.store.issue(t.issue.id).status, 'todo');
});

test('merge identity comes from activityRef, never a hash mentioned in human-readable activity text', () => {
  const t = setup(1001);
  const record: MergeRecord = { hash: 'a'.repeat(40), branch: 'feat/ACH-1-ref', at: 2000, tree: '', tip: '', subject: 'Merge the issue branch', names: [], refs: [] };
  t.store.updateIssue(t.issue.id, { activityText: `Diagnostics mentioned ${record.hash}, before the merge happened.` }, 1500, { kind: 'git' });
  const links = new IssueLinks(t.store, () => 2100);
  assert.equal(links.localMerges(t.project, [record]), 1);
  assert.equal(t.store.issue(t.issue.id).activity.at(-1)?.ref, record.hash);
  t.store.updateIssue(t.issue.id, { status: 'todo' }, 2500);
  const restarted = new IssueLinks(new SuperStore(path.join(t.dir, 'data'), () => 'ACH'), () => 4000);
  const count = t.store.issue(t.issue.id).activity.length;
  assert.equal(restarted.localMerges(t.project, [record]), 0);
  assert.equal(t.store.issue(t.issue.id).activity.length, count);
  assert.equal(t.store.issue(t.issue.id).status, 'todo');
});

test('GitHub plain mentions only link; branch keys or explicit closing phrases close', () => {
  const cases = [
    { title: 'Follow-up to ACH-1', body: 'See ACH-1', closes: false },
    { title: 'Ship follow-up', body: 'Follow-up to ACH-1', closes: false },
    { title: 'ACH-1 follow-up', body: '', closes: false },
    { title: 'Ship', body: 'Fixes ISO-9001; see ACH-1', closes: false },
    { title: 'Ship', body: 'Refixes ACH-1', closes: false },
    { title: 'Fixes ACH-D43', body: 'See ACH-1', closes: false },
    { title: 'fIxEs ach-1', body: '', closes: true },
    { title: 'Ship', body: 'cLoSeS AcH-1', closes: true },
    { title: 'Closes: ACH-1', body: '', closes: true },
    { title: 'Ship', body: 'cLoSeS:\n ach-001', closes: true },
    { title: 'Ship', body: 'Resolves : ACH-1', closes: true },
    { title: 'Ship', body: 'Fixes:ACH-1', closes: true },
    { title: 'Ship', body: 'See: ACH-1', closes: false },
    { title: 'Ship', body: 'Closes:: ACH-1', closes: false },
    { title: 'Ship', body: 'Resolves ACH-001.', closes: true },
    { title: 'Ship', body: 'Follow-up to ACH-1. Fixes ACH-1.', closes: true },
    { title: 'Ship', body: 'Follow-up to ACH-1. Fixes: ACH-1.', closes: true },
    { title: 'ACH-1 follow-up. FIXES ach-001.', body: '', closes: true },
    { title: 'Follow-up', body: 'See ACH-1', branch: 'feat/ach-1-work', closes: true },
  ];
  for (const c of cases) {
    const t = setup();
    const pr: MergedIssuePr = { repo: 'a/b', number: 1, projects: [{ id: 'p1' }], state: 'merged', mergedAt: new Date(5000).toISOString(), mergeCommit: 'a'.repeat(40), branch: c.branch ?? 'fix/x', title: c.title, body: c.body };
    assert.equal(t.links.githubMerges([pr]), c.closes ? 1 : 0, JSON.stringify(c));
    assert.equal(t.store.issue(t.issue.id).status, c.closes ? 'done' : 'todo', JSON.stringify(c));
  }
});

test('manager wires fresh PR reads to issue closure without extra GitHub polling', async () => {
  const t = setup();
  const state = new Store(path.join(t.dir, 'app-state')); state.load();
  const unavailable = { available: false, path: '', version: '' };
  let reads = 0;
  let issueKey = '';
  const manager = new AgentManager(state, { broadcast: () => {} }, { claude: unavailable, codex: unavailable, orcacode: unavailable }, {
    gitRemote: async () => 'https://github.com/a/b.git',
    ghExec: async (_bin, args) => {
      reads++;
      return { stdout: JSON.stringify(args.includes('merged') ? [{ number: 7, title: 'Ship', body: `Closes ${issueKey}`, state: 'MERGED', headRefName: 'fix/x', mergedAt: new Date().toISOString(), mergeCommit: { oid: 'a'.repeat(40) } }] : []), stderr: '' };
    },
  });
  try {
    const project = manager.addProject({ path: t.repo });
    manager.addIssue({ text: 'PR listener integration', projectId: project.id });
    issueKey = manager.superView().issues[0].key;
    await manager.prs.list();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.superView().issues[0].status, 'done');
    assert.equal(manager.superView().issues[0].activity.at(-1)?.ref, `a/b#7:${'a'.repeat(40)}`);
    assert.equal(reads, 2);
    await manager.prs.list();
    await manager.issueLinks.refresh();
    assert.equal(reads, 2, 'cache/local issue tick does not add GitHub reads');
  } finally { await manager.shutdown(); }
});

test('idle local issue checks reuse Work evidence without Git reads; main changes refresh, including linked worktrees', async () => {
  for (const kind of ['root', 'linked', 'nested', 'linked-nested', 'symlink-nested', 'custom-default']) {
    const linked = kind.includes('linked');
    const t = setup();
    let project = t.project;
    if (kind === 'custom-default') {
      git(t.repo, 'branch', '-m', 'main', 'trunk');
      git(t.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
      git(t.repo, 'checkout', '-b', 'agent');
    }
    if (linked) {
      const folder = path.join(t.dir, 'linked');
      git(t.repo, 'worktree', 'add', '-b', 'agent', folder, 'main');
      project = { ...project, path: folder };
    }
    if (kind.includes('nested')) {
      const folder = path.join(project.path, 'packages', 'app');
      fs.mkdirSync(folder, { recursive: true });
      project = { ...project, path: folder };
    }
    if (kind === 'symlink-nested') {
      const alias = path.join(t.dir, 'alias');
      fs.symlinkSync(project.path, alias);
      project = { ...project, path: alias };
    }
    let calls = 0;
    const work = new WorkService(t.records, { agents: () => [], messages: () => [], agentsDir: path.join(t.dir, 'agents'), dataDir: t.dir, knownRef: () => true, onMerges: (p, r) => { t.links.localMerges(p, r); } }, async (args, cwd) => { calls++; return readGit(args, cwd); });
    work.ttlMs = 0; // Even after the normal view cache expires, an idle issue tick is read-free.
    await work.refreshMerges([project]);
    const baseline = calls;
    assert.ok(baseline > 0);
    await work.refreshMerges([project]);
    await work.refreshMerges([project]);
    assert.equal(calls, baseline, `no idle Git reads, kind=${kind}`);
    branch(t.repo, 'feat/ACH-1-detect', 'work', kind === 'custom-default' ? 'trunk' : 'main');
    await work.refreshMerges([project]);
    assert.ok(calls > baseline);
    assert.equal(t.store.issue(t.issue.id).status, 'done');
    const afterMerge = calls;
    await work.refreshMerges([project]);
    assert.equal(calls, afterMerge, 'new evidence is reused');
  }
});

test('a later fast-forward to a known merge commit preserves the existing Work merge row', async () => {
  const t = setup();
  const hash = branch(t.repo, 'feat/ACH-1-original');
  const original = (await t.work.view([t.project], true)).projects[0];
  assert.equal(original.merged.length, 1);
  const before = fs.readFileSync(path.join(t.dir, 'work', 'merges.json'), 'utf8');
  git(t.repo, 'branch', 'restore', hash);
  git(t.repo, 'reset', '--hard', 'HEAD^1');
  git(t.repo, 'merge', '--ff-only', 'restore');
  const restored = (await t.work.view([t.project], true)).projects[0];
  assert.deepEqual(restored.merged.map(m => [m.originalHash, m.branch]), original.merged.map(m => [m.originalHash, m.branch]));
  assert.equal(fs.readFileSync(path.join(t.dir, 'work', 'merges.json'), 'utf8'), before, 'FF never rewrites Work merge records');
});

test('Work without issue links never records fast-forward evidence in either store', async () => {
  const t = setup();
  git(t.repo, 'checkout', '-b', 'feat/ACH-1-standalone');
  git(t.repo, 'commit', '--allow-empty', '-m', 'Ship');
  git(t.repo, 'checkout', 'main');
  git(t.repo, 'merge', '--ff-only', 'feat/ACH-1-standalone');
  const dir = path.join(t.dir, 'standalone');
  const work = new WorkService(new MergeRecords(path.join(dir, 'work')), { agents: () => [], messages: () => [], agentsDir: path.join(dir, 'agents'), dataDir: dir, knownRef: () => true });
  assert.deepEqual((await work.view([t.project], true)).projects[0].merged, []);
  assert.equal(fs.existsSync(path.join(dir, 'work', 'merges.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'issue-links', 'fast-forwards.json')), false);
});

test('local and GitHub merge batches read the issue list once and reuse returned updates', () => {
  for (const source of ['local', 'github']) {
    const t = setup();
    let reads = 0;
    const store: IssueLinkStore = {
      issues: () => { reads++; return t.store.issues(); },
      updateIssue: (id, patch, now, by) => t.store.updateIssue(id, patch, now, by),
    };
    const links = new IssueLinks(store, () => 4000);
    if (source === 'local') {
      const a: MergeRecord = { hash: 'a'.repeat(40), branch: 'feat/ACH-1-batch', at: 2000, tree: '', tip: '', subject: 'Merge', names: [], refs: [] };
      assert.equal(links.localMerges(t.project, [a, { ...a, hash: 'b'.repeat(40), at: 3000 }, a]), 1);
    } else {
      const a: MergedIssuePr = { repo: 'a/b', number: 1, projects: [{ id: 'p1' }], state: 'merged', branch: 'feat/ACH-1-batch', title: 'Ship', mergedAt: new Date(2000).toISOString(), mergeCommit: 'a'.repeat(40) };
      assert.equal(links.githubMerges([a, { ...a, number: 2, mergeCommit: 'b'.repeat(40) }, a]), 1);
    }
    assert.equal(reads, 1, source);
    assert.equal(t.store.issue(t.issue.id).activity.filter(e => e.ref).length, 2, 'duplicate event skipped within the same batch');
  }
});

test('merge batches survive retained-history pruning and still close later live issues', () => {
  for (const source of ['local', 'github']) {
    const t = setup();
    t.store.updateIssue(t.issue.id, { status: 'done' }, 2000);
    for (let i = 2; i <= 50; i++) t.store.addIssue({ text: `Old done ${i}`, projectId: 'p1', by: 'user', status: 'done' }, 2000 + i);
    const first = t.store.addIssue({ text: 'First new issue', projectId: 'p1', by: 'user' }, 10000);
    const last = t.store.addIssue({ text: 'Last new issue', projectId: 'p1', by: 'user' }, 10001);
    let reads = 0;
    const store: IssueLinkStore = { issues: () => { reads++; return t.store.issues(); }, updateIssue: (id, patch, now, by) => t.store.updateIssue(id, patch, now, by) };
    const links = new IssueLinks(store, () => 40000);
    const keys = [first.key, t.issue.key, last.key];
    if (source === 'local') {
      const records = keys.map((key, i): MergeRecord => ({ hash: ['a', 'b', 'c'][i].repeat(40), branch: `feat/${key}-retention`, at: 30000 + i * 1000, tree: '', tip: '', subject: 'Merge the issue', names: [], refs: [] }));
      assert.equal(links.localMerges(t.project, records), 2);
    } else {
      const prs = keys.map((key, i): MergedIssuePr => ({ repo: 'a/b', number: i + 1, projects: [{ id: 'p1' }], state: 'merged', branch: `feat/${key}-retention`, title: 'Ship', mergedAt: new Date(30000 + i * 1000).toISOString(), mergeCommit: ['a', 'b', 'c'][i].repeat(40) }));
      assert.equal(links.githubMerges(prs), 2);
    }
    assert.equal(reads, 1, source);
    assert.equal(t.store.issue(first.id).status, 'done');
    assert.equal(t.store.issue(last.id).status, 'done');
    assert.throws(() => t.store.issue(t.issue.id), (err: unknown) => err instanceof HttpError && err.status === 404);
  }
});

test('merge batches propagate store errors other than missing retained issues', () => {
  const t = setup();
  const store: IssueLinkStore = { issues: () => t.store.issues(), updateIssue: () => { throw new HttpError(500, 'Store failed'); } };
  const links = new IssueLinks(store);
  const record: MergeRecord = { hash: 'a'.repeat(40), branch: 'feat/ACH-1-fail', at: 2000, tree: '', tip: '', subject: 'Merge', names: [], refs: [] };
  assert.throws(() => links.localMerges(t.project, [record]), /Store failed/);
});
