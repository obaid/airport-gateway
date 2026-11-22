import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { catalogToolRestriction, createStore } from './store.mjs';
import { createToolRunner, makeAgentHandler } from './agent.mjs';

const tool = {
  toolkit:'notion',slug:'NOTION_LIST_PAGES',version:'20261110_00',name:'List pages',
  description:'List pages in the connected workspace.',
  inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}
};
function setup(t) {
  const store=createStore(':memory:');
  t.after(()=>store.close());
  return store;
}
function connect(store, ws, account, toolkit='notion') {
  const c=store.createConnection(ws,{toolkit,label:'Selected account'});
  store.attachConnection(ws,c.id,account);
  return store.activateConnection(ws,c.id,account);
}

test('connection and version-specific tools stay in the selected workspace and account', t=>{
  const s=setup(t);
  const custom=s.createWorkspace('Research');
  const a=connect(s,custom.id,'ca_research'),b=connect(s,custom.id,'ca_second'),other=connect(s,'work','ca_work');
  assert.deepEqual(s.approvedTools(custom.id),[]);
  assert.throws(()=>s.getConnection('work',a.id),{status:404});
  assert.throws(()=>s.disableConnection('work',a.id),{status:404});
  assert.throws(()=>s.setToolPolicy(custom.id,a.id,{...tool,toolkit:'other'},true),{status:409});
  const a1=s.setToolPolicy(custom.id,a.id,tool,true),b1=s.setToolPolicy(custom.id,b.id,tool,true),other1=s.setToolPolicy('work',other.id,tool,true);
  assert.equal(new Set([a1,b1,other1].map(v=>v.mcpName)).size,3);
  assert.equal(s.resolveTool('work',a1.mcpName),null);
  assert.equal(s.resolveTool(custom.id,a1.mcpName).account,'ca_research');
  const a2=s.setToolPolicy(custom.id,a.id,{...tool,version:'20261111_00'},true);
  assert.notEqual(a1.mcpName,a2.mcpName);
  assert.equal(s.resolveTool(custom.id,a1.mcpName),null);
  s.blockTool(custom.id,a.id,tool.slug);
  assert.deepEqual(s.listToolPolicies(custom.id,a.id),[]);
  assert.equal(s.listToolPolicies(custom.id,b.id).length,1);
  assert.equal(s.listConnections(custom.id).find(conn=>conn.id===b.id).tools[0].allowed,true);
  s.disableConnection(custom.id,b.id);
  assert.equal(s.resolveTool(custom.id,b1.mcpName),null);
  assert.throws(()=>s.activateConnection(custom.id,b.id,b.account),{status:409});
  const duplicate=s.createConnection('personal',{toolkit:'notion'});
  assert.throws(()=>s.attachConnection('personal',duplicate.id,'ca_work'),{status:409});
  const pilot=s.begin('personal','me@example.com');
  assert.throws(()=>s.attach('personal',pilot.attempt,'ca_work'),{status:409});
  assert(!JSON.stringify(s.state()).includes('ca_work'));
  assert(!JSON.stringify(s.state()).includes(a.owner));
});

test('catalog-only workspaces issue and revoke named and legacy credentials independently',t=>{
  const s=setup(t);
  const ws=s.createWorkspace('New').id;
  const c=connect(s,ws,null,'weather');
  const muse=s.issueConnectorGrant(ws),first=s.issueAgentGrant(ws,'First'),second=s.issueAgentGrant(ws,'Second');
  assert.equal(s.authenticate(muse.token).workspace,ws);
  assert.equal(s.authenticate(first.token).id,first.id);
  assert.deepEqual(s.authenticate(second.token),{id:second.id,workspace:ws,actor:'Second'});
  assert.throws(()=>s.revokeAgentGrant('work',first.id),{status:404});
  assert.throws(()=>s.issueAgentGrant(ws,'Owner console'),{status:400});
  assert.equal(s.isGrantActive({workspace:ws,id:second.id,actor:'Owner console'}),false);
  assert(s.listAgentGrants(ws).every(x=>x.expiresAt&&!x.token&&!x.bearerHash));
  s.revokeAgentGrant(ws,first.id);
  assert.equal(s.authenticate(first.token),null);
  assert(s.authenticate(second.token));
  s.disableConnection(ws,c.id);
  assert.equal(s.authenticate(muse.token),null);
  assert.equal(s.authenticate(second.token).id,second.id);
  connect(s,ws,'ca_next','calendar');
  assert.equal(s.authenticate(second.token).id,second.id);
  assert.throws(()=>s.attachConnection(ws,c.id,'ca_stale'),{status:409});
});

test('catalog eligibility covers individual Gmail reads and writes and rejects open-ended execution',t=>{
  const s=setup(t);
  const c=connect(s,'personal','ca_other_gmail','gmail');
  const vaults={...tool,toolkit:'_1password',slug:'_1PASSWORD_LIST_VAULTS'};
  assert.equal(catalogToolRestriction(vaults),null);
  const vault=connect(s,'personal','ca_vault','_1password');
  assert(s.setToolPolicy('personal',vault.id,vaults,true).allowed);
  assert.equal(catalogToolRestriction({...tool,toolkit:'codeinterpreter',slug:'CODEINTERPRETER_GET_VERSION'}),null);
  assert.equal(catalogToolRestriction({...tool,toolkit:'0codekit',slug:'0CODEKIT_CONVERT_IMAGE'}),null);
  for(const slug of ['GMAIL_GET_MESSAGE','GMAIL_FETCH_EMAILS','GMAIL_LIST_MESSAGES','GMAIL_SEARCH_THREADS','GMAIL_FORWARD_EMAIL','GMAIL_SEND_EMAIL','GMAIL_MARK_AS_READ','GMAIL_CREATE_DRAFT']){
    const action={...tool,toolkit:'gmail',slug};assert.equal(catalogToolRestriction(action),null);s.setToolPolicy('personal',c.id,action,true);
  }
  for(const denied of [
    {...tool,toolkit:'gmail',slug:'GMAIL_PROXY'},{...tool,toolkit:'gmail',slug:'GMAIL_RAW_API_REQUEST'},
    {...tool,toolkit:'other',slug:'OTHER_EXECUTE_SHELL_COMMAND'},{...tool,slug:'NOTION_RAW_API_REQUEST'},
    {...tool,toolkit:'codeinterpreter',slug:'CODEINTERPRETER_REPL'},{...tool,version:'latest'},
    {...tool,slug:'NOTION_FETCH',inputSchema:{type:'object',properties:{url:{type:'string'},method:{type:'string'}}}}
  ])assert.equal(typeof catalogToolRestriction(denied),'string',denied.slug);
  const p=s.begin('personal','pilot@example.com');
  assert.throws(()=>s.attach('personal',p.attempt,'ca_other_gmail'),{status:409});
  s.attach('personal',p.attempt,'ca_pilot');s.activate('personal',p.attempt,'pilot@example.com');
  const dup=s.createConnection('work',{toolkit:'gmail'});
  assert.throws(()=>s.attachConnection('work',dup.id,'ca_pilot'),{status:409});
  assert.equal(s.getPolicy('personal'),'Block');
});

test('actual MCP entry points expose only permitted tools; return authorized results and store summaries',async t=>{
  const s=setup(t), c=connect(s,'work','ca_research'), other=connect(s,'personal','ca_other');
  const work=s.issueAgentGrant('work','Research agent'), personal=s.issueAgentGrant('personal','Personal agent');
  const enabled=s.setToolPolicy('work',c.id,tool,true);
  const foreign=s.setToolPolicy('personal',other.id,tool,true);
  const sent='private-input-value',received='private-document-title';
  let posts=0,preflight=()=>{},afterPost=()=>{},metadata=tool;
  const catalog={async execute(opts){
    assert.equal(opts.owner,c.owner);assert.equal(opts.accountId,'ca_research');assert.equal(opts.slug,tool.slug);assert.equal(opts.version,tool.version);
    await preflight();
    opts.beforeDispatch(metadata);
    posts++;
    assert.deepEqual(opts.args,{query:sent});
    await afterPost();
    return {data:{items:[received],extra:sent}};
  }};
  const run=createToolRunner({store:s,getProvider:()=>null,getCatalog:()=>catalog});
  const server=createServer(makeAgentHandler({store:s,run,publicURL:'https://example.com'}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const rpc=async (token,method,params)=> {
    const res=await fetch('http://127.0.0.1:'+server.address().port+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    return res.json();
  };
  assert.deepEqual((await rpc(work.token,'tools/list',{})).result.tools.map(v=>v.name),[enabled.mcpName,'airport_list_connections']);
  assert.deepEqual((await rpc(personal.token,'tools/list',{})).result.tools.map(v=>v.name),[foreign.mcpName,'airport_list_connections']);
  const call=(token,args,name=enabled.mcpName)=>rpc(token,'tools/call',{name,arguments:args});
  assert((await call(personal.token,{query:sent})).result.isError);
  assert((await call(work.token,{query:sent,another:sent})).result.isError);
  assert.equal(posts,0);
  const answer=(await call(work.token,{query:sent})).result;
  assert.equal(answer.isError,false);assert.deepEqual(answer.structuredContent,{data:{items:[received],extra:sent}});
  const log=s.state().logs.find(l=>l.tool===enabled.mcpName&&l.outcome==='Allowed');
  assert.equal(log.actor,'Research agent');assert.equal(log.workspace,'work');
  assert.deepEqual(log.exchange.request.params.arguments.fields,['query']);
  assert.deepEqual(log.exchange.response.result.fields,['items']);assert.equal(log.exchange.response.dispatched,true);
  assert(!JSON.stringify(s.state().logs).includes(sent));assert(!JSON.stringify(s.state().logs).includes(received));
  metadata={...tool,inputSchema:{type:'object',properties:{}}};
  assert((await call(work.token,{query:sent})).result.isError);assert.equal(posts,1);
  metadata=tool;
  preflight=()=>s.blockTool('work',c.id,tool.slug);
  assert((await call(work.token,{query:sent})).result.isError);assert.equal(posts,1);
  preflight=()=>{};
  s.setToolPolicy('work',c.id,tool,true);
  afterPost=()=>s.revokeAgentGrant('work',work.id);
  const changed=(await call(work.token,{query:sent})).result;
  assert.equal(changed.isError,true);assert(!JSON.stringify(changed).includes(received));assert.equal(posts,2);
});

test('agent inventory reports active connections in its workspace and audits the same metadata over MCP and HTTPS', async t => {
  const s = setup(t);
  const listed = connect(s,'personal','ca_private_notion');
  connect(s,'personal','ca_private_github','github');
  connect(s,'work','ca_work_calendar','calendar');
  s.createConnection('personal',{toolkit:'slack',label:'Still connecting'});
  const removed = connect(s,'personal','ca_disabled','dropbox');
  s.disableConnection('personal',removed.id);
  const pilot = s.begin('personal','private@example.test');
  s.attach('personal',pilot.attempt,'ca_private_gmail');
  s.activate('personal',pilot.attempt,'private@example.test');
  s.setToolPolicy('personal',listed.id,tool,true);
  const invite = s.issueAgentInvitation('personal','Grokbot');
  const named = s.registerAgent(invite.invitation);
  const legacy = s.issueConnectorGrant('personal');
  const run = createToolRunner({store:s,getProvider:()=>assert.fail('Listing connections must never call a provider')});
  const server = createServer(makeAgentHandler({store:s,run,publicURL:'https://example.test'}));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base = 'http://127.0.0.1:'+server.address().port;
  const get = token => fetch(base+'/api/connections',{headers:{authorization:'Bearer '+token}});
  const request = (token,args={}) => fetch(base+'/mcp',{method:'POST',headers:{
    authorization:'Bearer '+token,'content-type':'application/json'
  },body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'airport_list_connections',arguments:args}})});
  const expected = [
    {label:'Gmail inbox',toolkit:'gmail',allowedToolCount:0},
    {label:'Selected account',toolkit:'notion',allowedToolCount:1},
    {label:'Selected account',toolkit:'github',allowedToolCount:0}
  ];
  const data = (await (await request(named.token)).json()).result.structuredContent;
  assert.equal(data.workspace,'Personal');
  const order = (a,b)=>a.toolkit.localeCompare(b.toolkit);
  assert.deepEqual([...data.connections].sort(order),expected.sort(order));
  assert.deepEqual(await (await get(named.token)).json(),data);
  assert.equal((await (await request(named.token,{workspace:'work'})).json()).error.code,-32602);
  const audit = s.state().logs.filter(l=>l.tool==='airport_list_connections');
  assert.equal(audit.length,2);
  assert(audit.every(l=>l.workspace==='personal' && l.actor==='Grokbot' && l.providerCalled===false && l.outcome==='Allowed'));
  assert.deepEqual(audit.find(l=>l.exchange.channel==='http').exchange.response,data);
  assert.deepEqual(audit.find(l=>l.exchange.channel==='mcp').exchange.response.structuredContent,data);
  s.blockTool('personal',listed.id,tool.slug);
  assert.equal((await (await get(named.token)).json()).connections.find(c=>c.toolkit==='notion').allowedToolCount,0);
  assert.equal((await get(legacy.token)).status,403);
  assert.equal((await (await request(legacy.token)).json()).result.isError,true);
  s.revokeAgentGrant('personal',s.authenticate(named.token).id);
  assert.equal((await get(named.token)).status,401);
});

test('workspace accounts, approved tool versions, and named secret hashes survive a restart',t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-catalog-test-'));
  const path=join(dir,'gateway.sqlite3');
  let s=createStore(path);
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const ws=s.createWorkspace('Restored').id,conn=connect(s,ws,'ca_restored');
  const approved=s.setToolPolicy(ws,conn.id,tool,true),issued=s.issueAgentGrant(ws,'Desk');
  s.close();s=createStore(path);
  assert.equal(s.authenticate(issued.token).workspace,ws);
  assert.equal(s.resolveTool(ws,approved.mcpName).version,tool.version);
  assert.equal(s.resolveTool(ws,approved.mcpName).account,'ca_restored');
  assert(!JSON.stringify(s.state()).includes(issued.token));
  s.disableConnection(ws,conn.id);
  const borrower=s.createConnection('work',{toolkit:'notion'});
  assert.throws(()=>s.attachConnection('work',borrower.id,'ca_restored'),{status:409});
  assert.equal(s.authenticate(issued.token).workspace,ws);
  assert.deepEqual(s.approvedTools(ws),[]);
});

test('an explicit catalog Gmail send permission is scoped to named agents, that account, and that tool version', async t=>{
  const s=setup(t),ws='work',email='pilot@example.test';
  const pilot=s.begin(ws,email);
  s.attach(ws,pilot.attempt,'ca_pilot');s.activate(ws,pilot.attempt,email);s.setPolicy(ws,'Allow');
  const legacy=s.issueConnectorGrant(ws),agent=s.issueAgentGrant(ws,'Mail desk');
  const c=connect(s,ws,'ca_separate_gmail','gmail'),second=connect(s,ws,'ca_secondary_gmail','gmail');
  const send={...tool,toolkit:'gmail',slug:'GMAIL_SEND_EMAIL',name:'Send email',description:'Send one email.',
    inputSchema:{type:'object',properties:{to:{type:'string'},body:{type:'string'}},required:['to','body'],additionalProperties:false}};
  let dispatches=0;
  const catalog={async execute(opts){
    assert.equal(opts.owner,c.owner);assert.equal(opts.accountId,'ca_separate_gmail');assert.equal(opts.version,send.version);
    opts.beforeDispatch(send);dispatches++;return {data:{id:'synthetic-mail-id'}};
  }};
  const run=createToolRunner({store:s,getProvider:()=>({counts:()=>({total:4,unread:1})}),getCatalog:()=>catalog});
  const server=createServer(makeAgentHandler({store:s,run,publicURL:'https://example.test'}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const rpc=async (token,method,params={})=>{
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    return (await response.json()).result;
  };
  const list=async token=>(await rpc(token,'tools/list')).tools.map(v=>v.name);
  const args={to:'dummy@example.test',body:'synthetic private text'};
  const call=(token,name)=>rpc(token,'tools/call',{name,arguments:args});
  assert.deepEqual(await list(agent.token),['gmail_inbox_counts','airport_list_connections']);
  assert.deepEqual(await list(legacy.token),['gmail_inbox_counts']);
  assert((await call(agent.token,'gmail_send_email')).isError);
  const policy=s.setToolPolicy(ws,c.id,send,true);
  assert.deepEqual(await list(agent.token),['gmail_inbox_counts',policy.mcpName,'airport_list_connections']);
  assert.deepEqual(s.listToolPolicies(ws,second.id),[]);
  assert.deepEqual(await list(legacy.token),['gmail_inbox_counts']);
  assert((await call(legacy.token,policy.mcpName)).isError);
  assert((await call(legacy.token,'gmail_send_email')).isError);
  assert.equal(dispatches,0);
  assert.deepEqual((await call(agent.token,policy.mcpName)).structuredContent,{data:{id:'synthetic-mail-id'}});
  s.blockTool(ws,c.id,send.slug);
  assert((await call(agent.token,policy.mcpName)).isError);
  assert.equal(dispatches,1);
  assert.deepEqual((await rpc(legacy.token,'tools/call',{name:'gmail_inbox_counts'})).structuredContent,{total:4,unread:1});
  assert(!JSON.stringify(s.state().logs).includes(args.body));
});
