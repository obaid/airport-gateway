import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createToolRunner,makeAgentHandler} from './agent.mjs';
import {BETA_END,BETA_START,BETA_LIMIT,readBetaUsage} from './beta-usage.mjs';
import {createStore} from './store.mjs';

const httpExchange={channel:'http',request:{method:'GET',path:'/api/gmail/inbox-counts'}};
const mcpExchange={channel:'mcp',request:{method:'tools/call'}};
const read='gmail_inbox_counts';
function fileFor(t) {
  const dir=mkdtempSync(join(tmpdir(),'airport-beta-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return join(dir,'tenant.sqlite3');
}
function openPilot(store) {
  const {attempt}=store.begin('personal','tester@example.test');
  store.attach('personal',attempt,'ca_fixture');
  store.activate('personal',attempt,'tester@example.test');
  store.setPolicy('personal','Allow');
  return store.issueConnectorGrant('personal').token;
}

test('the last free action is reserved across workspaces and protocols, released on failure, and preserved on restart',async t=>{
  const at=Date.parse(BETA_START)+3600_000;
  t.mock.method(Date,'now',()=>at);
  const file=fileFor(t);
  let store=createStore(file,{publicBeta:true});
  const token=openPilot(store);
  const conn=store.createConnection('work',{toolkit:'notion',label:'Work Notes'});
  store.attachConnection('work',conn.id,'ca_notes');
  store.activateConnection('work',conn.id,'ca_notes');
  const tool={toolkit:'notion',slug:'NOTION_LIST_PAGES',version:'20261101_00',name:'List pages',inputSchema:{type:'object',properties:{}}};
  const pin=store.setToolPolicy('work',conn.id,tool,true);
  const tokenB=store.issueAgentGrant('work','Notes Agent','forever').token;
  // Earlier activity from the same day is the source of truth, regardless of display name.
  for(let n=0;n<BETA_LIMIT-1;n++)store.log('personal','Owner console',read,'Allowed',true,'Read',httpExchange);
  store.log('work','Notes Agent','airport_list_connections','Allowed',false,'Discovered',mcpExchange);
  store.log('work','Owner console',read,'Allowed',true,'Owner test',{channel:'owner',request:{}});
  store.close();store=createStore(file,{publicBeta:true});
  const reader=new DatabaseSync(file,{readOnly:true});
  const otherStore=createStore(file,{publicBeta:true,recoverOnOpen:false});
  t.after(()=>{reader.close();otherStore.close();store.close();});
  const started=Promise.withResolvers(),response=Promise.withResolvers();
  let calls=0,reads=0;
  const run=createToolRunner({store,getProvider:()=>({counts:async()=>{reads++;return {total:9,unread:4};}}),getCatalog:()=>({
    async execute({beforeDispatch}) {calls++;beforeDispatch(tool);started.resolve();return response.promise;}
  })});
  const server=createServer(makeAgentHandler({store,run,publicURL:'https://mcp.airport.example'}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port;
  const http=()=>fetch(base+'/api/gmail/inbox-counts',{headers:{authorization:'Bearer '+token}});
  const mcp=name=>fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+tokenB,'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}})}).then(r=>r.json());
  const pending=mcp(pin.mcpName);await started.promise;
  assert.equal(otherStore.startToolRequest('personal','Muse',read,'Read',httpExchange),null);
  const blocked=await http();assert.equal(blocked.status,429);assert.equal((await blocked.json()).code,'account_action_limit');
  assert.equal(reads,0);assert.equal(store.billingUsage().used,999);
  assert.equal(readBetaUsage(reader,at).providerAttempts,1001); // 999 reads, one owner test, one running provider call.
  response.reject(Error('Provider failed'));assert.equal((await pending).result.isError,true);
  assert.equal((await http()).status,200);assert.equal(reads,1);
  assert.equal(store.billingUsage().used,BETA_LIMIT);
  assert.equal((await mcp(pin.mcpName)).result.isError,true);assert.equal(calls,1);
  assert.equal((await mcp('airport_list_connections')).result.isError,false);
  assert.equal(readBetaUsage(reader,at).limitDenials,2);
  assert.equal(readBetaUsage(reader,at).agentFailures,1);
  assert.equal(readBetaUsage(reader,at).policyDenials,0);
  assert.equal(readBetaUsage(reader,at).providerAttempts,1002);
  assert.equal((await run({workspace:'personal',actor:'Owner console'},read)).outcome,'Allowed');
  assert.equal(store.billingUsage().remaining,0);assert.equal(reads,2);
  store.close();store=createStore(file,{publicBeta:true});
  assert.equal(store.billingUsage().used,1000);
  assert.equal(readBetaUsage(reader,at).providerAttempts,1003);
  const separate=createStore(':memory:',{publicBeta:true});
  try{assert.equal(separate.billingUsage().used,0);}finally{separate.close();}
});

test('usage boundaries, billing breakdown, interrupted reservations, and a free continuation use request start time',t=>{
  let at=Date.parse(BETA_START)-1;
  t.mock.method(Date,'now',()=>at);
  const file=fileFor(t);
  let store=createStore(file,{publicBeta:true});
  const reader=new DatabaseSync(file,{readOnly:true});
  t.after(()=>{store.close();reader.close();});
  const start=ws=>store.startToolRequest(ws,'Agent',read,'Read',httpExchange,null,true);
  const success=ws=>store.finish(start(ws),'Allowed','Read',{});
  success('work');assert.equal(store.billingUsage().status,'upcoming');
  at++;success('work');
  const interrupted=start('work');
  store.close();store=createStore(file,{publicBeta:true});
  assert.equal(store.state().logs.find(row=>row.id===interrupted).outcome,'Interrupted');
  at=Date.parse(BETA_START)+86_400_000-1;success('work');
  at++;store.log('work','Agent',read,'Blocked',false,'Workspace policy',mcpExchange);
  at=Date.parse(BETA_END)-1;
  const last=start('personal');
  at++;store.finish(last,'Allowed','Read',{});success('personal');
  const current=store.billingUsage();
  assert.equal(current.status,'continued');assert.equal(current.periodStart,BETA_END);assert.equal(current.used,1);
  assert.deepEqual(current.byWorkspace.map(w=>[w.name,w.used]),[['Personal',1],['Work',0]]);
  const launch=readBetaUsage(reader,at);
  assert.equal(launch.used,3);assert.equal(launch.providerAttempts,4);
  assert.equal(launch.agentFailures,1);assert.equal(launch.policyDenials,1);
  assert.deepEqual(launch.daily,[
    {day:'2026-11-22',used:2,providerAttempts:3},
    {day:'2026-11-23',used:0,providerAttempts:0},
    {day:'2026-12-21',used:1,providerAttempts:1}
  ]);
  assert.equal(readBetaUsage(reader,at,'current').used,1);
  store.close();store=createStore(file);assert.equal(store.billingUsage(),null);
  for(let n=0;n<BETA_LIMIT;n++)success('work');
  assert.ok(start('work'),'self-hosted stores remain unlimited by default');
});

test('historical admin monitoring reads legacy receipt schemas without migrations or private output',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    const at=Date.parse(BETA_START)+1;
    assert.equal(readBetaUsage(db,at).used,0);
    db.exec(`CREATE TABLE requests(id,workspace,at,actor,tool,outcome,providerCalled,detail);
      CREATE TABLE request_exchanges(request_id,channel,request_json,response_json);`);
    const r=db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?)');
    const x=db.prepare('INSERT INTO request_exchanges VALUES(?,?,?,?)');
    for(const [id,outcome,dispatched] of [[1,'Allowed',true],[2,'Failed',true],[3,'Blocked',false]]){
      r.run(id,'private-workspace',at,'private name','c_example',outcome,1,'Private audit');
      x.run(id,'mcp','{}',JSON.stringify({dispatched}));
    }
    const report=readBetaUsage(db,at);assert.equal(report.used,1);assert.equal(report.providerAttempts,2);
    assert.doesNotMatch(JSON.stringify(report),/private|c_example/i);
  }finally{db.close();}
});
