import { createHmac } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { createComposio } from './composio.mjs';
import { createCatalog, parseProjectAuthConfigs } from './catalog.mjs';
import { createOwnerHandler } from './owner.mjs';
import { createToolRunner, makeAgentHandler } from './agent.mjs';
import { createStore } from './store.mjs';

const gatewayRoutes = new Set(['/mcp','/api/gmail/inbox-counts','/airport/connect','/pair/start','/pair/token','/agents/register']);

function httpsBase(value,name,allowPath) {
  let url;
  try { url = new URL(value); } catch { /* Report the setting name without its contents. */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (!allowPath && url.pathname !== '/') || !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)?$/.test(url.pathname)) {
    throw Error('Configure a valid HTTPS URL for '+name+'.');
  }
  return url;
}

export function readHostedConfig(env = process.env) {
  const owner = httpsBase(env.AIRPORT_OWNER_ORIGIN,'AIRPORT_OWNER_ORIGIN',false);
  const agent = httpsBase(env.AIRPORT_AGENT_BASE,'AIRPORT_AGENT_BASE',true);
  const issuer = httpsBase(env.CF_ACCESS_ISSUER,'CF_ACCESS_ISSUER',false);
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname) || issuer.port) {
    throw Error('Set CF_ACCESS_ISSUER to the Cloudflare Access team origin.');
  }
  if (!env.CF_ACCESS_AUD?.trim()) throw Error('Set CF_ACCESS_AUD to the owner application audience.');
  const secretText = env.AIRPORT_TENANT_SECRET || '';
  const secret = Buffer.from(secretText,'base64url');
  if (secret.length < 32 || secret.toString('base64url') !== secretText) {
    throw Error('Set a stable base64url AIRPORT_TENANT_SECRET of at least 32 random bytes.');
  }
  if (!env.AIRPORT_HOSTED_DATA_DIR || !isAbsolute(env.AIRPORT_HOSTED_DATA_DIR)) {
    throw Error('Set AIRPORT_HOSTED_DATA_DIR to an absolute path on the persistent volume.');
  }
  if (!env.COMPOSIO_API_KEY?.trim()) throw Error('Set the server-side COMPOSIO_API_KEY.');
  const authConfigs = parseProjectAuthConfigs(env.AIRPORT_AUTH_CONFIGS_JSON);
  const verifierPath = env.AIRPORT_COMPOSIO_VERIFIER_PATH || '';
  if (verifierPath && (!/^\/oauth\/[\w-]+$/.test(verifierPath) || verifierPath==='/oauth/done')) throw Error('Invalid AIRPORT_COMPOSIO_VERIFIER_PATH.');
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid listening PORT.');
  return {
    ownerOrigin:owner.origin,agentBase:agent.href.replace(/\/$/,''),
    issuer:issuer.origin,audience:env.CF_ACCESS_AUD.trim(),secret,dataDir:env.AIRPORT_HOSTED_DATA_DIR,
    apiKey:env.COMPOSIO_API_KEY.trim(),gmailConfig:authConfigs.gmail || env.COMPOSIO_GMAIL_AUTH_CONFIG_ID?.trim() || undefined,authConfigs,verifierPath,
    host:env.HOST || '127.0.0.1',port
  };
}

function errorResponse(res,status,reason) {
  const message = reason || {401:'Sign in to Airport with Cloudflare Access.',404:'Route not found.',500:'Airport could not complete the request.'}[status];
  res.writeHead(status,{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify({error:message}));
}

export function createHostedGateway(config, {fetchKeys,provider,catalog} = {}) {
  // Values for issuer, audience and the key source come exclusively from operator configuration.
  const keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs',config.issuer),fetchKeys ? {[customFetch]:fetchKeys} : {});
  const gmail = provider || createComposio(config.apiKey,config.gmailConfig);
  const catalogAPI = catalog || createCatalog(config.apiKey,{authConfigs:config.authConfigs});
  const options = {getProvider:()=>gmail,getCatalog:()=>catalogAPI};
  const ownerHost = new URL(config.ownerOrigin).host;
  const agentURL = new URL(config.agentBase);
  const agentPrefix = agentURL.pathname.replace(/\/$/,'')+'/gateway/';
  const dir = join(config.dataDir,'tenants');
  mkdirSync(dir,{recursive:true,mode:0o700});
  if (!lstatSync(dir).isDirectory()) throw Error('The tenant storage path must be a directory.');
  chmodSync(dir,0o700);
  const tenants = new Map();
  let closing = false;

  async function identity(req) {
    const assertion = req.headers['cf-access-jwt-assertion'];
    if (typeof assertion !== 'string' || assertion.length > 32768) return null;
    try {
      const {payload} = await jwtVerify(assertion,keys,{
        algorithms:['RS256'],issuer:config.issuer,audience:config.audience,
        requiredClaims:['exp','iat','sub','type']
      });
      if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 512) return null;
      return createHmac('sha256',config.secret).update(JSON.stringify([config.issuer,payload.sub])).digest('hex');
    } catch { return null; }
  }

  function acquire(tenant,canCreate) {
    let entry = tenants.get(tenant);
    if (!entry) {
      const file = join(dir,tenant+'.sqlite3');
      const stat = lstatSync(file,{throwIfNoEntry:false});
      if ((!canCreate && !stat) || (stat && !stat.isFile())) return null;
      const store = createStore(file);
      chmodSync(file,0o600);
      const publicBase = config.agentBase+'/gateway/'+tenant;
      const run = createToolRunner({store,...options});
      // The outer request handler verifies identity and derives this tenant
      // before any owner route, including assets, reaches the shared handler.
      const owner = createOwnerHandler({store,...options,ownerOrigin:config.ownerOrigin,publicBase,requireOwner:()=>{}});
      const agent = makeAgentHandler({store,run,publicURL:publicBase});
      entry = {store,owner,agent,users:0};
    }
    tenants.delete(tenant);
    tenants.set(tenant,entry);
    entry.users++;
    return entry;
  }

  function trim() {
    for (const [id,entry] of tenants) {
      if (!closing && tenants.size <= 32) break;
      if (!entry.users) { entry.store.close(); tenants.delete(id); }
    }
  }

  async function verifyConnection(req,res,store) {
    const url = new URL(req.url,config.ownerOrigin);
    const params = [...url.searchParams];
    if (req.method !== 'GET' || params.length !== 1 || params[0][0] !== 'session_uri') {
      return errorResponse(res,400,'Invalid connector verification callback.');
    }
    // The provider supplies no user or connection identity in this redirect.
    // Redeem against one server-held attempt belonging to this signed-in tenant.
    const state = store.state();
    const pending = [];
    for (const w of state.workspaces) {
      const row = store.get(w.id);
      if (row.status==='pending' && row.account) pending.push({workspace:w.id,owner:row.owner,account:row.account,toolkit:'gmail',attempt:row.attempt});
    }
    for (const c of state.connections || []) {
      if (c.status!=='pending') continue;
      const row = store.getConnection(c.workspace,c.id);
      if (row.accountId) pending.push({workspace:c.workspace,id:c.id,owner:row.owner,toolkit:row.toolkit,account:row.accountId});
    }
    if (pending.length!==1) return errorResponse(res,409,'Airport needs exactly one pending app sign-in in this owner account. Return to Airport and retry the intended connection.');
    const p = pending[0];
    try {
      const result = await catalogAPI.completeAuth({owner:p.owner,sessionUri:params[0][1]});
      if (result.accountId!==p.account || result.toolkit!==p.toolkit) throw Error();
      if (p.id) {
        const verified = await catalogAPI.verify({owner:p.owner,toolkit:p.toolkit,accountId:p.account});
        if (!verified.active) throw Error();
        store.activateConnection(p.workspace,p.id,p.account);
      } else {
        const verified = await gmail.verify(p.owner,p.account);
        if (!verified.active || !store.activate(p.workspace,p.attempt,verified.email)) throw Error();
      }
      res.writeHead(303,{'Cache-Control':'no-store','Referrer-Policy':'no-referrer',Location:'/'}).end();
    } catch {errorResponse(res,409,'Airport could not verify this connection. Return to Airport and restart sign-in.');}
  }

  const server = createServer(async (req,res) => {
    let entry;
    try {
      const target = req.url || '/';
      const host = req.headers.host;
      if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) return errorResponse(res,404);
      if (host === agentURL.host && target.startsWith(agentPrefix)) {
        const match = /^([0-9a-f]{64})(\/[^?]*)$/.exec(target.slice(agentPrefix.length));
        if (!match || !gatewayRoutes.has(match[2])) return errorResponse(res,404);
        entry = acquire(match[1],false);
        if (!entry) return errorResponse(res,404);
        req.url = match[2];
        return await entry.agent(req,res);
      }
      if (host !== ownerHost) return errorResponse(res,404);
      const tenant = await identity(req);
      if (!tenant) return errorResponse(res,401);
      const isVerifier = config.verifierPath && target.split('?')[0]===config.verifierPath;
      entry = acquire(tenant,!isVerifier);
      if (!entry && isVerifier) return errorResponse(res,409,'This owner has no pending Airport connection.');
      if (!entry) return errorResponse(res,500);
      if (isVerifier) return await verifyConnection(req,res,entry.store);
      return await entry.owner(req,res);
    } catch {
      if (!res.headersSent) errorResponse(res,500);
      else if (!res.writableEnded) res.end();
    } finally {
      if (entry) entry.users--;
      trim();
    }
  });
  server.on('close',() => {
    closing = true;
    trim();
  });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.umask(0o077);
    const config = readHostedConfig();
    const server = createHostedGateway(config);
    server.on('error',() => {console.error('Airport could not open the hosted listener. Check HOST and PORT.');process.exitCode=1;});
    server.listen(config.port,config.host,() => console.log('Airport hosted gateway is ready.'));
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => server.close());
  } catch (error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
