import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent } from '../shared/types.ts';
import { reportedPlan, outputRecords, type PlanSource, type ProducedSnapshot } from '../web/right/overviewModel.ts';
const a={id:'a',name:'Ellis',projectIds:['p'],turnStartedAt:100} as Agent;
const withPlan=(plan:PlanSource|null)=>({...a,plan});
test('only a reported current-turn plan renders; absent, malformed and stale plans stay hidden',()=>{
  assert.equal(reportedPlan(a),null);
  assert.equal(reportedPlan(withPlan(null)),null);
  assert.equal(reportedPlan(withPlan({updatedAt:101,engine:'codex',steps:'bad' as never})),null);
  assert.equal(reportedPlan(withPlan({updatedAt:101,engine:'codex',steps:[null as never]})),null);
  assert.equal(reportedPlan(withPlan({updatedAt:99,engine:'codex',steps:[{text:'Old',status:'done'}]})),null);
  assert.deepEqual(reportedPlan(withPlan({updatedAt:101,engine:'claude',steps:[{text:'Read',status:'done'},{text:'Check',status:'active'},{text:'Review',status:'pending'}]})),{steps:[{text:'Read',status:'completed'},{text:'Check',status:'in_progress'},{text:'Review',status:'pending'}]});
  assert.equal(reportedPlan(withPlan({updatedAt:101,engine:'codex',steps:[{text:'Unknown',status:'bad' as never}]})),null);
});
test('idle keeps the last reported plan without inventing completed remaining steps',()=>{
  const agent={...a,turnStartedAt:null,plan:{updatedAt:99,engine:'codex' as const,steps:[{text:'Still pending',status:'pending' as const}]}};
  assert.equal(reportedPlan(agent)?.steps[0].status,'pending');
});
test('outputs keep uncommitted snapshots distinct, mark shared attribution, and label reports as reported',()=>{
  const source:ProducedSnapshot={at:1000,where:{folder:'/fixture',branch:'feat/search',own:false},uncommitted:{files:2,added:8,removed:3},commits:[],walkthroughs:[{id:'w',title:'Search demo',createdAt:500}],reports:[{messageId:'r',conversationId:'c',toAgentId:'s',toName:'Lead',outcome:'blocked',summary:'Missing fixture',at:600}]};
  const rows=outputRecords(a,source);
  assert.equal(rows[0].title,'2 uncommitted files');
  assert.match(rows[0].detail,/shared checkout, attribution unknown/);
  assert.ok(rows.find(i=>i.kind==='report')?.detail.includes('Ellis’s report'));
  assert.equal(rows.find(i=>i.kind==='report')?.needsUser,undefined,'a blocked report does not imply a user approval');
  assert.equal(outputRecords(a,{...source,uncommitted:null,walkthroughs:[],reports:[]}).length,0);
});
