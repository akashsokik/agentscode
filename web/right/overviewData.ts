import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../../shared/types.ts';
import { api } from '../api.ts';
import { open, openToSide, setProject } from '../layout.ts';
import { attempt, useApp } from '../store.ts';
import { setWorkUi } from '../work/workData.ts';

import { outputRecords, type OverviewTarget, type ProducedSnapshot, type OverviewOutputRecord } from './overviewModel.ts';
export type OverviewOutputView = OverviewOutputRecord & {open:()=>void};
function navigate(target:OverviewTarget){
  if(target.kind==='diff')return void attempt(async()=>{const git=await api.gitStatus({agent:target.agentId});if(git.files[0])openToSide({kind:'diff',root:{agent:target.agentId},path:git.files[0].path});});
  if(target.kind==='commit'){if(target.projectId){setProject(target.projectId);setWorkUi(target.projectId,{tab:'graph',selected:{kind:'commit',id:target.hash}});}open({kind:'work'});}
  else if(target.kind==='walkthrough')open({kind:'walkthrough',agentId:target.agentId,id:target.id,title:target.title});
  else openToSide({kind:'comms',conversationId:target.conversationId});
}
/** Only while Overview is mounted; old/missing endpoints yield no invented output. */
export function useOverviewData(agent:Agent,team:boolean):{produced:OverviewOutputView[]} {
  const agents=useApp(s=>s.snapshot?.agents);
  const list=team?(agents??[]):[agent];
  const signature=list.map(a=>`${a.id}:${a.status}:${a.turns}`).join('|');
  const [snapshots,setSnapshots]=useState<Record<string,ProducedSnapshot>>({});
  const opened=useRef({scope:'',ids:new Set<string>()});
  useEffect(()=>{
    let alive=true,running=false;
    const scope=`${team?'team':'agent'}:${agent.id}`;
    if(opened.current.scope!==scope)opened.current={scope,ids:new Set()};
    setSnapshots({});
    const load=async()=>{
      if(running)return;running=true;
      const next:Record<string,ProducedSnapshot>={};let cursor=0;
      const worker=async()=>{while(alive&&cursor<list.length){const a=list[cursor++];try{
        // An opening needs current disk state; turn-end/timer refreshes use the server cache.
        const fresh=!opened.current.ids.has(a.id);
        opened.current.ids.add(a.id);
        const response=await fetch(`/api/agents/${encodeURIComponent(a.id)}/produced${fresh?'?fresh=1':''}`);
        if(!response.ok)continue;
        const data=await response.json() as ProducedSnapshot;
        if(Array.isArray(data.commits)&&Array.isArray(data.walkthroughs)&&Array.isArray(data.reports))next[a.id]=data;
      }catch{/* Older backend or unavailable source: omit it. */}}};
      await Promise.all(Array.from({length:Math.min(3,list.length)},worker));
      if(alive)setSnapshots(next);running=false;
    };
    void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},15_000);
    return()=>{alive=false;clearInterval(timer);};
    // IDs/status/turns invalidate output; activity updates alone never trigger a git scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[agent.id,team,signature]);
  const produced=useMemo(()=>{
    const found=new Map<string,OverviewOutputView>();
    for(const a of list){const source=snapshots[a.id];if(!source)continue;for(const item of outputRecords(a,source)){if(!found.has(item.id))found.set(item.id,{...item,open:()=>navigate(item.target)});}}
    return [...found.values()].sort((a,b)=>b.at-a.at).slice(0,12);
  },[snapshots,signature]);
  return {produced};
}
