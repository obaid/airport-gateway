import { isDeepStrictEqual } from 'node:util';
import { catalogToolRestriction } from './store.mjs';
import { ComposioError } from './composio.mjs';

const MODERN = '2026-07-28';
const HANDSHAKE = ['2025-11-25', '2025-06-18', '2025-03-26'];
const VERSIONS = [MODERN, ...HANDSHAKE];
const META = 'io.modelcontextprotocol/';
const SERVER = { name: 'airport', title: 'Airport', version: '1.0.0' };
const READ = 'gmail_inbox_counts';
const SEND = 'gmail_send_email';
const COUNT_PATH = '/api/gmail/inbox-counts';
const MAX_BYTES = 16 * 1024;

const COUNT_TOOL = {
  name: READ,
  title: 'Gmail inbox counts',
  description: 'Return the total and unread message counts for the connected Gmail inbox.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
};

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const shortString = value => typeof value === 'string' && value.length > 0 && value.length <= 512;

class InputError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function reply(res, status, value, type = 'application/json; charset=utf-8') {
  if (value === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}

function rpcError(res, id, status, code, message, data) {
  reply(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data && { data }) } });
}

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new InputError(415, 'Expected application/json.');
  }
  if (Number(req.headers['content-length']) > MAX_BYTES) throw new InputError(413, 'Request is too large.');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new InputError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InputError(400, 'Invalid JSON.');
  }
}

function instructions(origin) {
  return [
    'Connect an agent to Airport',
    '',
    'In Airport, select the workspace, open Agents and choose Add agent. Choose an access duration, then choose Create setup prompt. Give the one-use prompt to the agent that will receive access.',
    '',
    'For a workspace agent, use '+origin+'/mcp with Streamable HTTP. Store the token issued for that agent as a bearer credential. Use tools/list to discover the individual tools the workspace owner has enabled. Re-list when permissions change.',
    '',
    'If you received a one-use agent invitation, POST '+origin+'/agents/register with application/json and {"invitation":"<invitation>","name":"<your agent name>"}. Omit name if the owner chose it. Claim within ten minutes. A name already in use returns 409. Store the returned token as a bearer credential in private connector storage, then connect to '+origin+'/mcp. Keep invitation and token out of URLs and logs.',
    '',
    'For a saved Muse Custom Connector with bearer authentication:',
    'Configure GET ' + origin + COUNT_PATH + ' with no parameters and a secure bearer credential field. This operation returns total and unread INBOX counts.',
    'In Airport, select the workspace, open Agents and choose Add agent. Expand Connect with a bearer token instead, enter the agent name, choose an access duration and select Issue agent credential. Enter the token in the connector’s secure credential field. Send it in the Authorization: Bearer header.',
    'Airport checks the workspace policy on each request. A denied read returns 403. Keep credentials out of prompts, chat, URLs, and logs.',
    '',
    'For clients supporting an owner-approved pairing code:',
    'Use a custom integration with HTTPS requests and secure credential storage.',
    'Keep pairing receipts and bearer tokens in the integration’s private storage. Show only the short approval code in chat.',
    '',
    '1. POST ' + origin + '/pair/start with application/json and {"invite":"<one-use invite from the owner>"}.',
    '2. Keep pairId and receipt private. Show the returned code to the owner. They open Agents in the workspace that issued the pairing invitation, select the Muse saved connector and enter the code under Enter your pairing code. They select Approve Muse to authorize the request.',
    '3. POST ' + origin + '/pair/token with {"pairId":"<pairId>","receipt":"<receipt>"}. While pending, wait at least five seconds between attempts. On approval save the token as a secret.',
    '4. Send Authorization: Bearer <token> on every subsequent call. For MCP, use ' + origin + '/mcp (Streamable HTTP). Refresh tools/list after policy changes.',
    '5. For a custom HTTP integration, GET ' + origin + COUNT_PATH + ' returns total and unread message counts. It accepts no parameters.',
    '',
    'If the client only opens links, returns web previews, or cannot attach a secret HTTP header, it needs a custom HTTP action or MCP connector to finish setup.'
  ].join('\n');
}

function gatewayBase(config) {
  const value = typeof config === 'function' ? config() : config;
  if (!value) return '';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid public gateway URL');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

async function pair(path, req, res, store) {
  const input = await body(req);
  if (path === '/pair/start') {
    if (!only(input, ['invite']) || !shortString(input.invite)) {
      throw new InputError(400, 'A one-use invite is required.');
    }
    let pairing;
    try { pairing = await store.pairStart(input.invite); } catch { /* Expired and consumed invites look alike. */ }
    if (!pairing) throw new InputError(403, 'Invite is invalid, expired or already used.');
    const { pairId, receipt, code, expiresAt } = pairing;
    return reply(res, 200, { pairId, receipt, code, expiresAt });
  }
  if (!only(input, ['pairId', 'receipt']) || !shortString(input.pairId) || !shortString(input.receipt)) {
    throw new InputError(400, 'A pairing ID and receipt are required.');
  }
  let exchange;
  try { exchange = await store.pairToken(input.pairId, input.receipt); } catch { /* No backend details leave this listener. */ }
  if (exchange?.status === 'pending') {
    res.setHeader('retry-after', '5');
    return reply(res, 200, { status: 'pending' });
  }
  if (exchange?.status === 'approved' && shortString(exchange.token)) {
    return reply(res, 200, { status: 'approved', token: exchange.token });
  }
  throw new InputError(403, 'Pairing is unavailable. Request a new invite in Airport.');
}

const catalogName = name => typeof name==='string' && /^c_[a-f0-9]{22}_[a-z0-9_-]{1,38}$/.test(name);

function summary(value, declaredFields=[]) {
  const objectValue=object(value);
  const bytes=Buffer.byteLength(JSON.stringify(value)??'');
  const kind=Array.isArray(value)?'array':value===null?'null':typeof value;
  if (objectValue) {
    const fields=Object.keys(value).filter(k=>declaredFields.includes(k) && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k));
    return {type:kind,bytes,fieldCount:Object.keys(value).length,fields};
  }
  return Array.isArray(value)?{type:kind,bytes,length:value.length}:{type:kind,bytes};
}

function requiredInputFits(args,schema) {
  if (!object(args)) return false;
  if (Array.isArray(schema.required) && schema.required.some(k=>!Object.hasOwn(args,k))) return false;
  const properties=schema.properties||{};
  if (schema.additionalProperties===false && !schema.patternProperties &&
      Object.keys(args).some(k=>!Object.hasOwn(properties,k))) return false;
  for (const [key,value] of Object.entries(args)) {
    if (['__proto__','constructor','prototype'].includes(key)) return false;
    if (!Object.hasOwn(properties,key) || !object(properties[key])) continue;
    const prop=properties[key];
    const allowed=Array.isArray(prop.type)?prop.type:prop.type?[prop.type]:[];
    const type=Array.isArray(value)?'array':value===null?'null':typeof value;
    if (allowed.length && !allowed.includes(type) && !(allowed.includes('integer')&&Number.isSafeInteger(value))) return false;
    if (Array.isArray(prop.enum) && !prop.enum.some(v=>isDeepStrictEqual(v,value))) return false;
    if (type==='object' && !requiredInputFits(value,prop)) return false;
  }
  return true;
}

const outputFields=['id','items','data','results','count','total','nextCursor','next_cursor','has_more','success','status','message','name','url'];
class ChangedApproval extends Error {}

async function runCatalogTool(store,getCatalog,grant,tool,transport,args) {
  const ws=grant.workspace;
  const catalogAccess=store.canUseCatalog(grant);
  const policy=catalogAccess && store.resolveTool(ws,tool);
  const channel=transport?.channel||'owner';
  const input=summary(args,Object.keys(policy?.inputSchema?.properties||{}));
  const request={method:channel==='mcp'?'tools/call':'owner/test',params:{name:tool,arguments:input}};
  if (policy) {
    request.connection={id:policy.connection,label:policy.label,toolkit:policy.toolkit};
    request.operation={slug:policy.slug,version:policy.version};
  }
  const exchange={channel,request,response:null};
  function deny(detail) {
    const result={outcome:'Blocked',detail,providerCalled:false};
    store.log(ws,grant.actor,tool,'Blocked',false,detail,{...exchange,response:{outcome:'Blocked'}});
    return result;
  }
  if (!catalogAccess) return deny('This credential has no catalog access.');
  if (!policy || catalogToolRestriction(policy)) return deny('This operation is not approved for this workspace.');
  if (!requiredInputFits(args,policy.inputSchema)) return deny('Arguments do not match the approved tool schema.');
  const provider=getCatalog?.();
  if (!provider) return deny('Configure the catalog provider before calling this operation.');
  const current = () => {
    const latest=store.resolveTool(ws,tool);
    return store.canUseCatalog(grant) && latest?.revision===policy.revision && latest.account===policy.account;
  };
  const logId=store.log(ws,grant.actor,tool,'Running',true,'Verifying the approved provider tool and connected account.',exchange);
  let dispatched=false,result;
  try {
    // The adapter resolves this exact version and verifies account ownership.
    // It calls beforeDispatch after all awaits and immediately before tool execution.
    const response=await provider.execute({owner:policy.owner,accountId:policy.account,toolkit:policy.toolkit,
      slug:policy.slug,version:policy.version,args,beforeDispatch:metadata=>{
        if (!current() || metadata?.slug!==policy.slug || metadata?.version!==policy.version ||
          metadata?.toolkit!==policy.toolkit || catalogToolRestriction(metadata) ||
          !isDeepStrictEqual(metadata.inputSchema,policy.inputSchema)) throw new ChangedApproval();
        dispatched=true;
      }});
    if (!dispatched || !current()) throw new ChangedApproval();
    if (!response || !Object.hasOwn(response,'data') || response.data===undefined) throw Error('Missing tool result');
    result={outcome:'Allowed',providerCalled:true,detail:'The approved provider operation completed.',data:response.data};
  } catch(error) {
    result=error instanceof ChangedApproval ? {outcome:'Blocked',providerCalled:true,detail:'Access or tool metadata changed. Airport withheld the result.'} :
      {outcome:'Failed',providerCalled:true,detail:'The provider could not verify or complete the operation.'};
  }
  const auditResponse={outcome:result.outcome,dispatched};
  if (result.outcome==='Allowed') auditResponse.result=summary(result.data,outputFields);
  store.finish(logId,result.outcome,result.detail,auditResponse);
  return result;
}

function safeRunResult(tool, result) {
  if (tool === SEND || result?.outcome === 'Blocked') {
    return { status: 403, data: { error: 'Airport policy blocked this tool.' } };
  }
  if (catalogName(tool)) {
    return result?.outcome==='Allowed' && Object.hasOwn(result,'data')
      ? {status:200,data:{data:result.data}} : {status:502,data:{error:'The provider could not complete the approved operation.'}};
  }
  const counts = result?.counts;
  if (result?.outcome === 'Allowed' && Number.isSafeInteger(counts?.total) && counts.total >= 0
      && Number.isSafeInteger(counts?.unread) && counts.unread >= 0) {
    return { status: 200, data: { total: counts.total, unread: counts.unread } };
  }
  return { status: 502, data: { error: 'Inbox counts are unavailable. Check the connection in Airport.' } };
}

export function createToolRunner({store,getProvider,getCatalog=getProvider}) {
  return async function run(grant,tool,transport,args=transport?.arguments??{}) {
    if (catalogName(tool)) return runCatalogTool(store,getCatalog,grant,tool,transport,args);
    const {workspace:ws,actor} = grant;
    const row = store.get(ws);
    const context = transport || {
      channel:'owner',request:{method:'POST',path:'/api/test',params:{workspace:ws,tool}},
      render:result => result
    };
    const exchange = {channel:context.channel,request:context.request,response:null};
    function deny(detail) {
      const result = {outcome:'Blocked',providerCalled:false,detail};
      store.log(ws,actor,tool,'Blocked',false,detail,{...exchange,response:context.render(result)});
      return result;
    }
    const expired = () => !store.isGrantActive(grant);
    if (expired(row)) return deny('This workspace grant is no longer active.');
    if (tool !== READ && tool !== SEND) return deny('This tool is unavailable.');
    if (tool === SEND) return deny('Workspace policy blocks sending email. The request stopped at Airport.');
    if (row.policy !== 'Allow') return deny('Workspace policy blocks inbox counts. The request stopped at Airport.');
    const provider = getProvider();
    if (row.status !== 'active' || !row.account || !provider) return deny('A verified Gmail connection and configured Composio key are required.');
    const logId = store.log(ws,actor,tool,'Running',true,'Requested the INBOX label totals through Composio.',exchange);
    let result;
    try {
      const {total,unread} = await provider.counts(row.owner,row.account);
      const current = store.get(ws);
      if (current.account !== row.account || current.policy !== 'Allow' || expired(current)) {
        result = {outcome:'Blocked',providerCalled:true,detail:'Access changed during the provider read. Airport withheld the result.'};
      } else if (Number.isSafeInteger(total) && Number.isSafeInteger(unread) && unread >= 0 && unread <= total) {
        result = {outcome:'Allowed',providerCalled:true,detail:'Gmail returned the INBOX total and unread counts.',counts:{total,unread}};
      }
    } catch (error) {
      if (error instanceof ComposioError) result = {outcome:'Failed',providerCalled:true,detail:error.message};
    }
    if (!result) result = {outcome:'Failed',providerCalled:true,detail:'Inbox counts are unavailable. Check the Gmail connection and Composio credentials.'};
    store.finish(logId,result.outcome,result.detail,context.render(result));
    return result;
  };
}

function decodeName(value) {
  const encoded = /^=\?base64\?([A-Za-z0-9+/]+={0,2})\?=$/.exec(value || '');
  return encoded ? Buffer.from(encoded[1], 'base64').toString('utf8') : value;
}

function headerIssue(headers, method, params, version) {
  if (!version || headers['mcp-protocol-version'] !== version) return 'MCP-Protocol-Version';
  if (headers['mcp-method'] !== method) return 'Mcp-Method';
  if (method === 'tools/call' && (!params.name || decodeName(headers['mcp-name']) !== params.name)) return 'Mcp-Name';
}

async function mcp(req, res, store, run, grant) {
  let request;
  try { request = await body(req); }
  catch (error) {
    if (error instanceof InputError && error.status === 400) return rpcError(res, null, 400, -32700, 'Parse error');
    throw error;
  }
  if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return rpcError(res, null, 400, -32600, 'Invalid request');
  }
  const { id, method, params = {} } = request;
  if (id !== undefined && typeof id !== 'string' && !Number.isSafeInteger(id)) {
    return rpcError(res, null, 400, -32600, 'Invalid request ID');
  }
  if (!object(params)) return rpcError(res, id, 400, -32602, 'Expected named parameters');
  if (id === undefined) {
    if (!method.startsWith('notifications/')) return rpcError(res, null, 400, -32600, 'Missing request ID');
    return reply(res, 202);
  }
  const version = params._meta?.[META + 'protocolVersion'];
  const headerVersion = req.headers['mcp-protocol-version'];
  const modern = version !== undefined || headerVersion === MODERN || method === 'server/discover';
  if (modern) {
    const issue = headerIssue(req.headers, method, params, version);
    if (issue) return rpcError(res, id, 400, -32020, 'Missing or mismatched request header: ' + issue);
    if (version !== MODERN) {
      return rpcError(res, id, 400, -32022, 'Unsupported protocol version', { supported: VERSIONS, requested: version });
    }
    if (!object(params._meta?.[META + 'clientCapabilities'])) return rpcError(res, id, 400, -32602, 'Client capabilities required');
  } else if (headerVersion && !HANDSHAKE.includes(headerVersion)) {
    return rpcError(res, id, 400, -32022, 'Unsupported protocol version', { supported: VERSIONS, requested: headerVersion });
  }
  const wrap = result => modern ? { resultType:'complete',_meta:{[META+'serverInfo']:SERVER},...result } : result;
  const success = result => reply(res,200,{jsonrpc:'2.0',id,result:wrap(result)});
  const invalid = () => rpcError(res, id, 200, -32602, 'Invalid tool or parameters');
  if (method === 'initialize' && !modern) {
    if (typeof params.protocolVersion !== 'string' || !object(params.capabilities) || !object(params.clientInfo)) return invalid();
    return success({ protocolVersion: HANDSHAKE.includes(params.protocolVersion) ? params.protocolVersion : HANDSHAKE[0],
      capabilities: { tools: {} }, serverInfo: SERVER });
  }
  if (method === 'server/discover' && only(params, ['_meta'])) {
    return success({ supportedVersions: VERSIONS, capabilities: { tools: {} } });
  }
  if (method === 'ping' && only(params, ['_meta'])) return success({});
  if (method === 'tools/list' && only(params, ['_meta', 'cursor'])) {
    if (params.cursor !== undefined) return invalid();
    const pilot=store.get(grant.workspace);
    const allowed=pilot.status==='active' && pilot.account && pilot.email && (await store.getPolicy(grant.workspace))==='Allow';
    const approved=store.canUseCatalog(grant)?store.approvedTools(grant.workspace):[];
    const dynamic=approved.filter(t=>!catalogToolRestriction(t)).map(t=>({
      name:t.mcpName,title:t.label+' · '+t.name,description:t.description,inputSchema:t.inputSchema
    }));
    return success({ tools: [...(allowed?[COUNT_TOOL]:[]),...dynamic] });
  }
  if (method !== 'tools/call') return rpcError(res, id, modern ? 404 : 200, -32601, 'Method not found');
  if (!only(params, ['name', 'arguments', '_meta'])) return invalid();
  const generic=catalogName(params.name);
  if (!generic && ![READ,SEND].includes(params.name)) return invalid();
  const args = Object.hasOwn(params, 'arguments') ? params.arguments : {};
  if (generic ? !object(args) : !only(args, params.name===SEND?['to','subject','body']:[])) return invalid();
  const safeArgs = generic ? {} : Object.fromEntries(Object.keys(args).map(key=>[key,'[redacted]']));
  const render = result => {
    const { status, data } = safeRunResult(params.name,result);
    return wrap({
      content:[{type:'text',text:data.error || JSON.stringify(data)}],
      ...(status === 200 && headerVersion !== '2025-03-26' ? {structuredContent:data} : {}),
      isError:status !== 200
    });
  };
  const result = await run(grant,params.name,{
    channel:'mcp',request:{method:'tools/call',params:{name:params.name,arguments:safeArgs}},render
  },args);
  return reply(res,200,{jsonrpc:'2.0',id,result:render(result)});
}

export function makeAgentHandler({ store, run, publicURL }) {
  return async function agentHandler(req, res) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      const base = gatewayBase(publicURL);
      if (req.headers.origin !== undefined && (!base || req.headers.origin !== new URL(base).origin)) {
        throw new InputError(403, 'Origin is not allowed.');
      }
      const path = req.url;
      if (!['/airport/connect', '/pair/start', '/pair/token', '/agents/register', '/mcp', COUNT_PATH].includes(path)) {
        throw new InputError(404, 'Route not found.');
      }
      const method = [COUNT_PATH, '/airport/connect'].includes(path) ? 'GET' : 'POST';
      if (req.method !== method) {
        res.setHeader('allow', method);
        throw new InputError(405, 'Method is not supported.');
      }
      if (method === 'GET' && (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'])) {
        throw new InputError(400, 'This operation accepts no body.');
      }
      if (path === '/airport/connect') return reply(res, 200, instructions(base), 'text/plain; charset=utf-8');
      if (path.startsWith('/pair/')) return await pair(path, req, res, store);
      if (path === '/agents/register') {
        const input=await body(req);
        if (!only(input,['invitation','name']) || !shortString(input.invitation) ||
            (Object.hasOwn(input,'name') && (!shortString(input.name) || input.name.length>100)))
          throw new InputError(400,'Supply the one-use invitation and an optional agent name.');
        try {return reply(res,200,await store.registerAgent(input.invitation,input.name));}
        catch(error) {
          // Only validation, duplicate-name and invalid-invitation errors are public.
          if ([400,403,409].includes(error.status)) throw new InputError(error.status,error.message);
          throw error;
        }
      }
      const bearer = /^Bearer ([a-zA-Z0-9._~+/=-]{1,512})$/i.exec(req.headers.authorization || '');
      const grant = bearer && await store.authenticate(bearer[1]);
      if (!grant) {
        res.setHeader('www-authenticate', 'Bearer realm="Airport"');
        throw new InputError(401, 'A valid Airport bearer token is required.');
      }
      if (path === '/mcp') return await mcp(req, res, store, run, grant);
      const { status, data } = safeRunResult(READ, await run(grant, READ,{
        channel:'http',request:{method:'GET',path:COUNT_PATH,params:{}},render:result => safeRunResult(READ,result).data
      }));
      reply(res, status, data);
    } catch (error) {
      const status = error instanceof InputError ? error.status : 500;
      if (status === 413) res.setHeader('connection', 'close');
      if (!req.readableEnded) req.resume();
      if (!res.headersSent) reply(res, status, { error: status === 500 ? 'Airport could not complete the request.' : error.message });
    }
  };
}
