import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent } from '../shared/types.ts';
import { overviewNow } from '../web/right/overviewPresentation.ts';
const agent = {status:'working',currentTask:{summary:'Fix search'},activity:'Running the checks',turnStartedAt:1_000,lastSummary:'Previous result',error:null} as Agent;
test('Overview working/waiting reads current work and elapsed, without inventing completion',()=>{
  assert.deepEqual(overviewNow(agent,61_000),{busy:true,title:'Fix search',activity:'Running the checks',elapsedMs:60_000,state:'Working'});
  assert.equal(overviewNow({...agent,status:'waiting'},61_000).state,'Waiting for you');
  assert.equal(overviewNow({...agent,turnStartedAt:null},61_000).elapsedMs,null);
});
test('idle shows the last result instead of a stale current task; errors stay visible',()=>{
  assert.equal(overviewNow({...agent,status:'done'},61_000).title,'Previous result');
  assert.equal(overviewNow({...agent,status:'idle',lastSummary:''},61_000).title,'Ready for the next task.');
  assert.equal(overviewNow({...agent,status:'error',error:'Check failed'},61_000).activity,'Check failed');
});
