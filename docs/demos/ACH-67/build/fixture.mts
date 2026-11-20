/** Built-UI fixture only: temp HOME, temp PODCODE_HOME, FakeRunner, loopback, real user-key login. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'podcode-ach67-ui-'));
process.env.HOME=home;process.env.PODCODE_HOME=path.join(home,'.podcode');process.env.PORT='4777';
const {Store}=await import('../../../../server/store.ts');
const {AgentManager}=await import('../../../../server/manager.ts');
const {Hub}=await import('../../../../server/hub.ts');
const {UserKey}=await import('../../../../server/userAuth.ts');
const {createServer}=await import('../../../../server/app.ts');
const {FakeRunner}=await import('../../../../tests/helpers.ts');
const {UsageTracker}=await import('../../../../server/usage.ts');
const {gitEnv}=await import('../../../../server/envHygiene.ts');
const store=new Store(process.env.PODCODE_HOME);store.load();store.settings.superWake=false;store.settings.superPaused=true;
const hub=new Hub();const engines=Object.fromEntries(['claude','codex','orcacode'].map(k=>[k,{available:true,path:'/usr/bin/false',version:'0.0.0'}])) as ConstructorParameters<typeof AgentManager>[2];
const manager=new AgentManager(store,hub,engines,{createRunner:ctx=>new FakeRunner(ctx),dreamEngine:async()=>({text:'{}',tokens:0,costUsd:0}),worktreesRoot:path.join(home,'worktrees')});manager.init();
UsageTracker.prototype.usage=async engine=>({engine,windows:[],fetchedAt:Date.now()});
const repo=path.join(home,'search-app');fs.mkdirSync(repo,{recursive:true});
function git(args:string[]){return execFileSync('git',args,{cwd:repo,env:gitEnv(),encoding:'utf8'}).trim()}
git(['init','-b','main']);git(['config','user.name','Demo']);git(['config','user.email','demo@example.invalid']);fs.writeFileSync(path.join(repo,'SearchView.tsx'),'export const selected = false;\n');git(['add','.']);git(['commit','-m','Initial search view']);
const project=manager.addProject({path:repo,name:'Search app'});
const ids:Record<string,string>={};
const produced:Record<string,unknown>={};
for(const [state,name] of [['working','Ellis'],['waiting','Rowan'],['idle','June']] as const){
  const a=await manager.create({name,engine:'codex',projectIds:[project.id],role:'dev',worktree:true,branch:`feat/search-${state}`});ids[state]=a.id;a.dreaming=false;
  fs.writeFileSync(path.join(a.worktree!.path,'SearchView.tsx'),'export const selected = true;\n');git(['-C',a.worktree!.path,'add','.']);git(['-C',a.worktree!.path,'commit','-m','Keep the selected result in view']);fs.appendFileSync(path.join(a.worktree!.path,'SearchView.tsx'),'export const keyboard = true;\n');
  a.status=state==='idle'?'done':state;a.activity=state==='working'?'Running the search checks.':state==='waiting'?'Paused at the empty-state decision.':'';a.currentTask=state==='idle'?null:{summary:'Keep keyboard search in place.',source:'user'};a.turnStartedAt=state==='idle'?null:Date.now()-360_000;a.lastActiveAt=Date.now()-480_000;a.lastSummary='Keyboard search is ready.';

  produced[a.id]={at:Date.now(),where:{folder:a.worktree!.path,branch:a.worktree!.branch,own:true},commits:state==='working'?[{hash:git(['-C',a.worktree!.path,'rev-parse','HEAD']),subject:'Keep the selected result in view',at:Date.now()-480_000}]:[],uncommitted:state==='working'?{files:1,added:1,removed:0}:null,walkthroughs:state==='working'?[{id:'20261120-00000001',title:'Keyboard search, ready to try',createdAt:Date.now()-600_000}]:[],reports:state==='working'?[{messageId:'fixture-report',conversationId:'fixture-conversation',toAgentId:'lead',toName:'SuperAgent',outcome:'passed',summary:'Search tests passed',at:Date.now()-720_000}]:[]};
  store.appendEntry({id:`turn-${state}`,agentId:a.id,kind:'turn',ts:Date.now()-360_000,text:'',turn:{source:'user'}});

}
const lead=await manager.create({name:'SuperAgent',engine:'codex',projectIds:null},{super:true});ids.team=lead.id;lead.dreaming=false;lead.status='idle';
// Seed an actual existing-shape pending question; no live provider is involved.
const a={id:'demo-question',agentId:ids.waiting,createdAt:Date.now()-120_000,type:'question',toolName:'AskUserQuestion',title:'Search empty state',detail:'',description:'',canAlwaysAllow:false,questions:[{header:'Empty state',question:'Which empty state should the search use?',options:[{label:'Keep the helpful hint',description:''},{label:'Keep it minimal',description:''}],multiSelect:false}]} as const;
const pending=(manager as unknown as {approvals:Map<string,unknown>}).approvals;
pending.set(a.id,{approval:a,finish:()=>{pending.delete(a.id);hub.broadcast({type:'snapshot',snapshot:manager.snapshot()});},drop:()=>{pending.delete(a.id);}});
store.flush();
const auth=new UserKey();const server=createServer(manager,hub,{distDir:path.resolve('dist'),auth});
server.listen(4777,'127.0.0.1',()=>{const info={home,ids,produced,project:project.id,url:`http://127.0.0.1:4777/login?code=${auth.newLoginCode()}`};fs.writeFileSync(path.join(home,'fixture.json'),JSON.stringify(info));console.log(JSON.stringify(info));});
async function stop(){server.close();await manager.shutdown();process.exit(0)}process.on('SIGINT',stop);process.on('SIGTERM',stop);
