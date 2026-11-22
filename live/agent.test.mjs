import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { makeAgentHandler, createToolRunner } from './agent.mjs';
import { createStore } from './store.mjs';
import { ComposioError } from './composio.mjs';

const bearer = { authorization: 'Bearer mock-agent-token' };
const readTool = 'gmail_inbox_counts';
const sendTool = 'gmail_send_email';
const secret = 'upstream-credential-not-for-agents';
const publicURL = 'https://airport.example';

async function setup(t) {
  const state = { paired: false, approved: false, claimed: false, revoked: false, policy: 'Allow', runs: [], providerReads: 0 };
  const grant = { workspace: 'personal', id: 'g-1', actor: 'Muse' };
  const store = {
    pairStart(invite) {
      if (state.paired || invite !== 'invite-123') throw Error(secret);
      state.paired = true;
      return { pairId: 'pair-1', receipt: 'private-receipt', code: '340621', expiresAt: 12345, ownerKey: secret };
    },
    pairToken(pairId, receipt) {
      if (!state.paired || state.claimed || pairId !== 'pair-1' || receipt !== 'private-receipt') throw Error(secret);
      if (!state.approved) return { status: 'pending', token: secret };
      state.claimed = true;
      return { status: 'approved', token: 'mock-agent-token', ownerKey: secret };
    },
    authenticate(token) { return token === 'mock-agent-token' && !state.revoked ? grant : null; },
    canUseCatalog() { return false; },
    get(workspace) { assert.equal(workspace,grant.workspace);return {status:'active',account:'ca_fake',email:'mock@example.test'}; },
    getPolicy(workspace) { assert.equal(workspace, grant.workspace); return state.policy; }
  };
  async function run(principal, name) {
    assert.deepEqual(principal, grant);
    state.runs.push(name);
    if (state.policy === 'Block' || name === sendTool) return {outcome: 'Blocked', providerCalled: false, detail: secret};
    state.providerReads++;
    if (state.fail) throw Error(secret);
    return { outcome: 'Allowed', providerCalled: true, detail: secret, counts: { total: 13, unread: 7, messages: [secret] } };
  }
  const server = createServer(makeAgentHandler({ store, run, publicURL: () => publicURL }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const get = (path, headers) => fetch(base + path, { headers });
  const post = (path, value, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof value === 'string' ? value : JSON.stringify(value)
  });
  const rpc = (method, params = {}, headers = {}) => post('/mcp', { jsonrpc: '2.0', id: 1, method, params }, { ...bearer, ...headers });
  return { get, post, rpc, state };
}

test('pair invite binds to one receipt, requires owner approval and issues the agent token once', async t => {
  const { get, post, state } = await setup(t);
  const guide = await (await get('/airport/connect')).text();
  assert.ok(guide.includes(publicURL + '/pair/start'));
  assert.ok(guide.includes('/api/gmail/inbox-counts'));
  for (const label of ['Agents', 'Add agent', 'Create setup prompt', 'Issue agent credential', 'Approve Muse']) {
    assert.ok(guide.includes(label), 'The setup guide should name the '+label+' control');
  }
  assert.equal((await post('/pair/start', { invite: 'bad' })).status, 403);
  assert.equal((await post('/pair/start', { invite: 'invite-123', workspace: 'work' })).status, 400);
  const start = await post('/pair/start', { invite: 'invite-123' });
  assert.equal(start.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await start.json(), { pairId: 'pair-1', receipt: 'private-receipt', code: '340621', expiresAt: 12345 });
  assert.equal((await post('/pair/start', { invite: 'invite-123' })).status, 403);
  const exchange = { pairId: 'pair-1', receipt: 'private-receipt' };
  assert.equal((await post('/pair/token', { ...exchange, receipt: '340621' })).status, 403);
  const pending = await post('/pair/token', exchange);
  assert.deepEqual(await pending.json(), { status: 'pending' });
  assert.equal(pending.headers.get('retry-after'), '5');
  state.approved = true;
  assert.deepEqual(await (await post('/pair/token', exchange)).json(), { status: 'approved', token: 'mock-agent-token' });
  const replay = await post('/pair/token', exchange);
  assert.equal(replay.status, 403);
  assert.ok(!(await replay.text()).includes(secret));
});

test('only the public guide and pairing work without a valid bearer', async t => {
  const { get, post, state } = await setup(t);
  for (const headers of [{}, { authorization: 'Basic yes' }, { authorization: 'Bearer expired' }]) {
    const response = await get('/api/gmail/inbox-counts', headers);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="Airport"');
  }
  assert.equal((await post('/mcp', {})).status, 401);
  for (const path of ['/admin', '/api/state', '/api/owner', '/.env', '/.git/config', '/pair/approve']) {
    assert.equal((await get(path, bearer)).status, 404);
  }
  const allowed = await get('/api/gmail/inbox-counts', bearer);
  assert.deepEqual(await allowed.json(), { total: 13, unread: 7 });
  state.revoked = true;
  assert.equal((await get('/api/gmail/inbox-counts', bearer)).status, 401);
  assert.equal(state.runs.length, 1);
});

test('2025 handshake, notifications, ping, and policy-filtered tools', async t => {
  const { rpc, post, state } = await setup(t);
  const hello = await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: {name:'client',version:'1'}, capabilities: {} });
  const handshake = (await hello.json()).result;
  assert.equal(handshake.protocolVersion, '2025-06-18');
  assert.equal(handshake.serverInfo.name, 'airport');
  assert.deepEqual(handshake.capabilities, { tools: {} });
  const notification = await post('/mcp', {jsonrpc: '2.0', method: 'notifications/initialized'}, bearer);
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), '');
  assert.deepEqual((await (await rpc('ping')).json()).result, {});
  const list = async () => (await (await rpc('tools/list')).json()).result.tools;
  assert.deepEqual((await list()).map(x => x.name), [readTool]);
  assert.equal((await list())[0].annotations.readOnlyHint, true);
  const allowed = (await (await rpc('tools/call', {name: readTool, arguments: {}})).json()).result;
  assert.deepEqual(JSON.parse(allowed.content[0].text), { total: 13, unread: 7 });
  state.policy = 'Block';
  assert.deepEqual(await list(), []);
  const denied = (await (await rpc('tools/call', {name: readTool})).json()).result;
  assert.equal(denied.isError, true);
  assert.ok(denied.content[0].text.includes('blocked'));
  assert.equal(state.providerReads, 1);
});

test('modern stateless discovery and calls validate mirrored headers and metadata', async t => {
  const { rpc, state } = await setup(t);
  const modern = '2026-07-28';
  function call(method, params = {}, headers = {}) {
    return rpc(method, { _meta: { 'io.modelcontextprotocol/protocolVersion': modern, 'io.modelcontextprotocol/clientCapabilities': {} }, ...params },
      { 'MCP-Protocol-Version': modern, 'MCP-Method': method, ...(params.name && { 'MCP-Name': params.name }), ...headers });
  }
  const discovery = (await (await call('server/discover')).json()).result;
  assert.equal(discovery.resultType, 'complete');
  assert.ok(discovery.supportedVersions.includes(modern));
  assert.equal(discovery._meta['io.modelcontextprotocol/serverInfo'].name, 'airport');
  assert.equal((await (await call('tools/list')).json()).result.tools[0].name, readTool);
  const payload = {name: readTool, arguments: {}};
  const successful = (await (await call('tools/call', payload)).json()).result;
  assert.deepEqual(successful.structuredContent, { total: 13, unread: 7 });
  for (const headers of [{ 'MCP-Method': 'ping' }, { 'MCP-Name': sendTool }, { 'MCP-Protocol-Version': 'bogus' }]) {
    const mismatch = await call('tools/call', payload, headers);
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error.code, -32020);
  }
  const unsupported = await call('ping', { _meta: { 'io.modelcontextprotocol/protocolVersion': 'future' } }, { 'MCP-Protocol-Version': 'future' });
  assert.equal((await unsupported.json()).error.code, -32022);
  assert.equal(state.providerReads, 1);
});

test('blocked direct send is audited; arbitrary tools, parameters and notifications cannot call the provider', async t => {
  const { get, post, rpc, state } = await setup(t);
  const result = (await (await rpc('tools/call', {name: sendTool, arguments: {to: 'someone', body: 'test'}})).json()).result;
  assert.equal(result.isError, true);
  assert.deepEqual(state.runs, [sendTool]);
  for (const params of [{name: 'google_proxy'}, {name: readTool, arguments: {url:'https://example.org'}},
    {name: readTool, workspace: 'work'}, {name: readTool, arguments: null}, {name: sendTool, arguments: {url:'x'}}]) {
    assert.equal((await (await rpc('tools/call', params)).json()).error.code, -32602);
  }
  assert.equal((await post('/mcp', { jsonrpc: '2.0', method: 'tools/call', params: {name: readTool} }, bearer)).status, 400);
  assert.equal((await get('/api/gmail/inbox-counts?workspace=work', bearer)).status, 404);
  state.policy = 'Block';
  assert.equal((await get('/api/gmail/inbox-counts', bearer)).status, 403);
  assert.deepEqual(state.runs, [sendTool, readTool]);
  assert.equal(state.providerReads, 0);
});

test('malformed and oversized inputs, foreign browser origins and upstream errors are contained', async t => {
  const { get, post, state } = await setup(t);
  assert.equal((await get('/mcp')).status, 405);
  const foreign = await get('/api/gmail/inbox-counts', { ...bearer, origin: 'https://unrelated.example' });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  assert.equal((await post('/mcp', '[' , bearer)).status, 400);
  assert.equal((await post('/pair/token', 'x'.repeat(18 * 1024))).status, 413);
  assert.equal((await post('/pair/start', '{}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal(state.providerReads, 0);
  state.fail = true;
  const backendError = await get('/api/gmail/inbox-counts', bearer);
  assert.equal(backendError.status, 500);
  assert.ok(!(await backendError.text()).includes(secret));
});

test('authenticated calls persist the delivered client payload, omit secrets and isolate pre-dispatch denials', async t => {
  const store = createStore(':memory:');
  const {attempt} = store.begin('work','tester@example.com');
  store.attach('work',attempt,'ca_demo');
  store.activate('work',attempt,'tester@example.com');
  const {token} = store.issueConnectorGrant('work');
  store.setPolicy('work','Allow');
  let providerCalls = 0;
  let shouldFail = false;
  const run = createToolRunner({store,getProvider:() => ({
    counts:async () => {
      providerCalls++;
      if (shouldFail) throw Error(secret);
      return {total:18,unread:4,irrelevant:secret};
    }
  })});
  const server = createServer(makeAgentHandler({store,run,publicURL}));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => {
    server.close(() => {store.close(); resolve();});
    server.closeAllConnections();
  }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = () => fetch(base+'/api/gmail/inbox-counts',{headers:{authorization:'Bearer '+token}});
  const rpc = (name,args) => fetch(base+'/mcp',{
    method:'POST',headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:'private-rpc-id',method:'tools/call',params:{name,arguments:args}})
  });
  const latest = () => store.state().logs[0];
  const http = await get();
  assert.deepEqual(latest().exchange,{
    channel:'http',request:{method:'GET',path:'/api/gmail/inbox-counts',params:{}},response:await http.json()
  });
  const mcp = (await (await rpc(readTool,{})).json()).result;
  assert.deepEqual(mcp.structuredContent,{total:18,unread:4});
  assert.deepEqual(latest().exchange.response,mcp);
  const denied = (await (await rpc(sendTool,{to:'private-recipient@example.com',subject:secret,body:'private-body'})).json()).result;
  assert.deepEqual(latest().exchange,{
    channel:'mcp',request:{method:'tools/call',params:{name:sendTool,arguments:{to:'[redacted]',subject:'[redacted]',body:'[redacted]'}}},
    response:denied
  });
  assert.equal(latest().outcome,'Blocked');
  assert.equal(latest().providerCalled,false);
  assert.equal(providerCalls,2);
  shouldFail = true;
  const failed = await get();
  assert.equal(failed.status,502);
  assert.deepEqual(latest().exchange.response,await failed.json());
  assert.equal(latest().outcome,'Failed');
  const owner = {workspace:'work',actor:'Owner console'};
  const ownerFailure = await run(owner,readTool);
  assert.deepEqual(latest().exchange,{
    channel:'owner',request:{method:'POST',path:'/api/test',params:{workspace:'work',tool:readTool}},response:ownerFailure
  });
  shouldFail = false;
  const ownerRead = await run(owner,readTool);
  assert.deepEqual(ownerRead.counts,{total:18,unread:4});
  assert.deepEqual(latest().exchange.response,ownerRead);
  const unavailable = 'Gmail denied the read. Reconnect with Gmail metadata access.';
  const deniedByGmail = createToolRunner({store,getProvider:() => ({
    counts:async () => {throw new ComposioError(unavailable);}
  })});
  assert.equal((await deniedByGmail(owner,readTool)).detail,unavailable);
  assert.equal(latest().exchange.response.detail,unavailable);
  const revokeDuringRead = createToolRunner({store,getProvider:() => ({
    counts:async () => {store.setPolicy('work','Block');return {total:31,unread:7};}
  })});
  const withheld = await revokeDuringRead(owner,readTool);
  assert.equal(withheld.outcome,'Blocked');
  assert.equal(withheld.counts,undefined);
  assert.deepEqual(latest().exchange.response,withheld);
  store.setPolicy('work','Block');
  const refused = await get();
  assert.equal(refused.status,403);
  assert.deepEqual(latest().exchange.response,await refused.json());
  const value = JSON.stringify(store.state().logs);
  for (const withheld of [secret,token,'private-recipient@example.com','private-body','private-rpc-id']) assert(!value.includes(withheld));
});
