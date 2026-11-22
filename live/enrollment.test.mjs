import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {createStore} from './store.mjs';
import {makeAgentHandler,createToolRunner} from './agent.mjs';
import agentIcons from '../dist/agent-icons.js';

function setup(t) {
  const store=createStore(':memory:');
  t.after(()=>store.close());
  const connections={};
  for(const workspace of ['work','personal']){
    const c=store.createConnection(workspace,{toolkit:'notion'});
    store.attachConnection(workspace,c.id,'ca_'+workspace);
    store.activateConnection(workspace,c.id,'ca_'+workspace);
    connections[workspace]=c;
  }
  return {store,connections};
}

test('multiple pending invitations bind names and workspaces without storing secret values in owner state',t=>{
  const {store:s}=setup(t);
  const pinned=s.issueAgentInvitation('work','Research desk'), free=s.issueAgentInvitation('work'),other=s.issueAgentInvitation('personal');
  assert.equal(s.state().agentInvitations.length,3);
  assert.throws(()=>s.registerAgent(pinned.invitation,'Wrong desk'),{status:400});
  const a=s.registerAgent(pinned.invitation), b=s.registerAgent(other.invitation,'Research desk');
  assert.equal(a.name,'Research desk');assert.equal(s.authenticate(a.token).workspace,'work');
  assert.equal(s.authenticate(b.token).workspace,'personal');
  const id=s.authenticate(a.token).id;
  assert.throws(()=>s.registerAgent(free.invitation),{status:400});
  for(const name of ['Owner','Owner console','Ｍｕｓｅ','Muse'])
    assert.throws(()=>s.registerAgent(free.invitation,name),{status:400});
  assert.throws(()=>s.registerAgent(free.invitation,'RESEARCH DESK'),{status:409});
  assert.throws(()=>s.issueAgentGrant('work','Research desk'),{status:409});
  assert.equal(s.authenticate(a.token).id,id);
  const c=s.registerAgent(free.invitation,'Lab');
  assert.throws(()=>s.registerAgent(free.invitation,'Someone else'),{status:403});
  s.revokeAgentGrant('work',id);assert.equal(s.authenticate(a.token),null);
  assert.equal(s.authenticate(c.token).workspace,'work');
  const state=JSON.stringify(s.state());
  for(const value of [pinned.invitation,free.invitation,other.invitation,a.token,b.token,c.token]) assert(!state.includes(value));
});

test('an owner-selected app follows an invitation, its credential and its recorded requests',async t=>{
  const {store:s}=setup(t);
  const invite=s.issueAgentInvitation('work','Research desk','7d','duet');
  assert.equal(invite.clientType,'duet');
  assert.equal(s.state().agentInvitations.find(i=>i.id===invite.id).clientType,'duet');
  const {token}=s.registerAgent(invite.invitation);
  const grant=s.authenticate(token);
  assert.equal(grant.clientType,'duet');
  assert.equal(s.listAgentGrants('work')[0].clientType,'duet');
  const run=createToolRunner({store:s,getProvider:()=>assert.fail('A blocked request cannot call a provider')});
  await run(grant,'gmail_send_email');
  s.revokeAgentGrant('work',grant.id);
  s.issueAgentGrant('work','Research desk','12h','custom');
  const requests=s.state().logs.filter(row=>row.actor==='Research desk');
  assert.deepEqual(requests.map(row=>[row.tool,row.clientType]),[['gmail_send_email','duet'],['register_agent','duet']]);
  assert.equal(s.listAgentGrants('work')[0].clientType,'custom');
  for (const value of ['../other.png',{},false,'']) {
    assert.throws(()=>s.issueAgentInvitation('personal',null,'7d',value),{status:400});
    assert.throws(()=>s.issueAgentGrant('personal','Extra','7d',value),{status:400});
  }
});

test('agent marks support existing aliases, owner-selected apps and custom initials',()=>{
  for (const [name,key] of [['Dot','dots'],['Ｄｏｔｓ','dots'],['GrokBot','grok-bot'],['Claude Duet','duet'],['Muse from Meta','muse']])
    assert.equal(agentIcons.imageURL(name),'/assets/agents/'+key+'.png');
  assert.equal(agentIcons.identify('Muse lab'),null);
  assert.equal(agentIcons.imageURL('Research desk',{clientType:'duet'}),'/assets/agents/duet.png');
  assert.equal(agentIcons.imageURL('Duet',{clientType:'custom'}),null);
  assert.equal(agentIcons.imageURL('Duet',{clientType:'../../bad'}),null);
  assert.match(agentIcons.render('  Éclair',{clientType:'custom'}),/>É<\/span>/);
  assert.match(agentIcons.render('Atlas'),/data-tone="5"[^>]*>A</);
  assert.doesNotMatch(agentIcons.render('<img src=x onerror=boom>'),/onerror|<img/);
});

test('expiry and per-workspace cancellation revoke invitations; last-source disconnect preserves identity',t=>{
  const {store:s,connections}=setup(t);
  const first=s.issueAgentInvitation('work'),second=s.issueAgentInvitation('work'),last=s.issueAgentInvitation('personal');
  assert.throws(()=>s.revokeAgentInvitation('personal',first.id),{status:404});
  s.revokeAgentInvitation('work',first.id);
  assert.throws(()=>s.registerAgent(first.invitation,'Desk'),{status:403});
  s.disableConnection('personal',connections.personal.id);
  assert.equal(s.registerAgent(last.invitation,'Desk').name,'Desk');
  const actual=Date.now();t.mock.method(Date,'now',()=>actual+10*60_000+100);
  assert.throws(()=>s.registerAgent(second.invitation,'Desk'),{status:403});
  assert.deepEqual(s.state().agentInvitations,[]);
});

test('public registration is an exact JSON POST with no workspace override or double-claim',async t=>{
  const {store:s}=setup(t);
  const server=createServer(makeAgentHandler({store:s,publicURL:'https://example.test/private',run:()=>assert.fail('No tools run on enrollment')}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const empty=s.createWorkspace('Unconnected').id;s.setPolicy(empty,'Allow');
  const fresh=s.issueAgentGrant(empty,'Desk');
  const resultList=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+fresh.token},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
  assert.deepEqual((await resultList.json()).result.tools.map(t=>t.name),['airport_list_connections']);
  const url=base+'/agents/register', invite=s.issueAgentInvitation('work','Desk','forever');
  const send=(value,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(value)});
  assert.equal((await fetch(url)).status,405);
  assert.equal((await fetch(url+'?invitation=unusable')).status,404);
  assert.match(await (await fetch(base+'/airport/connect')).text(),/https:\/\/example\.test\/private\/agents\/register/);
  assert.equal((await send({invitation:invite.invitation,workspace:'personal'})).status,400);
  assert.equal((await send({invitation:invite.invitation,lifetime:'30d'})).status,400);
  assert.equal((await send({invitation:invite.invitation,clientType:'duet'})).status,400);
  assert.equal((await send({invitation:invite.invitation},{Origin:'https://elsewhere.test'})).status,403);
  const result=await Promise.all([0,1].map(()=>send({invitation:invite.invitation})));
  assert.deepEqual(result.map(r=>r.status).sort(),[200,403]);
  const response=result.find(r=>r.status===200),grant=await response.json();
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(Object.keys(grant).sort(),['expiresAt','name','token']);
  assert.equal(grant.expiresAt,null);
  assert.equal(s.authenticate(grant.token).workspace,'work');
});


test('new workspaces enroll immediately; the owner alone selects the grant duration at issue time',t=>{
  const {store:s}=setup(t),ws=s.createWorkspace('Empty').id;
  let timestamp=Date.now();t.mock.method(Date,'now',()=>timestamp);
  const invite=s.issueAgentInvitation(ws,null,'30d'),day=24*3600_000;
  assert.equal(s.state().agentInvitations.find(v=>v.id===invite.id).lifetime,'30d');
  assert.equal(Date.parse(invite.expiresAt)-timestamp,600_000);
  assert.throws(()=>s.issueAgentInvitation(ws,'A','1y'),{status:400});
  assert.throws(()=>s.issueAgentGrant(ws,'A',''),{status:400});
  timestamp+=10_000;
  const a=s.registerAgent(invite.invitation,'Desk'),b=s.issueAgentGrant(ws,'Reader','7d'),c=s.issueAgentGrant(ws,'Default');
  assert.equal(Date.parse(a.expiresAt)-timestamp,30*day);
  assert.equal(Date.parse(b.expiresAt)-timestamp,7*day);
  assert.equal(Date.parse(c.expiresAt)-timestamp,day/2);
  assert(s.isGrantActive(s.authenticate(a.token)));
  assert.deepEqual(s.approvedTools(ws),[]);
  assert.throws(()=>s.issue(ws),{status:409});
  timestamp+=7*day;assert(s.authenticate(a.token));assert.equal(s.authenticate(b.token),null);
});


test('forever credentials survive restart and clock advance, preserve old gateway reads, and revoke independently',t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-named-grants-')),file=join(dir,'test.sqlite3');
  let s=createStore(file);
  const previous=new DatabaseSync(file);
  t.after(()=>{previous.close();s.close();rmSync(dir,{recursive:true,force:true});});
  let time=Date.now();t.mock.method(Date,'now',()=>time);
  // Statements issued by the previous binary, prepared before the new writer issues any credentials.
  const legacyList=previous.prepare('SELECT actor,expires FROM workspace_agents WHERE workspace=? AND expires>? ORDER BY actor');
  const legacyPrune=previous.prepare('DELETE FROM workspace_agents WHERE workspace=? AND expires<=?');
  const legacyRevoke=previous.prepare('DELETE FROM workspace_agents WHERE workspace=? AND id=?');
  assert.deepEqual(s.state().agentAccessLifetimes,['12h','7d','30d','forever']);
  const finite=s.issueAgentGrant('work','One shift','12h'),direct=s.issueAgentGrant('work','Archive','forever');
  const invitation=s.issueAgentInvitation('work','Reporter','forever'),unused=s.issueAgentInvitation('work',null,'forever');
  assert.equal(direct.expiresAt,null);assert.equal(Date.parse(invitation.expiresAt)-time,600_000);
  assert.equal(s.state().agentInvitations.find(i=>i.id===invitation.id).lifetime,'forever');
  for(const value of [null,'never','FOREVER',0,false]) {
    assert.throws(()=>s.issueAgentGrant('work','Invalid',value),{status:400});
    assert.throws(()=>s.issueAgentInvitation('work',null,value),{status:400});
  }
  s.close();s=createStore(file,{recoverOnOpen:false});
  const claimed=s.registerAgent(invitation.invitation);
  assert.equal(claimed.expiresAt,null);assert.throws(()=>s.registerAgent(invitation.invitation),{status:403});
  time+=250*365*24*3600_000;
  assert.throws(()=>s.registerAgent(unused.invitation,'Unused'),{status:403});
  assert.equal(s.authenticate(finite.token),null);
  assert.equal(legacyPrune.run('work',time).changes,1);
  const oldRows=legacyList.all('work',time);
  assert.deepEqual(oldRows.map(r=>r.actor),['Archive','Reporter']);
  assert(oldRows.every(row=>Date.parse(new Date(row.expires).toISOString())>time));
  s.close();s=createStore(file,{recoverOnOpen:false});
  assert(s.isGrantActive(s.authenticate(direct.token)));assert(s.canUseCatalog(s.authenticate(claimed.token)));
  assert(s.listAgentGrants('work').every(g=>g.expiresAt===null));
  assert.throws(()=>s.issueAgentGrant('work','Reporter','12h'),{status:409});
  s.revokeAgentGrant('work',direct.id);assert.equal(s.authenticate(direct.token),null);
  const reporter=s.authenticate(claimed.token);assert(reporter);
  assert.equal(legacyRevoke.run('work',reporter.id).changes,1);
  assert.equal(s.authenticate(claimed.token),null);assert.deepEqual(s.listAgentGrants('work'),[]);
});
