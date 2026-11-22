import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { createStore } from './store.mjs';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHostedGateway, readHostedConfig } from './hosted.mjs';

const team = 'https://testteam.cloudflareaccess.com';
const audience = 'test-owner-app';
const ownerHost = 'owners.example.com',agentHost = 'agents.example.com';
const signing = await generateKeyPair('RS256');
const keySet = {keys:[{...await exportJWK(signing.publicKey),kid:'test',alg:'RS256'}]};
const fetchKeys = async url => {
  assert.equal(String(url),team+'/cdn-cgi/access/certs');
  return Response.json(keySet);
};
const env = dir => ({
  AIRPORT_OWNER_ORIGIN:'https://'+ownerHost,AIRPORT_AGENT_BASE:'https://'+agentHost+'/airport/v1',
  AIRPORT_HOSTED_DATA_DIR:dir,AIRPORT_TENANT_SECRET:Buffer.alloc(32,77).toString('base64url'),
  CF_ACCESS_ISSUER:team,CF_ACCESS_AUD:audience,COMPOSIO_API_KEY:'synthetic-project-key',AIRPORT_SIGNUP_MODE:'open'
});

function token(sub,claims={},privateKey=signing.privateKey) {
  const now = Math.floor(Date.now()/1000);
  return new SignJWT({type:'app',iss:team,aud:[audience],iat:now,exp:now+1200,sub,email:sub+'@example.com',...claims})
    .setProtectedHeader({alg:'RS256',kid:'test'}).sign(privateKey);
}

async function listen(config,overrides={}) {
  const provider = {
    async start(owner) {return {connectionId:'ca_'+owner,url:'https://connect.composio.dev/link/ln_example'};},
    async verify(owner,id) {assert.equal(id,'ca_'+owner);return {active:true,status:'ACTIVE',email:'work@example.com'};},
    async counts(owner,id) {assert.equal(id,'ca_'+owner);return {total:12,unread:4};}
  };
  const server = createHostedGateway(config,{fetchKeys,provider,catalog:{
    async listToolkits() {return {items:[],nextCursor:null};}
  },...overrides});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const port = server.address().port;
  function send(host,path,headers={},data,method=data === undefined ? 'GET':'POST') {
    return new Promise((resolve,reject) => {
      const req = request({hostname:'127.0.0.1',port,path,method,headers:{host,...headers}},res=>{
        const chunks = [];
        res.on('data',chunk=>chunks.push(chunk));
        res.on('end',()=>{
          const raw = Buffer.concat(chunks).toString();
          const body = raw && res.headers['content-type']?.startsWith('application/json') ? JSON.parse(raw) : raw;
          resolve({status:res.statusCode,headers:res.headers,body});
        });
      });
      req.on('error',reject);
      req.end(data === undefined ? undefined:JSON.stringify(data));
    });
  }
  const owner = (assertion,path='/api/state',data) => send(ownerHost,path,{
    'cf-access-jwt-assertion':assertion,'x-airport-console':'1','content-type':'application/json',origin:'https://'+ownerHost
  },data);
  const close = () => new Promise(resolve => server.close(resolve));
  const signup=async(assertion,displayName='Test user')=>{
    const result=await owner(assertion,'/api/account/signup',{displayName});
    assert.equal(result.status,201);
    return result.body.account;
  };
  return {send,owner,close,signup};
}

test('Render readiness checks tenant storage without creating a tenant or exposing an owner route',async t=>{
  const dir = mkdtempSync(join(tmpdir(),'airport-readiness-'));
  const app = await listen(readHostedConfig(env(dir)));
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  for (const host of ['deployment.example.net', ownerHost, agentHost]) {
    const check = await app.send(host,'/healthz');
    assert.equal(check.status,204);
    assert.equal(check.body,'');
    assert.equal(check.headers['cache-control'],'no-store');
  }
  assert.equal((await app.send('deployment.example.net','/api/state')).status,404);
  assert.equal((await app.send(ownerHost,'/api/state')).status,401);
  assert.equal((await app.send(ownerHost,'/healthz',{},{})).status,401);
  assert.deepEqual(readdirSync(join(dir,'tenants')),[]);
  renameSync(join(dir,'tenants'),join(dir,'offline'));
  const offline = await app.send('deployment.example.net','/healthz');
  assert.equal(offline.status,503);
  assert.equal(offline.body,'');
});

test('maintenance keeps the volume online and stops both owner and agent traffic',async t=>{
  const dir = mkdtempSync(join(tmpdir(),'airport-maintenance-'));
  const config = {...env(dir),AIRPORT_MAINTENANCE:'1'};
  assert.throws(()=>readHostedConfig({...config,AIRPORT_MAINTENANCE:'yes'}),/AIRPORT_MAINTENANCE/);
  const app = await listen(readHostedConfig(config));
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  assert.equal((await app.send(ownerHost,'/healthz')).status,204);
  assert.equal((await app.send(ownerHost,'/api/state')).status,503);
  assert.equal((await app.send(agentHost,'/gateway/'+'a'.repeat(64)+'/mcp',{},{})).status,503);
  assert.deepEqual(readdirSync(join(dir,'tenants')),[]);
});

test('owner access verifies the signature, issuer, audience, application-token type, subject and time before opening any SQLite file',async t=>{
  const dir = mkdtempSync(join(tmpdir(),'airport-access-'));
  const app = await listen(readHostedConfig(env(dir)));
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const otherKey = (await generateKeyPair('RS256')).privateKey;
  const wrong = [
    await token('owner',{iss:'https://other.cloudflareaccess.com'}),await token('owner',{aud:'different-app'}),
    await token('owner',{type:'org'}),await token('owner',{email:''}),await token('owner',{email_verified:false}),await token('',{common_name:'a service token'}),await token('owner',{exp:1}),
    await token('owner',{nbf:Math.floor(Date.now()/1000)+90}),await token('owner',{},otherKey),'unsigned.claims.test'
  ];
  for (const assertion of wrong) assert.equal((await app.owner(assertion)).status,401);
  for (const path of ['/','/api/state','/assets/icons.js','/oauth/done']) {
    assert.equal((await app.send(ownerHost,path,{'cf-access-authenticated-user-email':'pretend@example.com'})).status,401);
  }
  assert.deepEqual(readdirSync(join(dir,'tenants')),[]);
  const user=await token('owner');
  assert.equal((await app.owner(user)).status,403);
  await app.signup(user);
  assert.equal((await app.owner(user)).status,200);
});

test('owners retain isolated state across restarts and bearer-only data reads bind to one existing tenant',async t=>{
  const dir = mkdtempSync(join(tmpdir(),'airport-hosted-'));
  const config = readHostedConfig(env(dir));
  let app = await listen(config);
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const a = await token('owner-a'), b = await token('owner-b');
  await app.signup(a); await app.signup(b);
  const stateA = (await app.owner(a)).body;
  const stateB = (await app.owner(b)).body;
  const pathA = new URL(stateA.publicURL).pathname, pathB = new URL(stateB.publicURL).pathname;
  assert.match(pathA,/^\/airport\/v1\/gateway\/[0-9a-f]{64}$/);
  assert.notEqual(pathA,pathB);
  assert.equal(stateA.providerManaged,true);
  assert.equal((await app.owner(a,'/api/key',{key:'never-use-this-project-key'})).status,403);
  assert.equal((await app.owner(a,'/api/workspace-create',{name:'Only A'})).status,200);
  assert.equal((await app.owner(a,'/api/connect',{workspace:'work',expectedEmail:'work@example.com'})).status,200);
  assert.equal((await app.owner(a,'/api/check',{workspace:'work'})).body.status,'active');
  assert.equal((await app.owner(a,'/api/policy',{workspace:'work',policy:'Allow'})).status,200);
  const grant = await app.owner(a,'/api/connector-grant',{workspace:'work'});
  assert.equal(grant.status,200);
  const auth = {authorization:'Bearer '+grant.body.token};
  const other = (await app.owner(b)).body;
  assert(!other.workspaces.some(ws=>ws.name==='Only A'));
  assert.equal(other.workspaces.find(ws=>ws.id==='work').policy,'Block');
  assert.equal(other.logs.length,0);
  assert.equal((await app.send(agentHost,pathA+'/api/gmail/inbox-counts')).status,401);
  assert.equal((await app.send(agentHost,pathB+'/api/gmail/inbox-counts',auth)).status,401);
  const valid = await app.send(agentHost,pathA+'/api/gmail/inbox-counts',auth);
  assert.deepEqual(valid.body,{total:12,unread:4});
  const setup = await app.send(agentHost,pathA+'/airport/connect');
  assert.equal(setup.status,200);
  assert(setup.body.includes(stateA.publicURL+'/mcp'));
  assert(setup.body.includes(stateA.publicURL+'/agents/register'));
  const invite = await app.owner(a,'/api/agent-invite',{workspace:'work',name:'Hosted Dot'});
  assert.equal(invite.status,200);
  const enrollment = await app.send(agentHost,pathA+'/agents/register',{'content-type':'application/json'},{invitation:invite.body.invitation});
  assert.equal(enrollment.status,200);
  assert.equal(enrollment.body.name,'Hosted Dot');
  assert.equal((await app.send(agentHost,pathA+'/api/gmail/inbox-counts',{authorization:'Bearer '+enrollment.body.token})).status,200);
  assert.equal((await app.send(agentHost,pathA+'/api/state',auth)).status,404);
  assert.equal((await app.send(agentHost,'/api/state',{'cf-access-jwt-assertion':a})).status,404);
  assert.equal((await app.send(ownerHost,'/api/state',auth)).status,401);
  const before = readdirSync(join(dir,'tenants')).sort();
  assert.equal((await app.send(agentHost,'/airport/v1/gateway/'+'1'.repeat(64)+'/mcp',auth)).status,404);
  assert.deepEqual(readdirSync(join(dir,'tenants')).sort(),before);
  await app.close();
  app = await listen(config);
  const reopened = (await app.owner(await token('owner-a',{email:'different@example.com'}))).body;
  assert.equal(reopened.publicURL,stateA.publicURL);
  assert(reopened.workspaces.some(ws=>ws.name==='Only A'));
  assert(reopened.logs.some(l=>l.workspace==='work' && l.tool==='gmail_inbox_counts'));
  assert.equal((await app.send(agentHost,pathA+'/api/gmail/inbox-counts',auth)).status,200);
  assert(!JSON.stringify(reopened).includes(config.apiKey));
});

test('hosted configuration requires explicit persistent storage, stable tenant secret and HTTPS application settings',()=>{
  const base = env('/data/airport');
  for (const [name,value] of [
    ['AIRPORT_OWNER_ORIGIN','http://owners.example.com'],['AIRPORT_OWNER_ORIGIN','https://owners.example.com/airport'],
    ['AIRPORT_AGENT_BASE','https://agents.example.com/base?secret=x'],['AIRPORT_AGENT_BASE','https://u:p@agents.example.com'],
    ['AIRPORT_TENANT_SECRET','weak'],['AIRPORT_HOSTED_DATA_DIR','relative'],['CF_ACCESS_ISSUER','https://invalid.example.com'],
    ['CF_ACCESS_AUD',''],['COMPOSIO_API_KEY',''],['PORT','99999'],['AIRPORT_AUTH_CONFIGS_JSON','invalid'],
    ['AIRPORT_SIGNUP_MODE','public'],['AIRPORT_BOOTSTRAP_OWNER_EMAIL','invalid email'],['AIRPORT_BOOTSTRAP_OWNER_TENANT','wrong'],
    ['AIRPORT_COMPOSIO_VERIFIER_PATH','/oauth/done'],['AIRPORT_COMPOSIO_VERIFIER_PATH','/api/state']
  ]) assert.throws(()=>readHostedConfig({...base,[name]:value}));
});

test('catalog OAuth returns verify the exact saved connection and land in its workspace',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-oauth-return-'));
  const callbacks=[],checks=[];
  let upstream='INITIATED';
  const catalog={
    async start({owner,toolkit,callbackURL}){
      const accountId='ca_'+owner;
      callbacks.push({owner,toolkit,accountId,url:new URL(callbackURL)});
      return {accountId,url:'https://connect.composio.dev/link/ln_example'};
    },
    async verify({owner,toolkit,accountId}){
      checks.push({owner,toolkit,accountId});
      if(upstream==='unavailable')throw Error('Temporary provider error');
      return {active:upstream==='ACTIVE',status:upstream};
    }
  };
  const app=await listen(readHostedConfig(env(dir)),{catalog});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const a=await token('a'),b=await token('b');
  await app.signup(a);await app.signup(b);
  const add=async (workspace,toolkit)=>(await app.owner(a,'/api/connection-add',{workspace,toolkit})).body.connectionId;
  const github=await add('work','github'),slack=await add('personal','slack');
  const attempt=callbacks[0],url=attempt.url;
  assert.equal(url.origin,'https://'+ownerHost);assert.equal(url.pathname,'/oauth/done');
  assert.equal(url.searchParams.get('workspace'),'work');assert.equal(url.searchParams.get('connection'),github);
  const route=url.pathname+url.search+'&status=ACTIVE&connected_account_id=ca_other';
  const settings='/#connections/'+github+'/settings?workspace=work';
  const status=async id=>(await app.owner(a)).body.connections.find(c=>c.id===id).status;
  assert.equal((await app.send(ownerHost,route)).status,401);
  assert.equal((await app.owner(b,route)).headers.location,'/');
  assert.equal((await app.owner(a,route.replace('workspace=work','workspace=personal'))).headers.location,'/');
  assert.equal((await app.owner(a,'/oauth/done?status=success')).headers.location,'/');
  assert.equal(checks.length,0);
  for(const state of ['INITIATED','unavailable','ACTIVE']){
    upstream=state;
    const result=await app.owner(a,route);
    assert.equal(result.status,303);assert.equal(result.headers.location,settings);
    assert.equal(await status(github),state==='ACTIVE'?'active':'pending');
  }
  assert.equal((await app.owner(a,route)).headers.location,settings);
  const automatic={workspace:'work',connectionId:github,pendingOnly:true};
  assert.equal((await app.owner(a,'/api/connection-check',automatic)).body.status,'active');
  await app.owner(a,'/api/connection-remove',automatic);
  assert.equal((await app.owner(a,'/api/connection-check',automatic)).body.status,'disabled');
  assert.equal((await app.owner(a,route)).headers.location,settings);
  assert.equal(await status(github),'disabled');assert.equal(await status(slack),'pending');
  const expected={owner:attempt.owner,toolkit:'github',accountId:attempt.accountId};
  assert.deepEqual(checks,[expected,expected,expected]);
});

test('a late verification response cannot undo a newer activation or a disconnect',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-oauth-race-'));
  let connection,pause=false,started,finish;
  const catalog={
    async start({owner,toolkit,callbackURL}){
      connection={owner,toolkit,accountId:'ca_'+owner,url:new URL(callbackURL)};
      return {accountId:connection.accountId,url:'https://connect.composio.dev/link/ln_example'};
    },
    async completeAuth(){return connection;},
    async verify(){
      if(!pause)return {active:true,status:'ACTIVE'};
      pause=false;
      started();
      return new Promise(resolve=>{finish=resolve;});
    }
  };
  const app=await listen(readHostedConfig({...env(dir),AIRPORT_COMPOSIO_VERIFIER_PATH:'/oauth/verify'}),{catalog});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const a=await token('a');
  await app.signup(a);
  for(const nextStatus of ['active','disabled']){
    const {connectionId}= (await app.owner(a,'/api/connection-add',{workspace:'work',toolkit:'github'})).body;
    const waiting=new Promise(resolve=>{started=resolve;});pause=true;
    const returned=app.owner(a,connection.url.pathname+connection.url.search);
    await waiting;
    if(nextStatus==='active'){
      assert.equal((await app.owner(a,'/oauth/verify?session_uri=example')).status,303);
      finish({active:false,status:'FAILED'});
    }else{
      await app.owner(a,'/api/connection-remove',{workspace:'work',connectionId});
      finish({active:true,status:'ACTIVE'});
    }
    assert.equal((await returned).status,303);
    assert.equal((await app.owner(a)).body.connections.find(c=>c.id===connectionId).status,nextStatus);
  }
});

test('the optional verifier binds a generic connection to its signed-in tenant and the precise saved provider account',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-callback-'));
  const config=readHostedConfig({...env(dir),AIRPORT_COMPOSIO_VERIFIER_PATH:'/oauth/verify'});
  let connectionOwner;
  const calls=[];
  const catalog={
    async start({owner,toolkit}) {
      assert.equal(toolkit,'github');
      connectionOwner=owner;
      return {accountId:'ca_private',url:'https://connect.composio.dev/link/ln_example'};
    },
    async completeAuth(input) {
      calls.push(input);
      return {accountId:input.sessionUri==='right'?'ca_private':'ca_other',toolkit:'github'};
    },
    async verify({owner,accountId,toolkit}) {
      assert.equal(owner,connectionOwner);assert.equal(accountId,'ca_private');assert.equal(toolkit,'github');
      return {active:true,status:'ACTIVE'};
    }
  };
  const app=await listen(config,{catalog});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const a=await token('a'), b=await token('b');
  await app.signup(a); await app.signup(b);
  const route='/oauth/verify?session_uri=';
  assert.equal((await app.send(ownerHost,route+'right')).status,401);
  assert.equal((await app.owner(b,route+'right')).status,409);
  assert.equal(readdirSync(join(dir,'tenants')).length,0);
  const added=await app.owner(a,'/api/connection-add',{workspace:'work',toolkit:'github'});
  assert.equal(added.status,200);
  assert.equal((await app.owner(b,route+'right')).status,409);
  assert.equal((await app.owner(a,route+'right&user_id=other')).status,400);
  assert.deepEqual(calls,[]);
  assert.equal((await app.owner(a,route+'other')).status,409);
  assert.equal((await app.owner(a)).body.connections[0].status,'pending');
  const verified=await app.owner(a,route+'right');
  assert.equal(verified.status,303);
  assert.equal(verified.headers.location,'/#connections/'+added.body.connectionId+'/settings?workspace=work');
  assert.equal((await app.owner(a)).body.connections[0].status,'active');
  assert.equal((await app.owner(a,route+'right')).status,409);
  assert.deepEqual(calls,[{owner:connectionOwner,sessionUri:'other'},{owner:connectionOwner,sessionUri:'right'}]);
});

test('the verifier confirms the Gmail profile and refuses ambiguous attempts before redeeming a session',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-gmail-callback-'));
  const config=readHostedConfig({...env(dir),AIRPORT_COMPOSIO_VERIFIER_PATH:'/oauth/verify'});
  let consumed=0;
  const catalog={async completeAuth({owner}){
    consumed++;
    return {toolkit:'gmail',accountId:'ca_'+owner};
  }};
  const app=await listen(config,{catalog});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const a=await token('a'),b=await token('b'), route='/oauth/verify?session_uri=opaque';
  await app.signup(a); await app.signup(b);
  await app.owner(a,'/api/connect',{workspace:'work',expectedEmail:'work@example.com'});
  await app.owner(a,'/api/connect',{workspace:'personal',expectedEmail:'personal@example.com'});
  assert.equal((await app.owner(a,route)).status,409);
  assert.equal(consumed,0);
  await app.owner(b,'/api/connect',{workspace:'work',expectedEmail:'work@example.com'});
  const verified=await app.owner(b,route);
  assert.equal(verified.status,303);
  assert.equal(verified.headers.location,'/#connections/pilot-gmail/settings?workspace=work');
  assert.equal(consumed,1);
  assert.equal((await app.owner(b)).body.workspaces.find(w=>w.id==='work').status,'active');
});

test('only the welcome page and branding assets are public in Access mode on the owner hostname and login returns to the protected portal',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-public-page-'));
  const app=await listen(readHostedConfig(env(dir)));
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const landing=await app.send(ownerHost,'/welcome');
  assert.equal(landing.status,200);
  assert.equal(landing.headers['cache-control'],'no-store');
  assert.equal(landing.headers['referrer-policy'],'no-referrer');
  const csp=landing.headers['content-security-policy'];
  for(const inline of landing.body.matchAll(/<(?:style|script)>([\s\S]*?)<\/(?:style|script)>/g)) {
    assert(csp.includes("'sha256-"+createHash('sha256').update(inline[1]).digest('base64')+"'"));
  }
  assert.match(csp,/default-src 'none'/);
  const head=await app.send(ownerHost,'/welcome',{},undefined,'HEAD');
  assert.equal(head.status,200);
  assert.equal(head.body,'');
  for (const name of ['bricolage-latin','public-sans-regular','public-sans-semibold']) {
    const fontPath='/assets/'+name+'.woff2';
    const font=await app.send(ownerHost,fontPath);
    assert.equal(font.status,200);
    assert.equal(font.headers['content-type'],'font/woff2');
    assert.equal(font.body.slice(0,4),'wOF2');
    assert.equal((await app.send(agentHost,fontPath)).status,404);
  }
  const illustration=await app.send(ownerHost,'/assets/access-airfield.svg',{},undefined,'HEAD');
  assert.equal(illustration.status,200);
  assert.equal(illustration.headers['content-type'],'image/svg+xml');
  assert.equal(illustration.body,'');
  for(const path of ['/','/login','/welcome/','/api/account','/app.js','/style.css','/assets/icons.js','/api/state','/welcome?redirect=https://other.example']) {
    assert.equal((await app.send(ownerHost,path)).status,401);
  }
  assert.equal((await app.send(agentHost,'/welcome')).status,404);
  const login=await app.owner(await token('id'),'/login');
  assert.equal(login.status,303);
  assert.equal(login.headers.location,'/');
  assert.deepEqual(readdirSync(join(dir,'tenants')),[]);
});

test('open registration requires verified human identity and explicit signup; public first signer stays a member', async t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-signup-'));
  const config=readHostedConfig({...env(dir),AIRPORT_BOOTSTRAP_OWNER_EMAIL:'owner@example.com'});
  const app=await listen(config);
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const a=await token('a',{email:'owner@example.com'}), b=await token('b');
  const first=await app.owner(a,'/api/account');
  assert.equal(first.status,200);
  assert.equal(first.body.account,null);
  assert.equal(first.body.signupMode,'open');
  assert.deepEqual(readdirSync(join(dir,'tenants')),[]);
  assert.equal((await app.owner(a,'/app.js')).status,200);
  assert.equal((await app.owner(a)).body.code,'account_required');
  assert.equal((await app.send(ownerHost,'/api/account/signup',{
    'cf-access-jwt-assertion':a,'content-type':'application/json','x-airport-console':'1',origin:'https://other.example'
  },{displayName:'CSRF'})).status,403);
  assert.equal((await app.send(ownerHost,'/api/account/signup',{'cf-access-jwt-assertion':a,'content-type':'application/json'},{displayName:'CSRF'})).status,403);
  const created=await app.owner(a,'/api/account/signup',{
    displayName:'  First customer  ',role:'admin',tenant:'foreign',email:'other@example.com'
  });
  assert.equal(created.status,201);
  assert.equal(created.body.account.role,'member');
  assert.equal(created.body.account.email,'owner@example.com');
  assert.equal(created.body.account.displayName,'First customer');
  assert.equal((await app.owner(a,'/api/account/signup',{displayName:'again'})).status,409);
  assert.equal((await app.owner(a,'/api/account/invitations')).status,403);
  assert.equal((await app.owner(a,'/api/account/profile',{displayName:'   '})).status,400);
  assert.equal((await app.owner(a,'/api/account/profile',{displayName:'Sam',email:'other@example.com'})).body.account.email,'owner@example.com');
  assert.equal((await app.owner(a,'/api/account')).body.account.displayName,'Sam');
  assert.equal((await app.owner(b,'/api/account')).body.account,null);
  assert.equal((await app.owner(b,'/api/account/profile',{displayName:'Jane'})).status,403);
  assert.equal((await app.owner(await token('no-email',{email:'',email_verified:true}),'/api/account')).status,401);
  assert.equal((await app.owner(await token('service',{common_name:'helper'}),'/api/account')).status,401);
  assert.equal((await app.send(agentHost,'/api/account',{'cf-access-jwt-assertion':a})).status,404);
});

test('verified legacy and bootstrap identities keep their exact tenant and invite subsequent customers into private accounts',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-customer-'));
  const old=env(dir);
  const name='legacy-subject',ownerEmail='pilot@example.com';
  const tenantFor=sub=>createHmac('sha256',Buffer.from(old.AIRPORT_TENANT_SECRET,'base64url')).update(JSON.stringify([team,sub])).digest('hex');
  const tenant=tenantFor(name),memberTenant=tenantFor('existing-member');
  const config=readHostedConfig({...old,AIRPORT_SIGNUP_MODE:'invite',AIRPORT_BOOTSTRAP_OWNER_EMAIL:ownerEmail,AIRPORT_BOOTSTRAP_OWNER_TENANT:tenant});
  mkdirSync(join(dir,'tenants'));
  const previous=createStore(join(dir,'tenants',tenant+'.sqlite3'));
  const previousGrant=previous.issueAgentGrant('personal','Pilot','forever');previous.createWorkspace('Preexisting data');previous.close();
  createStore(join(dir,'tenants',memberTenant+'.sqlite3')).close();
  let app=await listen(config);
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const owner=await token(name,{email:ownerEmail}),member=await token('existing-member');
  const wrong=await token('wrong',{email:ownerEmail});
  assert.equal((await app.owner(wrong,'/api/account')).body.account,null);
  assert.equal((await app.owner(wrong,'/api/account/signup',{displayName:'Wrong identity'})).status,409);
  assert.equal((await app.owner(owner,'/api/account')).body.account.role,'admin');
  assert.equal((await app.owner(member,'/api/account')).body.account.role,'member');
  const ownerState=(await app.owner(owner)).body;
  assert(ownerState.publicURL.endsWith('/gateway/'+tenant));
  assert(ownerState.workspaces.some(w=>w.name==='Preexisting data'));
  assert(!(await app.owner(member)).body.workspaces.some(w=>w.name==='Preexisting data'));
  assert.deepEqual(readdirSync(join(dir,'tenants')).filter(file=>file.endsWith('.sqlite3')).sort(),[tenant+'.sqlite3',memberTenant+'.sqlite3'].sort());
  assert.equal((await app.owner(member,'/api/account/invitations',{email:'member@example.com'})).status,403);
  const invite=(await app.owner(owner,'/api/account/invitations',{email:' New@Example.com '})).body;
  assert.equal(invite.invitation.email,'new@example.com');assert.equal(invite.invitation.status,'pending');
  const link=new URL(invite.inviteUrl);assert.equal(link.origin,config.ownerOrigin);assert.equal(link.pathname,'/welcome');
  const credential=new URLSearchParams(link.hash.slice(1)).get('invite');
  const visitor=await token('new',{email:'new@example.com'});
  assert.equal((await app.owner(visitor,'/api/account/signup',{displayName:'New'})).body.code,'invitation_required');
  assert.equal((await app.owner(await token('other'),'/api/account/signup',{displayName:'Other',token:credential})).body.code,'invitation_invalid');
  const claims=await Promise.all([1,2].map(()=>app.owner(visitor,'/api/account/signup',{displayName:'New',token:credential})));
  assert.deepEqual(claims.map(x=>x.status).sort(),[201,409]);
  assert.equal((await app.owner(visitor,'/api/account')).body.account.role,'member');
  assert(!(await app.owner(visitor)).body.workspaces.some(w=>w.name==='Preexisting data'));
  const history=(await app.owner(owner,'/api/account/invitations')).body;
  assert.equal(history.invitations[0].status,'accepted');
  assert(!JSON.stringify(history).includes(credential));
  assert.equal((await app.owner(owner,'/api/account/invitations',{email:'new@example.com'})).status,409);
  const revoked=(await app.owner(owner,'/api/account/invitations',{email:'revoke@example.com'})).body;
  assert.equal((await app.owner(owner,'/api/account/invitations/revoke',{id:revoked.invitation.id})).body.invitation.status,'revoked');
  const rejected=await app.owner(await token('revoke'),'/api/account/signup',{displayName:'R',token:revoked.inviteUrl.split('#invite=')[1]});
  assert.equal(rejected.body.code,'invitation_invalid');
  await app.close();
  app=await listen({...config,signupMode:'open'});
  assert.equal((await app.owner(owner,'/api/account/invitations')).body.code,'invitations_disabled');
  const path=new URL(ownerState.publicURL).pathname;
  const agentReply=await app.send(agentHost,path+'/mcp',{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+previousGrant.token},
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'Pilot',version:'1'}}});
  assert.equal(agentReply.status,200);
});

test('Airport email login preserves verified accounts, host isolation, workspace history and existing agent grants',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-native-'));
  const old=env(dir),email='pilot@example.com',subject='legacy-owner';
  const tenant=createHmac('sha256',Buffer.from(old.AIRPORT_TENANT_SECRET,'base64url'))
    .update(JSON.stringify([team,subject])).digest('hex');
  const base={...old,AIRPORT_BOOTSTRAP_OWNER_EMAIL:email,AIRPORT_BOOTSTRAP_OWNER_TENANT:tenant};
  let app=await listen(readHostedConfig(base));
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const assertion=await token(subject,{email}),member=await token('member');
  const original=(await app.owner(assertion,'/api/account')).body.account;
  const memberAccount=await app.signup(member);
  assert.equal(original.role,'admin');
  await app.owner(assertion,'/api/workspace-create',{name:'Consulting'});
  const savedGrant=await app.owner(assertion,'/api/agent-add',{workspace:'personal',name:'Old agent',lifetime:'forever'});
  assert.equal(savedGrant.status,200);
  const grant=savedGrant.body;
  const publicURL=(await app.owner(assertion)).body.publicURL;
  await app.close();

  const settings={...base,AIRPORT_AUTH_MODE:'email',CF_ACCESS_ISSUER:undefined,CF_ACCESS_AUD:undefined,
    AIRPORT_EMAIL_ACCOUNT_ID:'a'.repeat(32),AIRPORT_EMAIL_API_TOKEN:'test',AIRPORT_EMAIL_FROM:'signin@example.com'};
  assert.throws(()=>readHostedConfig({...settings,AIRPORT_EMAIL_API_TOKEN:''}),/AIRPORT_EMAIL_API_TOKEN/);
  const outbox=new Map();
  app=await listen(readHostedConfig(settings),{sendCode:async ({email,code})=>{
    if (email==='offline@example.com') throw Error('private provider details');
    outbox.set(email,code);
  }});
  const headers={origin:old.AIRPORT_OWNER_ORIGIN,'x-airport-console':'1','content-type':'application/json'};
  const post=(path,form,extra={})=>app.send(ownerHost,path,{...headers,...extra},form);
  const authenticate=async email=>{
    const started=await post('/api/auth/start',{email});
    assert.equal(started.status,200);
    assert.deepEqual(Object.keys(started.body),['challengeId']);
    const form={challengeId:started.body.challengeId,code:outbox.get(email)};
    const attempts=await Promise.all([1,2].map(()=>post('/api/auth/verify',form)));
    assert.deepEqual(attempts.map(v=>v.status).sort(),[200,401]);
    return {cookie:attempts.find(x=>x.status===200).headers['set-cookie'][0].split(';')[0]};
  };
  assert.equal((await app.send(ownerHost,'/')).headers.location,'/login');
  assert.equal((await app.owner(assertion)).status,401);
  assert.equal((await app.send(agentHost,'/api/auth/start',headers,{email})).status,404);
  assert.equal((await post('/api/auth/start',{email},{origin:'https://other.example'})).status,403);
  assert.equal((await app.send(ownerHost,'/api/auth/start',{}, {email})).status,403);
  assert.equal((await post('/api/auth/verify',{email,tenant,code:'12345678'})).status,401);
  const failure=await post('/api/auth/start',{email:'offline@example.com'});
  assert.equal(failure.status,503);assert.doesNotMatch(JSON.stringify(failure.body),/private provider/);

  const owner=await authenticate(email);
  assert.equal((await app.send(ownerHost,'/login',owner)).headers.location,'/');
  const session=(await app.send(ownerHost,'/api/account',owner)).body;
  assert.deepEqual(session.account,original);assert.equal(session.identity.accountKey,tenant);assert.equal(session.authMode,'email');
  assert((await app.send(ownerHost,'/api/state',owner)).body.workspaces.some(w=>w.name==='Consulting'));
  const signedMember=await authenticate('member@example.com');
  assert.deepEqual((await app.send(ownerHost,'/api/account',signedMember)).body.account,memberAccount);
  const newcomer=await authenticate('new@example.com');
  assert.equal((await app.send(ownerHost,'/api/account',newcomer)).body.account,null);
  assert.equal((await app.send(ownerHost,'/api/state',newcomer)).status,403);
  const created=await post('/api/account/signup',{displayName:'New',tenant,role:'admin'},newcomer);
  assert.equal(created.status,201);assert.equal(created.body.account.role,'member');
  assert.notEqual(created.body.identity.accountKey,tenant);
  assert(!(await app.send(ownerHost,'/api/state',newcomer)).body.workspaces.some(w=>w.name==='Consulting'));

  const rpc={jsonrpc:'2.0',id:1,method:'tools/list',params:{}};
  const endpoint=new URL(publicURL).pathname+'/mcp';
  assert.equal((await app.send(agentHost,endpoint,{'content-type':'application/json',...owner},rpc)).status,401);
  assert.equal((await app.send(agentHost,endpoint,{'content-type':'application/json',authorization:'Bearer '+grant.token},rpc)).status,200);
  assert.equal((await post('/api/auth/logout',{},{...owner,origin:'https://foreign.example'})).status,403);
  assert.equal((await post('/api/auth/logout',{},owner)).status,200);
  assert.equal((await app.send(ownerHost,'/api/state',owner)).status,401);
  assert.equal((await app.send(ownerHost,'/api/state',newcomer)).status,200);
  const login=await app.send(ownerHost,'/login');
  assert.equal(login.status,200);
  assert.match(login.headers['content-security-policy'],/connect-src 'self'/);
});
