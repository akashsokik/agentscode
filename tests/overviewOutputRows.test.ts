import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent } from '../shared/types.ts';
import { outputRecords, type ProducedSnapshot } from '../web/right/overviewModel.ts';
const a={id:'a',name:'Ellis',projectIds:['p'],turnStartedAt:100} as Agent;
test('outputs keep uncommitted snapshots distinct, mark shared attribution, and label reports as reported',()=>{
  const source:ProducedSnapshot={at:1000,where:{folder:'/fixture',branch:'feat/search',own:false},uncommitted:{files:2,added:8,removed:3},commits:[],walkthroughs:[{id:'w',title:'Search demo',createdAt:500}],reports:[{messageId:'r',conversationId:'c',toAgentId:'s',toName:'Lead',outcome:'blocked',summary:'Missing fixture',at:600}]};
  const rows=outputRecords(a,source);
  assert.equal(rows[0].title,'2 uncommitted files');
  assert.match(rows[0].detail,/shared checkout, attribution unknown/);
  assert.ok(rows.find(i=>i.kind==='report')?.detail.includes('Ellis’s report'));
  assert.equal(rows.find(i=>i.kind==='report')?.needsUser,undefined,'a blocked report does not imply a user approval');
  assert.equal(outputRecords(a,{...source,uncommitted:null,walkthroughs:[],reports:[]}).length,0);
});
