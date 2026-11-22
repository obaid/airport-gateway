import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAccounts } from './accounts.mjs';

test('customer invitations expire by the clock, rotate atomically and persist only hashed tokens',t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-account-store-')),file=join(dir,'accounts.sqlite3');
  const owner={tenant:'a'.repeat(64),email:'owner@example.com'};
  const visitor={tenant:'b'.repeat(64),email:'visitor@example.com'};
  let clock=100000;
  const db=createAccounts(file,{bootstrapTenant:owner.tenant,bootstrapEmail:owner.email,now:()=>clock});
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  assert.equal(db.resolve(owner,false).role,'admin');
  const a=db.invite(owner,visitor.email), b=db.invite(owner,visitor.email);
  assert.notEqual(a.token,b.token);
  assert.equal(db.listInvitations(owner).find(i=>i.id===a.invitation.id).status,'revoked');
  assert.throws(()=>db.signup(visitor,'Visitor',a.token),{code:'invitation_invalid'});
  clock=Date.parse(b.invitation.expiresAt);
  assert.equal(db.listInvitations(owner).find(i=>i.id===b.invitation.id).status,'expired');
  assert.throws(()=>db.signup(visitor,'Visitor',b.token),{code:'invitation_invalid'});
  const raw=new DatabaseSync(file,{readOnly:true});
  try {
    const saved=raw.prepare('SELECT * FROM customer_invitations').all();
    assert(!JSON.stringify(saved).includes(a.token));
    assert(!JSON.stringify(saved).includes(b.token));
    assert(saved.every(r=>/^[a-f0-9]{64}$/.test(r.token_hash)));
  } finally {raw.close();}
});
