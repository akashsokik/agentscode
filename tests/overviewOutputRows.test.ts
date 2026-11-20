import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent } from '../shared/types.ts';
import { outputRecords, overviewOutputRecords, type ProducedSnapshot } from '../web/right/overviewModel.ts';
const a={id:'a',name:'Ellis',projectIds:['p'],turnStartedAt:100} as Agent;
test('outputs keep uncommitted snapshots distinct, mark shared attribution, and label reports as reported',()=>{
  const source:ProducedSnapshot={at:1000,where:{folder:'/fixture',branch:'feat/search',own:false},uncommitted:{files:2,added:8,removed:3},commits:[],walkthroughs:[{id:'w',title:'Search demo',createdAt:500}],reports:[{messageId:'r',conversationId:'c',toAgentId:'s',toName:'Lead',outcome:'blocked',summary:'Missing fixture',at:600}]};
  const rows=outputRecords(a,source);
  assert.equal(rows[0].title,'2 uncommitted files');
  assert.match(rows[0].detail,/shared checkout, attribution unknown/);
  assert.ok(rows.find(i=>i.kind==='report')?.detail.includes('Ellis’s report'));
  assert.ok(!('needsUser' in rows.find(i=>i.kind==='report')!),'a blocked report does not imply a user approval');
  assert.equal(outputRecords(a,{...source,uncommitted:null,walkthroughs:[],reports:[]}).length,0);
});

test('team commits dedupe by hash across worktrees and attribute known source branches, not an invented author',()=>{
  const b={...a,id:'b',name:'Rowan'};
  const source:ProducedSnapshot={at:1000,where:{folder:'/a',branch:'feat/a',own:true},uncommitted:null,commits:[{hash:'shared-hash',subject:'Shared change',at:900},{hash:'only-a',subject:'Ellis change',at:800}],walkthroughs:[],reports:[]};
  const snapshots={a:source,b:{...source,where:{folder:'/b',branch:'feat/b',own:true},commits:[source.commits[0]]}};
  const rows=overviewOutputRecords([a,b],snapshots,true);
  assert.equal(rows.filter(r=>r.kind==='commit').length,2);
  const shared=rows.find(r=>r.target.kind==='commit'&&r.target.hash==='shared-hash')!;
  assert.equal(shared.id,'commit:shared-hash');
  assert.match(shared.detail,/Ellis, Rowan/);
  assert.doesNotMatch(shared.detail,/author|made by/);
  assert.match(rows.find(r=>r.title==='Ellis change')!.detail,/Ellis’s branch/);
  assert.equal(overviewOutputRecords([a,b],snapshots,false).filter(r=>r.kind==='commit').length,3,'individual records retain their worktree identities');
});

test('team walkthroughs and reports dedupe by their stable ids while changes remain per folder',()=>{
  const b={...a,id:'b',name:'Rowan'};
  const source:ProducedSnapshot={at:10,where:{folder:'/a',branch:'feat/a',own:true},uncommitted:{files:1,added:1,removed:0},commits:[],walkthroughs:[{id:'w',title:'One tour',createdAt:8}],reports:[{messageId:'r',conversationId:'c',toAgentId:'s',toName:'Lead',outcome:'passed',summary:'One result',at:9}]};
  const rows=overviewOutputRecords([a,b],{a:source,b:{...source,where:{folder:'/b',branch:'feat/b',own:true}}},true);
  assert.deepEqual(rows.map(r=>r.kind).sort(),['diff','diff','report','walkthrough']);
});
