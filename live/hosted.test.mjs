import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
  CF_ACCESS_ISSUER:team,CF_ACCESS_AUD:audience,COMPOSIO_API_KEY:'synthetic-project-key'
});

function token(sub,claims={},privateKey=signing.privateKey) {
  const now = Math.floor(Date.now()/1000);
  return new SignJWT({type:'app',iss:team,aud:[audience],iat:now,exp:now+1200,sub,...claims})
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
  function send(host,path,headers={},data) {
    return new Promise((resolve,reject) => {
      const req = request({hostname:'127.0.0.1',port,path,method:data === undefined ? 'GET':'POST',headers:{host,...headers}},res=>{
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
  return {send,owner,close};
}

test('owner access verifies the signature, issuer, audience, application-token type, subject and time before opening any SQLite file',async t=>{
  const dir = mkdtempSync(join(tmpdir(),'airport-access-'));
  const app = await listen(readHostedConfig(env(dir)));
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const otherKey = (await generateKeyPair('RS256')).privateKey;
  const wrong = [
    await token('owner',{iss:'https://other.cloudflareaccess.com'}),await token('owner',{aud:'different-app'}),
    await token('owner',{type:'org'}),await token('',{common_name:'a service token'}),await token('owner',{exp:1}),
    await token('owner',{nbf:Math.floor(Date.now()/1000)+90}),await token('owner',{},otherKey),'unsigned.claims.test'
  ];
  for (const assertion of wrong) assert.equal((await app.owner(assertion)).status,401);
  for (const path of ['/','/api/state','/assets/icons.js','/oauth/done']) {
    assert.equal((await app.send(ownerHost,path,{'cf-access-authenticated-user-email':'pretend@example.com'})).status,401);
  }
  assert.deepEqual(readdirSync(join(dir,'tenants')),[]);
  assert.equal((await app.owner(await token('owner'))).status,200);
});

test('owners retain isolated state across restarts and bearer-only data reads bind to one existing tenant',async t=>{
  const dir = mkdtempSync(join(tmpdir(),'airport-hosted-'));
  const config = readHostedConfig(env(dir));
  let app = await listen(config);
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const a = await token('owner-a'), b = await token('owner-b');
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
    ['AIRPORT_COMPOSIO_VERIFIER_PATH','/oauth/done'],['AIRPORT_COMPOSIO_VERIFIER_PATH','/api/state']
  ]) assert.throws(()=>readHostedConfig({...base,[name]:value}));
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
  const route='/oauth/verify?session_uri=';
  assert.equal((await app.send(ownerHost,route+'right')).status,401);
  assert.equal((await app.owner(b,route+'right')).status,409);
  assert.equal(readdirSync(join(dir,'tenants')).length,0);
  assert.equal((await app.owner(a,'/api/connection-add',{workspace:'work',toolkit:'github'})).status,200);
  assert.equal((await app.owner(b,route+'right')).status,409);
  assert.equal((await app.owner(a,route+'right&user_id=other')).status,400);
  assert.deepEqual(calls,[]);
  assert.equal((await app.owner(a,route+'other')).status,409);
  assert.equal((await app.owner(a)).body.connections[0].status,'pending');
  const verified=await app.owner(a,route+'right');
  assert.equal(verified.status,303);
  assert.equal(verified.headers.location,'/');
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
  await app.owner(a,'/api/connect',{workspace:'work',expectedEmail:'work@example.com'});
  await app.owner(a,'/api/connect',{workspace:'personal',expectedEmail:'personal@example.com'});
  assert.equal((await app.owner(a,route)).status,409);
  assert.equal(consumed,0);
  await app.owner(b,'/api/connect',{workspace:'work',expectedEmail:'work@example.com'});
  assert.equal((await app.owner(b,route)).status,303);
  assert.equal(consumed,1);
  assert.equal((await app.owner(b)).body.workspaces.find(w=>w.id==='work').status,'active');
});
