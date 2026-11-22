import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from './store.mjs';
import { exportSnapshot, importSnapshot } from './migrate.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'airport-migration-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const tenant = 'a'.repeat(64), base = 'https://mcp.example.com/v1';
  const tenants = join(dir, 'tenants');
  mkdirSync(tenants);
  const target = join(tenants, tenant + '.sqlite3');
  createStore(target).close();
  const source = join(dir, 'local.db'), output = join(dir, 'snapshot.db');
  const store = createStore(source);
  t.after(() => store.close());
  return {source, store, output, tenants, target, gateway: base + '/gateway/' + tenant,
    env: {AIRPORT_AGENT_BASE:base,AIRPORT_HOSTED_DATA_DIR:dir}};
}

test('a consistent WAL export preserves workspace bindings, active credentials, policy and history', t => {
  const f = fixture(t);
  const email = 'personal@example.com', op = f.store.begin('personal', email);
  f.store.attach('personal', op.attempt, 'example_account');
  f.store.activate('personal', op.attempt, email);
  f.store.setPolicy('personal', 'Allow');
  const invitation = f.store.issueAgentInvitation('work', 'Assistant', 'forever', 'duet');
  const named = f.store.registerAgent(invitation.invitation);
  const muse = f.store.issueConnectorGrant('personal');
  const before = f.store.state();
  exportSnapshot(f.source, f.output);
  assert.equal(statSync(f.output).mode & 0o777, 0o600);
  f.store.setPolicy('personal', 'Block');
  assert.throws(() => exportSnapshot(f.source, f.output), {code:'EEXIST'});
  importSnapshot(f.output, f.gateway + '/mcp', f.env);
  const hosted = createStore(f.target);
  try {
    assert.equal(hosted.get('personal').email, email);
    assert.equal(hosted.get('personal').account, 'example_account');
    assert.equal(hosted.getPolicy('personal'), 'Allow');
    assert.equal(hosted.getPolicy('work'), 'Block');
    assert.deepEqual(hosted.authenticate(named.token), f.store.authenticate(named.token));
    assert.equal(hosted.authenticate(muse.token).actor, 'Muse');
    assert.deepEqual(hosted.state().logs, before.logs);
    assert.deepEqual(hosted.state().agentGrants, before.agentGrants);
  } finally {hosted.close();}
  assert.throws(() => importSnapshot(f.output, f.gateway, f.env), /already contains workspace data/);
});

test('import requires a known tenant and matching owner gateway, and refuses a configured workspace', t => {
  const f = fixture(t);
  exportSnapshot(f.source, f.output);
  for (const invalid of [f.gateway.replace('mcp.example.com', 'unrelated.example.com'),
    f.gateway.replace('/v1/', '/v2/'), f.gateway + '?invite=example', f.gateway + '/pair/token',
    f.gateway.replace('a'.repeat(64), 'b'.repeat(64))]) {
    assert.throws(() => importSnapshot(f.output, invalid, f.env));
  }
  const dest = createStore(f.target);
  dest.setPolicy('work', 'Allow');
  dest.close();
  assert.throws(() => importSnapshot(f.output, f.gateway + '/airport/connect', f.env), /already contains workspace data/);
  const check = createStore(f.target);
  try {assert.equal(check.getPolicy('work'), 'Allow');} finally {check.close();}
  assert.equal(readdirSync(f.tenants).length, 1);
});

test('a concurrent write prevents import and a future host schema retains its records', t => {
  const f = fixture(t);
  f.store.createWorkspace('Consulting');
  exportSnapshot(f.source, f.output);
  const writer = new DatabaseSync(f.target);
  writer.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => importSnapshot(f.output, f.gateway, f.env), e => e.errcode === 5);
    assert.equal(writer.prepare('SELECT count(*) AS n FROM workspaces').get().n, 2);
    writer.exec('ROLLBACK');
    // A populated table unknown to this release must never be silently discarded.
    writer.exec("CREATE TABLE future_settings (value TEXT); INSERT INTO future_settings VALUES ('set')");
    assert.throws(() => importSnapshot(f.output, f.gateway, f.env), /schemas are incompatible/);
    assert.equal(writer.prepare('SELECT count(*) AS n FROM workspaces').get().n, 2);
    assert.equal(writer.prepare('SELECT value FROM future_settings').get().value, 'set');
  } finally {writer.close();}
});

test('partial writes roll back if a later table violates a target constraint', t => {
  const f = fixture(t);
  const extra = f.store.createWorkspace('Consulting');
  f.store.issueAgentGrant(extra.id, 'Assistant');
  f.store.issueAgentGrant('work', 'Reader');
  exportSnapshot(f.source, f.output);
  const target = new DatabaseSync(f.target);
  try {
    // Emulate a future destination constraint on an otherwise compatible table.
    target.exec('CREATE UNIQUE INDEX one_grant ON workspace_agents((1))');
    assert.throws(() => importSnapshot(f.output, f.gateway, f.env), /UNIQUE constraint failed/);
    assert.deepEqual(target.prepare('SELECT id FROM workspaces ORDER BY id').all().map(row => row.id), ['personal', 'work']);
    assert.equal(target.prepare('SELECT count(*) AS n FROM workspace_agents').get().n, 0);
  } finally {target.close();}
});
