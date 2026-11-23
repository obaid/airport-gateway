import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createBetaEngagement} from './beta-engagement.mjs';

test('beta cohorts include idle signups, wait for full observation windows, and freeze at launch end',t=>{
  const root=mkdtempSync(join(tmpdir(),'airport-engagement-')),tenants=join(root,'tenants');
  mkdirSync(tenants);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const start=Date.UTC(2026,10,22,8),day=86400000,end=start+30*day;
  const registry=new DatabaseSync(join(root,'accounts.sqlite3'));
  registry.exec('CREATE TABLE users(tenant TEXT PRIMARY KEY,created_at INTEGER)');
  const signup=registry.prepare('INSERT INTO users VALUES(?,?)');
  for(const [id,joined] of Object.entries({returning:0,later:0,idle:0,new:29.5,outside:30,existing:-1}))signup.run(id,start+joined*day);
  registry.close();
  const tenant=new DatabaseSync(':memory:');
  t.after(()=>tenant.close());
  tenant.exec('CREATE TABLE requests(id INTEGER PRIMARY KEY,at INTEGER,outcome TEXT,providerCalled INTEGER); CREATE TABLE request_exchanges(request_id INTEGER,channel TEXT)');
  const add=(age,result='Allowed',provider=1,channel='mcp')=>{
    const {lastInsertRowid}=tenant.prepare('INSERT INTO requests(at,outcome,providerCalled) VALUES(?,?,?)').run(start+age*day,result,provider);
    tenant.prepare('INSERT INTO request_exchanges VALUES(?,?)').run(lastInsertRowid,channel);
  };
  const report=createBetaEngagement(tenants,new Date(start).toISOString(),new Date(end).toISOString(),end+50*day);
  add(0); add(7);
  report.observe('returning',tenant);
  tenant.exec('DELETE FROM requests; DELETE FROM request_exchanges');
  add(0,'Allowed',1,'owner'); add(.3,'Blocked',1); add(.8,'Allowed',0); add(1); add(14);
  report.observe('later',tenant);
  report.observe('new',tenant);
  report.observe('outside',tenant);
  report.observe('existing',tenant);
  assert.deepEqual(report.summary(),{signups:4,activationEligible:3,activatedWithin24h:1,weekTwoEligible:2,returnedWeekTwo:1});

  const fresh=createBetaEngagement(tenants,start,end,start+day/2);
  fresh.observe('returning',tenant);
  assert.deepEqual(fresh.summary(),{signups:3,activationEligible:0,activatedWithin24h:0,weekTwoEligible:0,returnedWeekTwo:0});
});
