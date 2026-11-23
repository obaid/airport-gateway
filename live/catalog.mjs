import { ComposioError } from './composio.mjs';

const base = 'https://backend.composio.dev/api/v3.1';
const accountStates = new Set(['INITIALIZING','INITIATED','ACTIVE','INACTIVE','FAILED','REVOKED','EXPIRED','DISABLED']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
const fail = message => { throw new ComposioError(message); };

function identifier(value, pattern, message) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(message);
  return value;
}
const slug = value => identifier(value,/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,255}$/,'Invalid Composio slug.');
const version = value => identifier(value,/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/,'Invalid Composio tool version.');
const account = value => identifier(value,/^ca_[\w-]{1,200}$/,'Invalid connected account ID.');

export function internalToolkit(name) {
  return /^(?:composio(?:$|[_-])|(?:bench|test_app)$)/i.test(name);
}

function ownerId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\r\n,]/.test(value)) fail('Invalid workspace owner.');
  return value;
}

function query(entries) {
  const params = new URLSearchParams();
  for (const [key,value] of Object.entries(entries)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || value.length > 4096) fail('Invalid Composio query parameter.');
    params.set(key,value);
  }
  return '?' + params.toString();
}

function page(value, normalize) {
  if (!Array.isArray(value?.items) || (value.next_cursor != null && typeof value.next_cursor !== 'string')) {
    fail('Composio returned an invalid catalog page.');
  }
  return {items:value.items.map(normalize),nextCursor:value.next_cursor || null,
    ...(Number.isSafeInteger(value.total_items)?{total:value.total_items}:{})};
}

function toolkitInfo(row) {
  const key = slug(row?.slug).toLowerCase();
  const authSchemes = strings(row.auth_schemes);
  return {
    slug:key,name:row.name || key,description:row.meta?.description || '',logo:row.meta?.logo || null,
    toolsCount:row.meta?.tools_count ?? null,authSchemes,managedAuthSchemes:strings(row.composio_managed_auth_schemes),
    requiresAuth:row.no_auth !== true && !(authSchemes.length === 1 && authSchemes[0] === 'NO_AUTH')
  };
}

const fieldTypes = new Set(['array','boolean','integer','null','number','object','string']);
function namedSchema(input) {
  if (input.type === 'object') return input;
  // The REST API also publishes a map of field descriptors whose "required"
  // flag belongs to the parent object. Keep unfamiliar schemas unchanged so
  // the owner surface can display the tool and decline its unsupported shape.
  const properties = [], required = [];
  for (const [name,field] of Object.entries(input)) {
    if (!name || name.startsWith('$') || !object(field) || !fieldTypes.has(field.type)) return input;
    const descriptor = {...field};
    if (typeof descriptor.required === 'boolean') {
      if (descriptor.required) required.push(name);
      delete descriptor.required;
    } else if (descriptor.required !== undefined && !(field.type==='object' && Array.isArray(descriptor.required))) {
      return input;
    }
    properties.push([name,descriptor]);
  }
  const schema = {type:'object',properties:Object.fromEntries(properties),additionalProperties:false};
  if (required.length) schema.required = required;
  return schema;
}

function toolInfo(row) {
  const key = slug(row?.slug);
  if (!object(row.input_parameters) || typeof row.version !== 'string') fail('Composio returned an invalid tool definition.');
  return {
    slug:key,name:row.name || key,description:row.description || '',toolkit:slug(row.toolkit?.slug).toLowerCase(),
    inputSchema:namedSchema(row.input_parameters),version:version(row.version),noAuth:row.no_auth === true,
    tags:strings(row.tags),scopes:strings(row.scopes),deprecated:row.is_deprecated===true
  };
}

function callback(value) {
  let url;
  try { url = new URL(value); } catch { fail('Invalid connector callback URL.'); }
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    fail('Invalid connector callback URL.');
  }
  return url.href;
}

export function parseProjectAuthConfigs(raw) {
  if (raw == null || raw === '') return Object.create(null);
  let values;
  try { values = JSON.parse(raw); } catch { fail('Invalid AIRPORT_AUTH_CONFIGS_JSON.'); }
  if (!object(values)) fail('AIRPORT_AUTH_CONFIGS_JSON must map toolkit slugs to auth config IDs.');
  const result = Object.create(null);
  for (const [name,id] of Object.entries(values)) {
    const key = slug(name).toLowerCase();
    if (Object.hasOwn(result,key)) fail('A toolkit appears twice in AIRPORT_AUTH_CONFIGS_JSON.');
    result[key] = identifier(id,/^ac_[\w-]{1,200}$/,'Invalid auth config ID in AIRPORT_AUTH_CONFIGS_JSON.');
  }
  return result;
}

export function createCatalog(apiKey, {authConfigs={},pilotGmailConfig=authConfigs.gmail,discoverProjectConfigs=false} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) fail('Set the server-side Composio project key first.');
  async function request(path,body) {
    let response;
    try {
      response = await fetch(base+path,{
        method:body ? 'POST':'GET',headers:{'x-api-key':apiKey,'Content-Type':'application/json'},
        body:body ? JSON.stringify(body):undefined, redirect:'error',signal:AbortSignal.timeout(30000)
      });
    } catch {
      fail('Composio could not be reached. Check the connection and the execution history before retrying.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if ([401,403].includes(response.status)) fail('Composio denied this request. Check the project key, its permissions and the account scopes.');
      if (response.status === 429) fail('Composio is rate-limiting requests. Try again later.');
      fail('Composio could not complete the request (HTTP '+response.status+').');
    }
    try { return await response.json(); } catch { fail('Composio returned an unreadable response.'); }
  }

  const configuredToolkits=new Set(Object.keys(authConfigs));
  async function toolkitPage({search,cursor},audience) {
    const nativeOnly=audience==='public' || (audience==='workspace' && !configuredToolkits.size);
    const filters=audience ? {type:nativeOnly?'native':'all',include_deprecated:'false',limit:search?'50':'500'} : {type:'all',limit:'50'};
    const data=await request('/toolkits'+query({search,cursor,...filters}));
    if(audience && Array.isArray(data?.items))data.items=data.items.filter(row=>{
      if(!row || row.is_deprecated===true || row.deprecated===true)return false;
      const native=row.is_local_toolkit!==true && (row.type==='native' || (nativeOnly && row.type==null));
      return native || (audience==='workspace' && configuredToolkits.has(String(row.slug).toLowerCase()));
    });
    return page(data,toolkitInfo);
  }

  async function listToolkits({search,cursor,publicOnly=false,connectableOnly=false} = {}) {
    const audience=publicOnly?'public':connectableOnly?'workspace':undefined;
    const result=await toolkitPage({search,cursor},audience);
    if(!audience)return result;
    const items=result.items.filter(kit=>{
      if(internalToolkit(kit.slug) || kit.toolsCount===0 || (publicOnly && !(kit.toolsCount>0)))return false;
      const pinned=configuredToolkits.has(kit.slug);
      return kit.requiresAuth ? pinned || kit.managedAuthSchemes.length>0 : !pinned;
    });
    // The upstream total includes integrations whose sign-in Airport has not configured.
    return {items,nextCursor:result.nextCursor};
  }

  async function toolkitBySlug(toolkit,audience) {
    const target = slug(toolkit).toLowerCase();
    // The list endpoint exposes no_auth for each toolkit. The detail endpoint
    // omits it, so a missing field there cannot establish credentialless access.
    let cursor;
    const seen = new Set();
    do {
      const result = await toolkitPage({search:target,cursor},audience);
      const match = result.items.find(item => item.slug === target);
      if (match) return match;
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) fail('Composio returned a repeated catalog cursor.');
      seen.add(cursor);
    } while (cursor);
    fail('This toolkit is unavailable in this Composio project.');
  }

  async function listTools({toolkit,search,cursor,bulk=false} = {}) {
    const expected = toolkit ? slug(toolkit).toLowerCase() : null;
    const result = page(await request('/tools'+query({toolkit_slug:expected,query:search,cursor,limit:bulk?'500':'50'})),toolInfo);
    if (expected && result.items.some(item => item.toolkit !== expected)) fail('Composio returned tools from another toolkit.');
    return result;
  }

  async function getTool(name,requestedVersion) {
    const expected = slug(name);
    const result = toolInfo(await request('/tools/'+expected+(requestedVersion ? query({version:version(requestedVersion)}) : '')));
    if (result.slug !== expected || (requestedVersion && requestedVersion !== 'latest' && result.version !== requestedVersion)) {
      fail('Composio returned a different tool or version.');
    }
    return result;
  }

  async function start({owner,toolkit,callbackURL,authConfigId:callerConfig}) {
    if (callerConfig) fail('Airport manages this app’s sign-in configuration.');
    ownerId(owner);
    if(internalToolkit(toolkit))fail('This integration is unavailable.');
    const kit = await toolkitBySlug(toolkit,'workspace');
    if(kit.toolsCount===0)fail('This integration has no available tools.');
    let authConfigId = Object.hasOwn(authConfigs,kit.slug) ? authConfigs[kit.slug] : undefined;
    if (!kit.requiresAuth) {
      if (authConfigId) fail('This toolkit uses no authentication. Remove the auth config ID.');
      return {accountId:null,url:null};
    }
    const callbackURLString = callback(callbackURL);
    const settings = {user_id:owner,toolkits:{enable:[kit.slug]},multi_account:{enable:true}};
    if (authConfigId) {
      identifier(authConfigId,/^ac_[\w-]{1,200}$/,'Invalid Composio auth config ID.');
      const config = await request('/auth_configs/'+authConfigId);
      if (config?.id !== authConfigId || config.toolkit?.slug?.toLowerCase() !== kit.slug ||
          config.status !== 'ENABLED' || config.is_enabled_for_tool_router === false) {
        fail('Select an enabled Composio auth config for this toolkit.');
      }
      settings.auth_configs = {[kit.slug]:authConfigId};
    } else if (!kit.managedAuthSchemes.length) {
      if (discoverProjectConfigs) {
        const configs = await request('/auth_configs'+query({toolkit_slug:kit.slug,show_disabled:'false',limit:'2'}));
        const eligible = configs?.items?.filter(c => c.toolkit?.slug?.toLowerCase()===kit.slug && c.status==='ENABLED' && c.is_enabled_for_tool_router!==false);
        if (!configs.next_cursor && eligible?.length===1) {
          authConfigId = identifier(eligible[0].id,/^ac_[\w-]{1,200}$/,'Invalid project auth configuration.');
          settings.auth_configs = {[kit.slug]:authConfigId};
        }
      }
      if (!authConfigId) fail('Airport has not enabled sign-in for this app. Ask your Airport administrator to configure it.');
    }
    const session = await request('/tool_router/session',settings);
    const sessionId = identifier(session?.session_id,/^trs_[\w-]{1,200}$/,'Composio returned an invalid session.');
    const link = await request('/tool_router/session/'+sessionId+'/link',{toolkit:kit.slug,callback_url:callbackURLString});
    let url;
    try { url = new URL(link?.redirect_url); } catch { fail('Composio returned an invalid sign-in link.'); }
    if (url.origin !== 'https://connect.composio.dev' || url.username || url.password || !url.pathname.startsWith('/link/')) {
      fail('Composio returned an invalid sign-in link.');
    }
    return {accountId:account(link.connected_account_id),url:url.href};
  }

  async function verify({owner,toolkit,accountId},pilotGmail=false) {
    const key = slug(toolkit).toLowerCase();
    ownerId(owner);
    if (accountId == null) {
      if ((await toolkitBySlug(key)).requiresAuth) fail('Connect an account for this toolkit first.');
      return {active:true,status:'NO_AUTH'};
    }
    account(accountId);
    // user_id on returned records is deprecated. Filtering by owner and the
    // exact account ID also covers deployments which omit the returned owner.
    const match = await request('/connected_accounts'+query({user_ids:owner,connected_account_ids:accountId,toolkit_slugs:key,limit:'1'}));
    const row = match?.items?.[0];
    if (match?.items?.length !== 1 || row?.id !== accountId || row.toolkit?.slug?.toLowerCase() !== key ||
        (row.user_id !== undefined && row.user_id !== owner) || row.experimental?.account_type === 'SHARED' ||
        (Object.hasOwn(authConfigs,key) && row.auth_config?.id !== authConfigs[key]) ||
        (pilotGmail && pilotGmailConfig && row.auth_config?.id !== pilotGmailConfig)) {
      fail('The connected account could not be verified for this workspace and toolkit.');
    }
    if (row.is_disabled || row.auth_config?.is_disabled) return {active:false,status:'DISABLED'};
    if (!accountStates.has(row.status)) fail('Composio returned an unknown connection state.');
    return {active:row.status === 'ACTIVE',status:row.status};
  }

  async function execute(input) {
    const allowed = ['owner','toolkit','accountId','slug','args','version','beforeDispatch','pilotGmail'];
    if (!object(input) || Object.keys(input).some(key => !allowed.includes(key))) fail('Invalid Composio execution parameters.');
    const {owner,toolkit,accountId,slug:name,args,version:requestedVersion} = input;
    ownerId(owner);
    const key = slug(toolkit).toLowerCase();
    if(input.pilotGmail!==undefined && (input.pilotGmail!==true || key!=='gmail' || !accountId))fail('Invalid Gmail account binding.');
    if (!object(args)) fail('Tool arguments must be a JSON object.');
    if (input.beforeDispatch !== undefined && typeof input.beforeDispatch !== 'function') fail('Invalid Composio dispatch guard.');
    if (slug(name).toLowerCase() === 'proxy') fail('Use a named catalog tool.');
    const tool = await getTool(name,requestedVersion);
    if (tool.toolkit !== key) fail('This tool belongs to another toolkit.');
    if (!accountId && !tool.noAuth) fail('This tool requires a connected account.');
    const grant = await verify({owner,toolkit:key,accountId},input.pilotGmail);
    if (!grant.active) fail('Reconnect the inactive account before using this tool.');
    // Only the dedicated arguments field contains provider-defined inputs.
    // Never merge those inputs into the execution envelope or retry a write.
    const body = {user_id:owner,version:tool.version,arguments:args};
    if (accountId) body.connected_account_id = accountId;
    // Grant revocation or a policy edit can occur during the preceding network reads.
    if (input.beforeDispatch) {
      const allowedNow = input.beforeDispatch(tool);
      if (allowedNow && typeof allowedNow.then === 'function') {
        Promise.resolve(allowedNow).catch(() => {});
        fail('The Composio dispatch guard must be synchronous.');
      }
      if (allowedNow === false) fail('The tool grant changed before dispatch.');
    }
    const result = await request('/tools/execute/'+tool.slug,body);
    if (result?.successful !== true || result.error != null || !Object.hasOwn(result,'data')) {
      fail('The provider did not report a successful tool execution. Check the Composio execution history for details.');
    }
    return {data:result.data};
  }
  async function completeAuth({owner,sessionUri}) {
    ownerId(owner);
    if (typeof sessionUri !== 'string' || !sessionUri.length || sessionUri.length > 8192 || /[\r\n]/.test(sessionUri)) fail('Invalid Composio verification session.');
    const completed = await request('/connected_accounts/complete_auth',{user_id:owner,session_uri:sessionUri});
    return {accountId:account(completed?.connected_account_id),toolkit:slug(completed?.toolkit_slug).toLowerCase()};
  }
  return {listToolkits,listTools,getTool,start,verify,execute,completeAuth};
}
