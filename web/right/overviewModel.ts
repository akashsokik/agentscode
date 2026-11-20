import type { Agent, AgentProduced } from '../../shared/types.ts';
export type OverviewTarget = {kind:'diff';agentId:string}|{kind:'commit';projectId:string|undefined;hash:string}|{kind:'walkthrough';agentId:string;id:string;title:string}|{kind:'report';conversationId:string};
export type ProducedSnapshot = AgentProduced;
export interface OverviewOutputRecord {id:string;kind:'diff'|'commit'|'walkthrough'|'report';title:string;detail:string;at:number;outcome?:string;target:OverviewTarget}
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

/** A team shares commit objects across worktrees. Show one hash, with honest source attribution. */
export function overviewOutputRecords(agents:Agent[], snapshots:Record<string,ProducedSnapshot>, team:boolean):OverviewOutputRecord[] {
  const found=new Map<string,OverviewOutputRecord>();
  const branches=new Map<string,Map<string,string>>();
  for(const agent of agents){
    const source=snapshots[agent.id];if(!source)continue;
    for(const item of outputRecords(agent,source)){
      const target=item.target;
      const key=team&&target.kind==='commit'?`commit:${target.hash}`
        :team&&target.kind==='walkthrough'?`walkthrough:${target.id}`:item.id;
      if(!found.has(key))found.set(key,{...item,id:key});
      if(team&&target.kind==='commit'&&source.where?.own){
        if(!branches.has(key))branches.set(key,new Map());
        branches.get(key)!.set(agent.id,agent.name);
      }
    }
  }
  for(const [key,namesByAgent] of branches){
    const item=found.get(key)!;
    if(item.target.kind!=='commit')continue;
    const names=[...namesByAgent.values()];
    // The API does not provide authorship. Branch ownership is known; the author is not.
    item.detail=`${item.target.hash.slice(0,7)} · ${names.length===1?`${names[0]}’s branch`:`Branches: ${names.join(', ')}`}`;
  }
  return [...found.values()].sort((a,b)=>b.at-a.at).slice(0,12);
}
