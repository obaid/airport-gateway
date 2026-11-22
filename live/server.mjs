import http from 'node:http';
import { writeFile, mkdir, chmod, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import {watchFile,unwatchFile} from 'node:fs';
import {localPlatformKey} from './platform-key.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createStore, fail, same, secret } from './store.mjs';
import { createComposio } from './composio.mjs';
import { createCatalog, parseProjectAuthConfigs } from './catalog.mjs';
import { createOwnerHandler } from './owner.mjs';
import { createToolRunner, makeAgentHandler } from './agent.mjs';

process.umask(0o077);
const stateDir = process.env.AIRPORT_DATA_DIR || path.join(homedir(),'Library','Application Support','Airport','live');
await mkdir(stateDir,{recursive:true,mode:0o700});
await chmod(stateDir,0o700);
const store=createStore(path.join(stateDir,'gateway.sqlite3'),{recoverOnOpen:false});
const ownerPort=Number(process.env.AIRPORT_OWNER_PORT || 43870), agentPort=Number(process.env.AIRPORT_AGENT_PORT || 43871);
const ownerOrigin='http://127.0.0.1:'+ownerPort;
const sessionCookie='airport_owner_'+ownerPort;
const concurrentGateway=process.env.AIRPORT_CONCURRENT_GATEWAY==='1';
const bootFile=path.join(stateDir,concurrentGateway && ownerPort!==43870?'launcher-'+ownerPort+'.json':'launcher.json');
let ticket=secret(), ownerSession=secret(),publicURL=process.env.AIRPORT_PUBLIC_URL || '',tunnel;
const authConfigs=parseProjectAuthConfigs(process.env.AIRPORT_AUTH_CONFIGS_JSON);
const gmailConfig=authConfigs.gmail || process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID?.trim();
const revisionFile=path.join(stateDir,'platform.env');
let provider=null,catalog=null;
async function loadPlatformCredential() {
  const key=await localPlatformKey(stateDir);
  if(!key)return;
  const next=createComposio(key,gmailConfig);
  const nextCatalog=createCatalog(key,{authConfigs,pilotGmailConfig:gmailConfig});
  provider=next;catalog=nextCatalog;
}
await loadPlatformCredential();

async function saveLauncher() {
  const tmp=bootFile+'.tmp';
  await writeFile(tmp,JSON.stringify({origin:ownerOrigin,ticket,pid:process.pid}),{mode:0o600});
  await rename(tmp,bootFile);
}
function requireOwner(req) {
  const cookie=(req.headers.cookie||'').split(';').map(t=>t.trim()).find(t=>t.startsWith(sessionCookie+'='));
  if(!cookie||!same(cookie.slice(sessionCookie.length+1),ownerSession))fail('Open Airport from this Mac’s local launcher.',401);
}
async function establishSession({ticket:attempt}) {
  if(!same(attempt,ticket))fail('Use the current ticket from the local launcher.',403);
  ticket=secret();await saveLauncher();
  return {'Set-Cookie':sessionCookie+'='+ownerSession+'; Path=/; HttpOnly; SameSite=Strict'};
}
const getProvider=()=>provider,getCatalog=()=>catalog;
export const run=createToolRunner({store,getProvider,getCatalog});
const owner=createOwnerHandler({store,requireOwner,ownerOrigin,publicBase:()=>publicURL,
  localMcpURL:'http://127.0.0.1:'+agentPort+'/mcp',getProvider,getCatalog,establishSession});
const ownerServer=http.createServer(owner);
const agentServer=http.createServer(makeAgentHandler({store,run,publicURL:()=>publicURL}));
function listen(server,port){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}
await listen(ownerServer,ownerPort);await listen(agentServer,agentPort);
if(!concurrentGateway)store.recover();
await saveLauncher();
if(!process.env.COMPOSIO_API_KEY)watchFile(revisionFile,{interval:1500,persistent:false},(next,prior)=>{
  if(next.mtimeMs && next.mtimeMs!==prior.mtimeMs)loadPlatformCredential().catch(()=>console.error('Airport could not reload its platform credential.'));
});
console.log('Airport owner console listening on '+ownerOrigin+'. Open it with node live/open.mjs.');
if(!publicURL&&!process.env.AIRPORT_NO_TUNNEL){
  tunnel=spawn('cloudflared',['tunnel','--no-autoupdate','--url','http://127.0.0.1:'+agentPort],{stdio:['ignore','ignore','pipe']});
  let logTail='';
  tunnel.stderr.on('data',chunk=>{
    logTail=(logTail+chunk.toString()).slice(-4096);
    const match=logTail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
    if(match&&!publicURL){publicURL=match[0];console.log('Public agent endpoint ready at '+publicURL+'/mcp');}
  });
  tunnel.on('error',()=>{publicURL='';console.error('Could not start cloudflared. Install it or set AIRPORT_PUBLIC_URL.');});
  tunnel.on('exit',()=>{publicURL='';console.log('The agent tunnel is offline.');});
}
let stopping=false;
function stop(){if(stopping)return;stopping=true;unwatchFile(revisionFile);tunnel?.kill();ownerServer.close();agentServer.close();setTimeout(()=>process.exit(0),300).unref();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
