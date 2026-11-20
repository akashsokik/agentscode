import type { Agent } from '../../shared/types.ts';
export type OverviewTarget = {kind:'diff';agentId:string}|{kind:'commit';projectId:string|undefined;hash:string}|{kind:'walkthrough';agentId:string;id:string;title:string}|{kind:'report';conversationId:string};
/** Structural ACH-73 fallback while the server/shared-types commit is integrated. */
export interface PlanSource {steps:{text:string;status:'done'|'active'|'pending'}[];updatedAt:number;engine:'claude'|'codex'}
export interface ProducedSnapshot {
  at:number;
  where:{folder:string;branch:string|null;own:boolean}|null;
  commits:{hash:string;subject:string;at:number}[];
  uncommitted:{files:number;added:number;removed:number}|null;
  walkthroughs:{id:string;title:string;createdAt:number;branch?:string;commit?:string}[];
  reports:{messageId:string;conversationId:string;toAgentId:string;toName:string;outcome:'passed'|'failed'|'blocked'|'done';summary:string;at:number}[];
}
export interface OverviewPlanView {steps:{text:string;status:'completed'|'in_progress'|'pending'}[]}
export interface OverviewOutputRecord {id:string;kind:'diff'|'commit'|'walkthrough'|'report';title:string;detail:string;at:number;outcome?:string;needsUser?:boolean;target:OverviewTarget}
export function reportedPlan(agent:Agent):OverviewPlanView|null {
  const plan=(agent as Agent&{plan?:PlanSource|null}).plan;
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length || !Number.isFinite(plan.updatedAt) || (agent.turnStartedAt && plan.updatedAt < agent.turnStartedAt)) return null;
  if (!plan.steps.every(s=>s && typeof s.text==='string'&&['done','active','pending'].includes(s.status))) return null;
  return {steps:plan.steps.map(s=>({text:s.text,status:s.status==='done'?'completed':s.status==='active'?'in_progress':'pending'}))};
}
export function outputRecords(agent:Agent, source:ProducedSnapshot):OverviewOutputRecord[] {
  const projectId=agent.workingIn?.projectId || agent.projectIds?.[0];
  const place=source.where?.branch || 'Branch unknown';
  const items:OverviewOutputRecord[]=[];
  if(source.uncommitted?.files)items.push({id:`diff:${source.where?.folder||agent.id}`,kind:'diff',title:`${source.uncommitted.files} uncommitted ${source.uncommitted.files===1?'file':'files'}`,detail:`+${source.uncommitted.added} −${source.uncommitted.removed} · ${place} · ${source.where?.own?'current snapshot':'shared checkout, attribution unknown'}`,at:source.at,target:{kind:'diff',agentId:agent.id}});
  for(const c of source.commits??[])items.push({id:`commit:${source.where?.folder}:${c.hash}`,kind:'commit',title:c.subject,detail:`${c.hash.slice(0,7)} · branch commit`,at:c.at,target:{kind:'commit',projectId,hash:c.hash}});
  for(const w of source.walkthroughs??[])items.push({id:`walkthrough:${agent.id}:${w.id}`,kind:'walkthrough',title:w.title,detail:`Walkthrough`,at:w.createdAt,target:{kind:'walkthrough',agentId:agent.id,id:w.id,title:w.title}});
  for(const r of source.reports??[])items.push({id:`report:${r.messageId}`,kind:'report',title:r.summary,detail:`${agent.name}’s report · ${r.outcome}`,at:r.at,outcome:r.outcome,target:{kind:'report',conversationId:r.conversationId}});
  return items;
}
