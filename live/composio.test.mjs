import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposio } from './composio.mjs';

const owner = 'airport:work';
const id = 'ca_work';
const account = {
  id, user_id: owner, status: 'ACTIVE', is_disabled: false,
  toolkit: { slug: 'gmail' }, auth_config: { id: 'ac_gmail', is_disabled: false }
};
const base = 'https://backend.composio.dev/api/v3.1';
const mockKey = 'unit-test-project-key';

function replies(t, fixtures) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).origin, 'https://backend.composio.dev');
    assert.equal(options.headers['x-api-key'], mockKey);
    assert.equal(options.redirect, 'error');
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    assert.ok(calls.length <= fixtures.length, 'unexpected provider request');
    const fixture = fixtures[calls.length - 1];
    if (fixture instanceof Error) throw fixture;
    return Response.json(fixture.json, { status: fixture.http || 200 });
  });
  return calls;
}

test('start pins Gmail and gives the server the pending account before consent', async t => {
  const callback = 'http://127.0.0.1:4378/callback?state=example';
  const url = 'https://connect.composio.dev/link/ln_example';
  const calls = replies(t, [
    { json: { session_id: 'trs_example' } },
    { http: 201, json: { connected_account_id: id, redirect_url: url, link_token: 'private' } },
    { json: { session_id: 'trs_other' } },
    { http: 201, json: { connected_account_id: 'ca_other', redirect_url: url } }
  ]);
  assert.deepEqual(await createComposio(mockKey).start(owner, callback), { connectionId: id, url });
  assert.equal(calls[0].url, base + '/tool_router/session');
  assert.deepEqual(calls[0].body, { user_id: owner, toolkits: { enable: ['gmail'] }, multi_account: { enable: true } });
  assert.equal(calls[1].url, base + '/tool_router/session/trs_example/link');
  assert.deepEqual(calls[1].body, { toolkit: 'gmail', callback_url: callback });
  await createComposio(mockKey, 'ac_gmail').start(owner, callback);
  assert.deepEqual(calls[2].body.auth_configs, { gmail: 'ac_gmail' });
});

test('pinned owner, account and toolkit are checked on every provider read', async t => {
  const calls = replies(t, [
    { json: { items: [account] } },
    { json: { status: 200, data: { emailAddress: 'tester@example.com', historyId: 'hidden' } } },
    { json: { items: [account] } },
    { json: { status: 200, data: { messagesTotal: 31, messagesUnread: 7, name: 'INBOX' } } }
  ]);
  const adapter = createComposio(mockKey, 'ac_gmail');
  assert.deepEqual(await adapter.verify(owner, id), { active: true, status: 'ACTIVE', email: 'tester@example.com' });
  assert.deepEqual(await adapter.counts(owner, id), { total: 31, unread: 7 });
  for (const i of [0, 2]) {
    const url = new URL(calls[i].url);
    assert.equal(calls[i].method, 'GET');
    assert.equal(url.searchParams.get('connected_account_ids'), id);
    assert.equal(url.searchParams.get('user_ids'), owner);
    assert.equal(url.searchParams.get('toolkit_slugs'), 'gmail');
  }
  for (const [index, resource, fields] of [[1, 'profile', 'emailAddress'], [3, 'labels/INBOX', 'messagesTotal,messagesUnread']]) {
    assert.equal(calls[index].url, base + '/tools/execute/proxy');
    assert.deepEqual(calls[index].body, {
      method: 'GET', endpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/' + resource,
      user_id: owner, connected_account_id: id, parameters: [{ type: 'query', name: 'fields', value: fields }]
    });
  }
});

test('inactive and mismatched account records cannot trigger a Google request', async t => {
  const invalid = [
    { ...account, user_id: 'airport:personal' }, { ...account, id: 'ca_other' },
    { ...account, toolkit: { slug: 'drive' } }, { ...account, auth_config: { id: 'ac_other' } },
    { ...account, experimental: { account_type: 'SHARED' } }
  ];
  const rows = [...invalid, { ...account, status: 'INITIATED' }, { ...account, is_disabled: true }, { ...account, status: 'REVOKED' }];
  const calls = replies(t, rows.map(item => ({ json: { items: [item] } })));
  const adapter = createComposio(mockKey, 'ac_gmail');
  for (const _ of invalid) await assert.rejects(adapter.verify(owner, id), /could not be verified/);
  assert.deepEqual(await adapter.verify(owner, id), { active: false, status: 'INITIATED' });
  assert.deepEqual(await adapter.verify(owner, id), { active: false, status: 'DISABLED' });
  await assert.rejects(adapter.counts(owner, id), /inactive/);
  assert(calls.every(c => c.method === 'GET'));
});

test('invalid responses and network exceptions do not surface upstream content', async t => {
  const adapter = createComposio(mockKey);
  const list = { json: { items: [account] } };
  const calls = replies(t, [
    { json: { session_id: 'trs_example' } }, { json: { connected_account_id: id, redirect_url: 'https://example.org/private' } },
    list, { json: { status: 403, data: { message: 'private content' } } },
    list, { json: { status: 200, data: { messagesTotal: -1, messagesUnread: 3 } } },
    { http: 400, json: { message: 'private content' } }, new Error('private content')
  ]);
  await assert.rejects(adapter.start(owner, 'http://127.0.0.1/callback'), /^Error: Composio returned an invalid sign-in link\.$/);
  await assert.rejects(adapter.verify(owner, id), /^Error: Gmail denied the read\./);
  await assert.rejects(adapter.counts(owner, id), /^Error: Gmail returned invalid inbox counts\.$/);
  await assert.rejects(adapter.counts(owner, id), /^Error: Composio could not complete the request \(HTTP 400\)\.$/);
  await assert.rejects(adapter.counts(owner, id), /^Error: Composio could not be reached\. Try again\.$/);
  await assert.rejects(adapter.verify(owner, '../anywhere'), /Invalid Gmail connection/);
  await assert.rejects(adapter.start(owner, 'http://example.com'), /Invalid OAuth callback/);
  assert.equal(calls.length, 8);
});
