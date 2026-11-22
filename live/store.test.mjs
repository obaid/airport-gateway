import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.mjs';
import { DatabaseSync } from 'node:sqlite';

function memory(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  return store;
}

function connect(store, ws, email = ws + '@example.com') {
  const op = store.begin(ws, email);
  store.attach(ws, op.attempt, 'ca_' + ws);
  assert.equal(store.activate(ws, op.attempt, email), true);
  return op;
}

function enroll(store, ws) {
  const pair = store.pairStart(store.issue(ws).invite);
  store.approve(pair.pairId, pair.code);
  return store.pairToken(pair.pairId, pair.receipt).token;
}

test('a retry supersedes the held sign-in attempt, and a mismatched mailbox gets no grant', t => {
  const store = memory(t);
  const stale = store.begin('work', 'first@example.com');
  store.attach('work', stale.attempt, 'ca_first');
  const current = store.begin('work', 'work@example.com');
  assert.notEqual(current.owner, stale.owner);
  assert.notEqual(current.attempt, stale.attempt);
  assert.throws(() => store.attach('work', stale.attempt, 'ca_first'), { status: 409 });
  assert.throws(() => store.activate('work', stale.attempt, 'first@example.com'), { status: 409 });
  store.cancel('work', stale.attempt);
  assert.equal(store.get('work').status, 'pending');
  store.attach('work', current.attempt, 'ca_current');
  assert.equal(store.activate('work', current.attempt, 'different@example.com'), false);
  assert.equal(store.get('work').status, 'mismatch');
  assert.equal(store.get('work').owner, null);
  assert.equal(store.get('work').account, null);
  assert.throws(() => store.issue('work'), { status: 409 });
  const next = store.begin('work', 'work@example.com');
  store.attach('work', next.attempt, 'ca_verified');
  assert.equal(store.activate('work', next.attempt, 'Work@Example.com'), true);
  assert.equal(store.get('work').owner, next.owner);
  assert.equal(store.get('work').account, 'ca_verified');
});

test('workspace policies, addresses, bearer grants and revocation remain independent', t => {
  const store = memory(t);
  const personal = store.begin('personal', 'owner@example.com');
  assert.throws(() => store.begin('work', 'OWNER@EXAMPLE.COM'), { status: 409 });
  store.attach('personal', personal.attempt, 'ca_personal');
  store.activate('personal', personal.attempt, 'owner@example.com');
  assert.throws(() => store.begin('work', 'Owner@example.com'), { status: 409 });
  connect(store, 'work');
  assert.equal(store.getPolicy('personal'), 'Block');
  assert.equal(store.getPolicy('work'), 'Block');
  store.setPolicy('work', 'Allow');
  assert.equal(store.getPolicy('personal'), 'Block');
  assert.throws(() => store.setPolicy('work', 'Anything'), { status: 400 });
  const personalToken = enroll(store, 'personal');
  const workToken = enroll(store, 'work');
  assert.equal(store.authenticate(personalToken).workspace, 'personal');
  assert.equal(store.authenticate(workToken).workspace, 'work');
  store.revoke('work');
  assert.equal(store.authenticate(workToken), null);
  assert.equal(store.authenticate(personalToken).workspace, 'personal');
  assert.throws(() => store.begin('personal', 'new@example.com'), { status: 409 });
  store.disconnect('work');
  assert.equal(store.getPolicy('work'), 'Block');
  assert.equal(store.get('work').account, null);
});

test('pairing approval and collection are single use, while safe pending polls can repeat', t => {
  const store = memory(t);
  connect(store, 'work');
  const issued = store.issue('work');
  const invitation = (workspace='work') => store.state().workspaces.find(w => w.id===workspace).invitation;
  const status = stage => ({stage,expiresAt:issued.expiresAt});
  assert.deepEqual(invitation(),status('new'));
  assert.equal(invitation('personal'),null);
  assert.throws(() => store.issue('work'),{status:409});
  const pair = store.pairStart(issued.invite);
  assert.deepEqual(invitation(),status('waiting'));
  assert.throws(() => store.issue('work',status('new')),{status:409});
  assert.throws(() => store.pairStart(issued.invite), { status: 403 });
  assert.throws(() => store.pairToken(pair.pairId, 'different receipt'), { status: 403 });
  const bad = pair.code === '100000' ? '100001' : '100000';
  assert.throws(() => store.approve(pair.pairId, bad), { status: 403 });
  for (let i = 0; i < 2; i++) assert.deepEqual(store.pairToken(pair.pairId, pair.receipt), { status: 'pending' });
  store.approve(pair.pairId, pair.code);
  assert.deepEqual(invitation(),status('approved'));
  assert.throws(() => store.issue('work',status('waiting')),{status:409});
  assert.throws(() => store.approve(pair.pairId, pair.code), { status: 409 });
  const response = store.pairToken(pair.pairId, pair.receipt);
  assert.equal(invitation(),null);
  assert.throws(() => store.issue('work',status('approved')),{status:409});
  assert.equal(response.status, 'approved');
  assert.equal(store.authenticate(response.token).workspace, 'work');
  assert.throws(() => store.pairToken(pair.pairId, pair.receipt), { status: 403 });
  const replacement = enroll(store, 'work');
  assert.equal(store.authenticate(response.token), null);
  assert.equal(store.authenticate(replacement).workspace, 'work');
});

test('revocation, time limits and failed approval attempts invalidate outstanding credentials', t => {
  const store = memory(t);
  let time = Date.now();
  t.mock.method(Date, 'now', () => time);
  connect(store, 'work');
  const staleInvite = store.issue('work');
  const meta=()=>store.state().workspaces.find(w => w.id==='work').invitation;
  time = Date.parse(staleInvite.expiresAt);
  assert.equal(meta(),null);
  assert.throws(() => store.pairStart(staleInvite.invite), { status: 403 });
  const pair = store.pairStart(store.issue('work').invite);
  for (let i = 0; i < 5; i++) assert.throws(() => store.approve(pair.pairId, '000000'), { status: 403 });
  assert.equal(meta(),null);
  assert.throws(() => store.approve(pair.pairId, pair.code), { status: 409 });
  assert.throws(() => store.pairToken(pair.pairId, pair.receipt), { status: 403 });
  const approved = store.pairStart(store.issue('work').invite);
  store.approve(approved.pairId, approved.code);
  store.revoke('work');
  assert.throws(() => store.pairToken(approved.pairId, approved.receipt), { status: 403 });
  const token = enroll(store, 'work');
  time = store.get('work').grantExpires;
  assert.equal(store.authenticate(token), null);
  assert.equal(store.state().workspaces.find(w => w.id === 'work').grant, false);
});

test('manual connector credentials are workspace-scoped, expire after 12h and appear only in the issuance response', t => {
  const store = memory(t);
  let time = Date.now();
  t.mock.method(Date, 'now', () => time);
  assert.throws(() => store.issueConnectorGrant('work'), {status:409});
  const attempt = store.begin('work','work@example.com');
  store.attach('work',attempt.attempt,'ca_work');
  assert.throws(() => store.issueConnectorGrant('work'), {status:409});
  assert.deepEqual(store.state().logs, []);
  store.activate('work',attempt.attempt,'work@example.com');
  connect(store,'personal');
  const personal = enroll(store,'personal');
  const personalInvitation = store.issue('personal');
  const previous = enroll(store,'work');
  const stalePair = store.pairStart(store.issue('work').invite);
  store.approve(stalePair.pairId,stalePair.code);
  const {token,expiresAt} = store.issueConnectorGrant('work');
  assert.equal(Date.parse(expiresAt),time + 12 * 3600_000);
  assert.equal(store.authenticate(token).workspace,'work');
  assert.equal(store.authenticate(previous),null);
  assert.throws(() => store.pairToken(stalePair.pairId,stalePair.receipt), {status:403});
  assert.equal(store.authenticate(personal).workspace,'personal');
  assert(store.pairStart(personalInvitation.invite).receipt);
  assert.equal(store.getPolicy('work'),'Block');
  const state = store.state();
  assert.equal(state.logs.filter(l => l.tool === 'issue_connector_grant').length,1);
  const entry = state.logs.find(l => l.tool === 'issue_connector_grant');
  assert.deepEqual(entry.exchange,{
    channel:'owner',request:{method:'POST',path:'/api/connector-grant',params:{workspace:'work'}},
    response:{expiresAt,token:'[redacted]'}
  });
  const paired = state.logs.find(l => l.tool === 'pair_connector_grant');
  assert.deepEqual(paired.exchange.response,{status:'approved',token:'[redacted]'});
  assert.equal(paired.exchange.request.params.receipt,'[redacted]');
  assert.equal(entry.workspace,'work');
  assert.equal(entry.actor,'Owner console');
  assert.equal(entry.tool,'issue_connector_grant');
  assert.equal(entry.outcome,'Issued');
  assert.equal(entry.providerCalled,false);
  assert(!JSON.stringify(state).includes(token));
  assert(!JSON.stringify(store.get('work')).includes(token));
  time = Date.parse(expiresAt);
  assert.equal(store.authenticate(token),null);
});

test('manual reissue invalidates unclaimed invitations and rotated credentials, and pairing can replace a manual grant', t => {
  const store = memory(t);
  connect(store,'work');
  const first = store.issueConnectorGrant('work');
  const pendingInvite = store.issue('work');
  const second = store.issueConnectorGrant('work');
  assert.notEqual(first.token, second.token);
  assert.equal(store.authenticate(first.token),null);
  assert.throws(() => store.pairStart(pendingInvite.invite), {status:403});
  const paired = enroll(store,'work');
  assert.equal(store.authenticate(second.token),null);
  assert.equal(store.authenticate(paired).workspace,'work');
  const latest = store.issueConnectorGrant('work');
  store.revoke('work');
  assert.equal(store.authenticate(latest.token),null);
  assert.equal(store.state().logs.filter(l => l.tool==='issue_connector_grant').length,3);
});

test('SQLite restart preserves counts policy and grants, finalizes interrupted audit rows and omits secrets from public state', t => {
  const dir = mkdtempSync(join(tmpdir(), 'airport-test-'));
  const file = join(dir, 'test.sqlite3');
  let store = createStore(file);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  connect(store, 'work');
  assert.equal(store.getPolicy('work'), 'Block');
  const token = enroll(store, 'work');
  store.setPolicy('work', 'Allow');
  const blocked = store.log('work', 'Muse', 'gmail_send_email', 'Blocked', false, 'Blocked at gateway.');
  const allowed = store.log('work', 'Muse', 'gmail_inbox_counts', 'Running', true, 'Requested totals.');
  store.finish(allowed, 'Allowed', 'Read totals.');
  const running = store.log('work', 'Muse', 'gmail_inbox_counts', 'Running', true, 'Requested totals.');
  const pending = store.pairStart(store.issue('work').invite);
  store.close();
  store = createStore(file);
  assert.equal(store.getPolicy('personal'), 'Block');
  assert.equal(store.getPolicy('work'), 'Allow');
  assert.equal(store.authenticate(token).workspace, 'work');
  const state = store.state();
  const entries = Object.fromEntries(state.logs.map(row => [row.id, row]));
  assert.equal(entries[blocked].outcome, 'Blocked');
  assert.equal(entries[blocked].providerCalled, false);
  assert.equal(entries[allowed].outcome, 'Allowed');
  assert.equal(entries[allowed].providerCalled, true);
  assert.equal(entries[running].outcome, 'Interrupted');
  assert.equal(state.invites[0].workspace, 'work');
  assert.deepEqual(state.workspaces.find(w => w.id==='work').invitation,{stage:'waiting',expiresAt:pending.expiresAt});
  const replacement=store.issue('work',{stage:'waiting',expiresAt:pending.expiresAt});
  assert.throws(()=>store.approve(pending.pairId,pending.code),{status:409});
  assert.deepEqual(store.state().workspaces.find(w => w.id==='work').invitation,{stage:'new',expiresAt:replacement.expiresAt});
  const exposed = JSON.stringify(state);
  for (const privateValue of [token, pending.receipt, store.get('work').owner, store.get('work').bearerHash, 'ca_work']) {
    assert.equal(exposed.includes(privateValue), false);
  }
  store.disconnect('work');
  assert.equal(store.getPolicy('work'), 'Block');
  assert.equal(store.authenticate(token), null);
  assert.equal(store.state().logs.length, 4);
});

test('eight-column legacy writers continue after exchange migration; partial and interrupted records remain accurate', t => {
  const dir = mkdtempSync(join(tmpdir(),'airport-audit-test-'));
  const file = join(dir,'legacy.sqlite3');
  const old = new DatabaseSync(file);
  let store;
  t.after(() => { store?.close(); old.close(); rmSync(dir,{recursive:true,force:true}); });
  old.exec(`CREATE TABLE requests(id TEXT PRIMARY KEY,at INTEGER NOT NULL,workspace TEXT NOT NULL,
    actor TEXT NOT NULL,tool TEXT NOT NULL,outcome TEXT NOT NULL,providerCalled INTEGER NOT NULL DEFAULT 0,detail TEXT NOT NULL)`);
  const legacy = old.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?)');
  function oldWrite(id) { legacy.run(id,Date.now(),'work','Muse','gmail_inbox_counts','Allowed',1,'Legacy summary.'); }
  oldWrite('before');
  store = createStore(file);
  oldWrite('after');
  assert.equal(store.state().activityDetailsVersion,1);
  assert(store.state().logs.every(row => row.exchange === null));
  const request = {method:'GET',path:'/api/gmail/inbox-counts',params:{}};
  const running = store.log('work','Muse','gmail_inbox_counts','Running',true,'Reading.',{channel:'http',request,response:null});
  assert.throws(() => store.log('work','Muse','gmail_inbox_counts','Running',true,'Reading.',{channel:'invalid',request,response:null}));
  assert.equal(store.state().logs.length,3);
  assert.throws(() => store.finish(running,'Allowed','Read.',{impossible:1n}));
  assert.equal(store.state().logs.find(l => l.id===running).outcome,'Running');
  assert.equal(store.state().logs.find(l => l.id===running).exchange.response,null);
  store.close();
  store = createStore(file);
  const row = store.state().logs.find(l => l.id===running);
  assert.equal(row.outcome,'Interrupted');
  assert.deepEqual(row.exchange,{channel:'http',request,response:null});
  oldWrite('after-reopen');
  assert.equal(store.state().logs.find(l => l.id==='after-reopen').exchange,null);
});

test('weekly request totals include history beyond the receipt list and exclude setup events', t => {
  const store=memory(t);
  const time=Date.now();t.mock.method(Date,'now',()=>time-8*24*3600_000);
  store.log('personal','Agent','read','Allowed',true,'Old request');
  Date.now.mock.mockImplementation(()=>time);
  for(let i=0;i<102;i++)store.log('personal','Agent','read','Allowed',true,'Read');
  store.log('personal','Owner console','issue_agent_grant','Issued',false,'Setup');
  store.log('work','Other agent','read','Blocked',false,'Policy blocked');
  const snapshot=store.state();
  assert.equal(snapshot.logs.length,100);
  const totals=new Map(snapshot.weeklyUsage.map(row=>[row.workspace,row]));
  assert.equal(totals.get('personal').requests,102);
  assert.equal(totals.get('personal').allowed,102);
  assert.equal(totals.get('work').blocked,1);
});
