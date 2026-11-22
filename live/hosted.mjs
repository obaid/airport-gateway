import { createHash, createHmac } from 'node:crypto';
import { chmodSync, constants, lstatSync, mkdirSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { createComposio } from './composio.mjs';
import { createCatalog, parseProjectAuthConfigs } from './catalog.mjs';
import { body as readOwnerBody, connectionHomeURL, createOwnerHandler, isConsolePage, serveBrandAsset, serveOwnerAsset } from './owner.mjs';
import { createToolRunner, makeAgentHandler } from './agent.mjs';
import { canonicalEmail, createAccounts } from './accounts.mjs';
import { createCodeSender, createEmailAuth, readEmailConfig, requestAddress } from './email-auth.mjs';
import { createStore } from './store.mjs';
import { createPlatformOverview } from './platform-admin.mjs';

const gatewayRoutes = new Set(['/mcp','/api/gmail/inbox-counts','/api/connections','/airport/connect','/pair/start','/pair/token','/agents/register']);

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
  const authMode = env.AIRPORT_AUTH_MODE ?? 'access';
  if (!['access','email'].includes(authMode)) throw Error('Set AIRPORT_AUTH_MODE to email or access.');
  let issuer, emailConfig;
  if (authMode==='access') {
    issuer = httpsBase(env.CF_ACCESS_ISSUER,'CF_ACCESS_ISSUER',false);
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname) || issuer.port) {
      throw Error('Set CF_ACCESS_ISSUER to the Cloudflare Access team origin.');
    }
    if (!env.CF_ACCESS_AUD?.trim()) throw Error('Set CF_ACCESS_AUD to the owner application audience.');
  } else {
    emailConfig = readEmailConfig(env);
  }
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
  const signupMode = env.AIRPORT_SIGNUP_MODE ?? 'invite';
  if(!['invite','open'].includes(signupMode))throw Error('Set AIRPORT_SIGNUP_MODE to invite or open.');
  const bootstrapEmail=env.AIRPORT_BOOTSTRAP_OWNER_EMAIL ? canonicalEmail(env.AIRPORT_BOOTSTRAP_OWNER_EMAIL) : null;
  const bootstrapTenant=env.AIRPORT_BOOTSTRAP_OWNER_TENANT || null;
  if(env.AIRPORT_BOOTSTRAP_OWNER_EMAIL && !bootstrapEmail)throw Error('Set a valid AIRPORT_BOOTSTRAP_OWNER_EMAIL.');
  if(bootstrapTenant && (!bootstrapEmail || !/^[a-f0-9]{64}$/.test(bootstrapTenant)))throw Error('Set the bootstrap tenant alongside its verified owner email.');
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid listening PORT.');
  const maintenance = env.AIRPORT_MAINTENANCE ?? '0';
  if (!['0','1'].includes(maintenance)) throw Error('Set AIRPORT_MAINTENANCE to 0 or 1.');
  return {
    ownerOrigin:owner.origin,agentBase:agent.href.replace(/\/$/,''),
    authMode,emailConfig,renderIngress:env.RENDER==='true',issuer:issuer?.origin,audience:env.CF_ACCESS_AUD?.trim(),secret,dataDir:env.AIRPORT_HOSTED_DATA_DIR,
    apiKey:env.COMPOSIO_API_KEY.trim(),gmailConfig:authConfigs.gmail || env.COMPOSIO_GMAIL_AUTH_CONFIG_ID?.trim() || undefined,authConfigs,verifierPath,
    host:env.HOST || '127.0.0.1',port,maintenance:maintenance === '1',signupMode,bootstrapEmail,bootstrapTenant
  };
}

function errorResponse(res,status,reason,code) {
  const message = reason || {401:'Sign in to Airport.',404:'Route not found.',500:'Airport could not complete the request.'}[status];
  res.writeHead(status,{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(code ? {error:message,code} : {error:message}));
}

async function servePublicPage(req,res,page) {
  // Hash only the deployment's static pages. Route names never come from user input.
  const [template,accessStyle]=await Promise.all([
    readFile(new URL('./ui/'+page+'.html',import.meta.url),'utf8'),
    readFile(new URL('./ui/access.css',import.meta.url),'utf8')
  ]);
  const html=template.replace('/* airport-access-style */',()=>accessStyle);
  const inlineHashes=tag=>Array.from(html.matchAll(new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+tag+'>','gi')),
    match=>"'sha256-"+createHash('sha256').update(match[1]).digest('base64')+"'");
  const csp=["default-src 'none'",'style-src '+inlineHashes('style').join(' '),'script-src '+inlineHashes('script').join(' '),
    ...(page==='login'?["connect-src 'self'"]:[]),
    "img-src 'self' data:","font-src 'self'","frame-ancestors 'none'","base-uri 'none'","form-action 'none'"].join('; ');
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-store',
    'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':csp});
  res.end(req.method==='HEAD'?undefined:html);
}

export function createHostedGateway(config, {fetchKeys,provider,catalog,sendCode} = {}) {
  // Values for issuer, audience and the key source come exclusively from operator configuration.
  const keys = config.authMode==='access' ? createRemoteJWKSet(new URL('/cdn-cgi/access/certs',config.issuer),fetchKeys ? {[customFetch]:fetchKeys} : {}) : null;
  const gmail = provider || createComposio(config.apiKey,config.gmailConfig);
  const catalogAPI = catalog || createCatalog(config.apiKey,{authConfigs:config.authConfigs,pilotGmailConfig:config.gmailConfig});
  const options = {getProvider:()=>gmail,getCatalog:()=>catalogAPI};
  const ownerHost = new URL(config.ownerOrigin).host;
  const agentURL = new URL(config.agentBase);
  const agentPrefix = agentURL.pathname.replace(/\/$/,'')+'/gateway/';
  const dir = join(config.dataDir,'tenants');
  mkdirSync(dir,{recursive:true,mode:0o700});
  if (!lstatSync(dir).isDirectory()) throw Error('The tenant storage path must be a directory.');
  chmodSync(dir,0o700);
  const accounts=createAccounts(join(config.dataDir,'accounts.sqlite3'),config);
  const platformOverview=createPlatformOverview(dir,()=>accounts.countUsers());
  const emailAuth = config.authMode==='email' ? createEmailAuth(join(config.dataDir,'authentication.sqlite3'),{
    secret:config.secret,sendCode:sendCode || createCodeSender(config.emailConfig),
    verifiedIdentity(email) {
      const tenant = accounts.tenantForVerifiedEmail(email) ||
        createHmac('sha256',config.secret).update(JSON.stringify(['airport-email-v1',email])).digest('hex');
      return {tenant,email};
    }
  }) : null;
  const tenants = new Map();
  let closing = false;

  async function identity(req) {
    if (emailAuth) {
      const person=emailAuth.read(req);
      return person && accounts.emailSessionIsCurrent(person) ? person : null;
    }
    const assertion = req.headers['cf-access-jwt-assertion'];
    if (typeof assertion !== 'string' || assertion.length > 32768) return null;
    try {
      const {payload} = await jwtVerify(assertion,keys,{
        algorithms:['RS256'],issuer:config.issuer,audience:config.audience,
        requiredClaims:['exp','iat','sub','type','email']
      });
      if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 512) return null;
      // Access signs the email authenticated by the configured human identity provider.
      // Service tokens lack a human email; an explicitly unverified IdP email is rejected.
      const email=canonicalEmail(payload.email);
      if(!email || payload.common_name || (payload.email_verified!==undefined && payload.email_verified!==true))return null;
      const tenant=createHmac('sha256',config.secret).update(JSON.stringify([config.issuer,payload.sub])).digest('hex');
      return {tenant,email};
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
      res.writeHead(303,{'Cache-Control':'no-store','Referrer-Policy':'no-referrer',Location:connectionHomeURL(p.workspace,p.id || 'pilot-gmail','active')}).end();
    } catch {errorResponse(res,409,'Airport could not verify this connection. Return to Airport and restart sign-in.');}
  }

  const sendJSON=(res,status,payload)=>{
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    res.end(JSON.stringify(payload));
  };
  const isPlatformAdmin=(person,account)=>Boolean(config.bootstrapEmail && account && account.email===config.bootstrapEmail &&
    person.email===config.bootstrapEmail && (!config.bootstrapTenant || config.bootstrapTenant===person.tenant));
  const session=(person,account)=>({identity:{email:person.email,accountKey:person.tenant},account,
    isPlatformAdmin:isPlatformAdmin(person,account),signupMode:config.signupMode,authMode:config.authMode});
  async function authAPI(req,res,target) {
    if (req.method!=='POST') return errorResponse(res,404);
    const form=await readOwnerBody(req,config.ownerOrigin);
    switch(target) {
      case '/api/auth/start': {
        try {
          const result=await emailAuth.start(form.email,requestAddress(req,config.renderIngress));
          return sendJSON(res,200,result);
        } catch (error) {
          if (error.status===503) return errorResponse(res,503,error.message);
          throw error;
        }
      }
      case '/api/auth/verify':
        res.setHeader('Set-Cookie',emailAuth.verify(form.challengeId,form.code,req));
        return sendJSON(res,200,{ok:true});
      case '/api/auth/logout':
        res.setHeader('Set-Cookie',emailAuth.logout(req));
        return sendJSON(res,200,{ok:true});
      default: return errorResponse(res,404);
    }
  }
  async function accountAPI(req,res,target,person,account) {
    if(req.method==='GET' && target==='/api/account')return sendJSON(res,200,session(person,account));
    if(req.method==='GET' && target==='/api/account/invitations')
      return sendJSON(res,200,{invitations:accounts.listInvitations(person)});
    if(req.method!=='POST')return errorResponse(res,404);
    const form=await readOwnerBody(req,config.ownerOrigin);
    switch(target) {
      case '/api/account/signup':
        return sendJSON(res,201,session(person,accounts.signup(person,form.displayName,form.token)));
      case '/api/account/profile':
        return sendJSON(res,200,session(person,accounts.profile(person,form.displayName)));
      case '/api/account/invitations': {
        const {invitation,token}=accounts.invite(person,form.email);
        return sendJSON(res,201,{invitation,inviteUrl:config.ownerOrigin+'/welcome#invite='+token});
      }
      case '/api/account/invitations/revoke':
        return sendJSON(res,200,{invitation:accounts.revoke(person,form.id)});
      default: return errorResponse(res,404);
    }
  }

  const server = createServer(async (req,res) => {
    let entry;
    try {
      const target = req.url || '/';
      const host = req.headers.host;
      // The platform may probe with its own hostname before custom domains are ready.
      if (target === '/healthz' && req.method === 'GET') {
        try {
          await access(dir,constants.R_OK | constants.W_OK | constants.X_OK);
          res.writeHead(204,{'Cache-Control':'no-store'}).end();
        } catch {
          res.writeHead(503,{'Cache-Control':'no-store'}).end();
        }
        return;
      }
      if (config.maintenance) return errorResponse(res,503,'Airport is undergoing maintenance.');
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
      if (await serveBrandAsset(req,res,target)) return;
      if(target==='/welcome' && ['GET','HEAD'].includes(req.method))return await servePublicPage(req,res,'welcome');
      if(emailAuth && target.startsWith('/api/auth/')) return await authAPI(req,res,target);
      const pathname=target.split('?',1)[0];
      const consolePage=isConsolePage(pathname);
      const adminPage=pathname==='/admin'||pathname==='/admin/';
      const adminAsset=pathname==='/platform-admin.css'||pathname==='/platform-admin.js';
      const person = await identity(req);
      if(emailAuth && !person && ['GET','HEAD'].includes(req.method)) {
        // Sign in at the bookmarked address. Reloading it after verification opens the console.
        if(target==='/login' || consolePage || adminPage)return await servePublicPage(req,res,'login');
        if(target==='/')return res.writeHead(303,{'Cache-Control':'no-store','Referrer-Policy':'no-referrer',Location:'/login'}).end();
      }
      if (!person) return errorResponse(res,401);
      if(target==='/login' && ['GET','HEAD'].includes(req.method)) {
        res.writeHead(303,{'Cache-Control':'no-store','Referrer-Policy':'no-referrer',Location:'/'}).end();
        return;
      }
      if(!adminPage && await serveOwnerAsset(req,res,consolePage?'/':target))return;
      const tenant=person.tenant;
      const legacyFile=join(dir,tenant+'.sqlite3');
      const account=accounts.resolve(person,lstatSync(legacyFile,{throwIfNoEntry:false})?.isFile()===true);
      if (target==='/api/account' || target.startsWith('/api/account/')) return await accountAPI(req,res,target,person,account);
      if(adminPage || adminAsset || pathname==='/api/admin/overview'){
        if(!isPlatformAdmin(person,account))return errorResponse(res,403,'Platform administrator access required.');
        if(!['GET','HEAD'].includes(req.method))return errorResponse(res,404);
        if(adminPage)return await serveOwnerAsset(req,res,'/');
        if(adminAsset){
          const contents=await readFile(new URL('./ui'+pathname,import.meta.url));
          res.writeHead(200,{'Content-Type':pathname.endsWith('.js')?'text/javascript':'text/css','Cache-Control':'no-store',
            'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
          return res.end(req.method==='HEAD'?undefined:contents);
        }
        if(req.method!=='GET')return errorResponse(res,404);
        try{return sendJSON(res,200,await platformOverview());}
        catch{return errorResponse(res,503,'Platform overview is temporarily unavailable.');}
      }
      if (!account) return errorResponse(res,403,'Create your Airport account first.','account_required');
      const isVerifier = config.verifierPath && target.split('?')[0]===config.verifierPath;
      entry = acquire(tenant,!isVerifier);
      if (!entry && isVerifier) return errorResponse(res,409,'This owner has no pending Airport connection.');
      if (!entry) return errorResponse(res,500);
      if (isVerifier) return await verifyConnection(req,res,entry.store);
      return await entry.owner(req,res);
    } catch(error) {
      if (!res.headersSent && Number.isInteger(error.status) && error.status>=400 && error.status<500)
        errorResponse(res,error.status,error.message,error.code);
      else if (!res.headersSent) errorResponse(res,500);
      else if (!res.writableEnded) res.end();
    } finally {
      if (entry) entry.users--;
      trim();
    }
  });
  server.on('close',() => {
    closing = true;
    trim();
    emailAuth?.close();
    accounts.close();
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
