import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {readPlatformOverview} from './platform-admin.mjs';
import {createStore} from './store.mjs';
import {BETA_START,ALLOWANCE_DETAIL} from './beta-usage.mjs';

test('platform totals combine catalog, prior schema and pilot stores without migrating or recovering them',t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-overview-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'a'.repeat(64)+'.sqlite3'),oldFile=join(dir,'b'.repeat(64)+'.sqlite3');
  const s=createStore(file),at=Date.now();
  s.createWorkspace('private-workspace');
  const p=s.begin('personal','private@example.test');
  s.attach('personal',p.attempt,'private-provider');s.activate('personal',p.attempt,'private@example.test');
  s.issueConnectorGrant('personal');
  const c=s.createConnection('work',{toolkit:'github',label:'private-connection'});
  s.attachConnection('work',c.id,'private-repo-id');s.activateConnection('work',c.id,'private-repo-id');
  s.createConnection('work',{toolkit:'notion',label:'Pending'});
  s.issueAgentGrant('work','private-agent','forever','dots');
  s.issueAgentGrant('work','custom-bot','forever','custom');
  const payload={channel:'mcp',request:{connection:{toolkit:'github',label:'private-connection'},
    operation:{slug:'GITHUB_LIST_ISSUES'},params:{arguments:{value:'private-argument'}}},response:{data:'private-response'}};
  for(let i=0;i<2;i++)s.log('work','private-agent','c_fake','Allowed',true,'private details',payload,'dots');
  s.log('personal','Muse','gmail_inbox_counts','Allowed',true,'private details',{channel:'http',request:{},response:{}});
  s.log('work','Owner console','gmail_inbox_counts','Allowed',true,'owner test',{...payload,channel:'owner'});
  s.log('work','private-agent','airport_list_connections','Allowed',false,'discovery',payload);
  s.log('work','private-agent','c_fake','Blocked',true,'blocked',payload);
  s.log('work','private-agent','c_fake','Failed',true,'failed',payload);
  s.log('work','private-agent','c_fake','Allowed',true,'missing channel');
  const stale=s.log('work','private-agent','c_fake','Allowed',true,'outside window',payload);
  s.log('work','private-agent','c_fake','Running',true,'in progress',payload);
  s.close();
  const db=new DatabaseSync(file);
  db.prepare('UPDATE requests SET at=? WHERE id=?').run(at-31*86400000,stale);
  db.close();

  const old=new DatabaseSync(oldFile);
  old.exec(`CREATE TABLE workspaces(id, status, email, account, bearerHash, grantId, grantExpires);
    INSERT INTO workspaces VALUES('legacy','active','private@example.test','old',NULL,NULL,NULL);
    CREATE TABLE workspace_agents(actor,expires);
    INSERT INTO workspace_agents VALUES('DOT',8640000000000000),('expired',0);
    CREATE TABLE catalog_connections(toolkit,status);
    INSERT INTO catalog_connections VALUES('github','active');`);
  old.close();
  const r=readPlatformOverview(dir,3,Date.now());
  assert.deepEqual(r.totals,{users:3,workspaces:4,connections:4,agents:4,successfulToolCalls:3});
  assert.deepEqual(r.integrations.map(({key,count})=>[key,count]),[['github',2],['gmail',2]]);
  assert.deepEqual(r.bots.map(({key,count,activeAgents})=>[key,count,activeAgents]),[['dots',2,2],['muse',1,1],['other',0,1]]);
  assert.deepEqual(r.tools.map(({key,count})=>[key,count]),[['GITHUB_LIST_ISSUES',2],['gmail_inbox_counts',1]]);
  assert.doesNotMatch(JSON.stringify(r),/private|custom-bot|c_fake|@|expired|8640000000000000/);
  const after=new DatabaseSync(file,{readOnly:true});
  assert.equal(after.prepare("SELECT count(*) AS n FROM requests WHERE outcome='Running'").get().n,1);
  after.close();
  const oldAfter=new DatabaseSync(oldFile,{readOnly:true});
  assert.equal(oldAfter.prepare("SELECT count(*) AS n FROM pragma_table_info('workspace_agents')").get().n,2);
  oldAfter.close();
});

test('beta usage is pooled across workspaces and private gateway IDs never leave the admin report',t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-admin-usage-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const time=Date.parse(BETA_START)+86400000;
  for(const [key,actions] of [['a',800],['b',1000]]){
    const path=join(dir,key.repeat(64)+'.sqlite3');
    createStore(path).close();
    const db=new DatabaseSync(path);
    db.exec('BEGIN');
    const row=db.prepare('INSERT INTO requests(id,at,workspace,actor,tool,outcome,providerCalled,detail) VALUES(?,?,?,?,?,?,?,?)');
    const exchange=db.prepare("INSERT INTO request_exchanges(request_id,channel,request_json,response_json) VALUES(?,'mcp','{}',?)");
    for(let i=0;i<actions;i++){
      row.run(String(i),time,i%2?'personal':'work','Owner console','gmail_inbox_counts','Allowed',1,'private sample');
      exchange.run(String(i),'{}');
    }
    if(actions===1000){
      row.run('denied',time,'work','Private agent','gmail_inbox_counts','Blocked',0,ALLOWANCE_DETAIL);
      exchange.run('denied','{}');
      db.prepare("UPDATE request_exchanges SET decision_code='account_action_limit' WHERE request_id='denied'").run();
    }
    row.run('failed',time,'personal','Private agent','c_sample','Failed',1,'private error');
    exchange.run('failed','{"dispatched":true}');
    db.exec('COMMIT');db.close();
  }
  const r=readPlatformOverview(dir,2,time+1,true);
  assert.equal(r.beta.used,1800);assert.equal(r.beta.providerAttempts,1802);
  assert.equal(r.beta.limitDenials,1);assert.equal(r.beta.nearLimit,1);assert.equal(r.beta.atLimit,1);
  assert.equal(r.beta.agentFailures,2);assert.equal(r.beta.policyDenials,0);
  assert.deepEqual(r.beta.daily,[{day:'2026-11-23',used:1800,providerAttempts:1802},{day:'2026-11-22',used:0,providerAttempts:0}]);
  assert.equal(r.beta.activeAccounts,2);assert.equal(r.beta.over100,2);
  assert.deepEqual(r.beta.topAccounts.map(a=>a.used),[1000,800]);
  assert.equal(r.totals.successfulToolCalls,1800);
  assert.doesNotMatch(JSON.stringify(r.beta),/private|@|[a-f0-9]{64}/i);
});
