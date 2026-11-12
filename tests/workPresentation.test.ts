import assert from 'node:assert/strict';
import test from 'node:test';
import { AVATAR_FILL, agentLook } from '../shared/avatar.ts';
import type { Agent } from '../shared/types.ts';
import type { WorkBranch, WorkCommit, WorkMerge, WorkProject } from '../shared/work.ts';
import { branchStatus, commitIdentity, mergeStatus, refWork, workIdentity, workOwner } from '../web/work/workPresentation.ts';

const ada = { id: 'ada', name: 'Ada', role: 'dev', avatar: { shape: 'disc', color: 'amber', eyes: 'wide' } } as Agent;

test('Work owner colours follow the stored avatar, with a neutral unknown and stable removed-agent fallback', () => {
  assert.equal(workOwner([ada], undefined, ' ada ').colour, AVATAR_FILL.amber);
  assert.equal(workOwner([{ ...ada, avatar: { ...ada.avatar!, color: 'plum' } }], 'ada').colour, AVATAR_FILL.plum);
  assert.equal(workOwner([ada], undefined, 'unowned/branch').colour, undefined);
  assert.equal(workOwner([ada]).name, undefined);
  assert.equal(workOwner([ada], 'removed', 'Ada').colour, AVATAR_FILL[agentLook({ id: 'removed' }).color], 'a removed ID is not reassigned to a same-name agent');
  const removedFirst = workIdentity({ names: ['Former agent', 'Ada'], agentIds: ['ada'] } as WorkMerge);
  assert.deepEqual(removedFirst, { id: undefined, name: 'Former agent' });
  assert.equal(workOwner([ada], removedFirst.id, removedFirst.name).colour, undefined, 'a later owner cannot silently replace the removed primary owner');
});

test('a ref resolves its own branch owner, not the owner of the commit it shares', () => {
  const branch = { branch: 'feat/ada', agentId: 'ada', agentName: 'Ada' } as WorkBranch;
  const project = { defaultBranch: 'main', inProgress: [branch], merged: [], laneOwners: { Ada: 'ada' } } as unknown as WorkProject;
  assert.equal(refWork(project, { kind: 'local', name: 'main' }), undefined);
  assert.equal(refWork(project, { kind: 'remote', name: 'origin/feat/ada' }), branch);
  assert.equal(refWork(project, { kind: 'tag', name: 'feat/ada' }), undefined);
  const commit = { agentIds: [], names: [], refs: [{ kind: 'local', name: 'feat/ada' }], key: null } as unknown as WorkCommit;
  assert.deepEqual(commitIdentity(project, commit), { id: 'ada', name: 'Ada' });
  assert.deepEqual(commitIdentity(project, { ...commit, refs: [], key: 'Ada' }), { id: 'ada', name: 'Ada' });
  assert.deepEqual(commitIdentity(project, { ...commit, names: ['Former agent', 'Ada'], agentIds: ['ada'] }), { id: undefined, name: 'Former agent' }, 'a recorded unknown owner is not replaced by the ref owner');
});

test('uncommitted edits do not look ready to merge, and unknown remote status is never shown as pushed', () => {
  const clean = { state: 'approved', changed: 0, untracked: 0 } as WorkBranch;
  assert.equal(branchStatus(clean).tone, 'success');
  assert.equal(branchStatus({ ...clean, untracked: 1 }).tone, 'warning');
  assert.equal(branchStatus({ ...clean, state: 'working' }).tone, 'info');
  assert.equal(mergeStatus({ pushed: true } as never).tone, 'success');
  assert.equal(mergeStatus({ pushed: false } as never).tone, 'info');
  assert.equal(mergeStatus({ pushed: null } as never).tone, 'neutral');
});
