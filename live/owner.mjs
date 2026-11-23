import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import agentIcons from '../dist/agent-icons.js';
import {fail} from './store.mjs';
import {createCatalogActions} from './owner-catalog.mjs';
import {createToolRunner} from './agent.mjs';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"};
const publicBrandAssets = new Map(['bricolage-latin','public-sans-regular','public-sans-semibold'].map(name=>
  ['/assets/'+name+'.woff2', ['../dist/'+name+'.woff2','font/woff2']]
));
publicBrandAssets.set('/assets/access-airfield.svg',['ui/access-airfield.svg','image/svg+xml']);
const assets=new Map([
  ...publicBrandAssets,
  ['/', ['ui/index.html','text/html; charset=utf-8']],
  ['/app.js', [['../dist/discovery-data.js','../dist/overview.js','ui/integrations.js','ui/connection-pages.js','ui/registries.js','ui/account.js','ui/onboarding.js','ui/workspace.js'],'text/javascript']],
  ['/style.css', [['../dist/style.css','ui/workspace.css','ui/integrations.css','ui/connection-pages.css','ui/registries.css','ui/account.css','ui/access.css','ui/console-theme.css','ui/control-theme.css','ui/overview-theme.css','ui/onboarding.css'],'text/css']],
  ['/assets/agent-icons.js',['../dist/agent-icons.js','text/javascript']],
  ['/assets/agent-icons.css',['../dist/agent-icons.css','text/css']],
  ...agentIcons.catalog.map(({key})=>['/assets/agents/'+key+'.png',['../dist/agents/'+key+'.png','image/png']]),
  ['/assets/icons.js',['../dist/icons.js','text/javascript']],['/assets/public.ttf',['../dist/public.ttf','font/ttf']],
  ['/assets/public-semibold.ttf',['../dist/public-semibold.ttf','font/ttf']],['/assets/plex.ttf',['../dist/plex.ttf','font/ttf']],
  ['/favicon.svg',['../dist/favicon.svg','image/svg+xml']],['/assets/favicon.svg',['../dist/favicon.svg','image/svg+xml']]
]);
function json(res,status,data,extras={}) {res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8',...extras});res.end(JSON.stringify(data));}
export function connectionHomeURL(workspace,id,status) {
  const tab=status==='active'?'tools':'settings';
  return '/w/'+encodeURIComponent(workspace)+'/connections/'+encodeURIComponent(id)+'/'+tab;
}
export function isConsolePage(pathname) {
  const path=pathname.replace(/\/$/,'');
  if(path==='/account')return true;
  // Public directory links open the app's detail page after the owner signs in.
  if(/^\/integrations\/[a-z0-9][a-z0-9_-]{0,255}$/.test(path))return true;
  const match=/^\/w\/[\w-]+(?:\/(.+))?$/.exec(path);
  if(!match)return false;
  const page=match[1]||'overview';
  if(page==='overview'||page==='setup')return true;
  if(/^(?:agents|integrations|policies|activity)(?:\/[\w-]+)?$/.test(page))return true;
  return /^connections(?:\/[\w-]+(?:\/(?:settings|activity|tools(?:\/advanced)?))?)?$/.test(page);
}
export function serveBrandAsset(req,res,pathname) {
  return publicBrandAssets.has(pathname) && serveOwnerAsset(req,res,pathname);
}
export async function serveOwnerAsset(req,res,pathname) {
  const spec=assets.get(pathname);
  if(!spec || !['GET','HEAD'].includes(req.method))return false;
  const [file,type]=spec;
  const data=Array.isArray(file)
    ? (await Promise.all(file.map(part=>readFile(path.join(appRoot,part),'utf8')))).join('\n')
    : await readFile(path.join(appRoot,file));
  res.writeHead(200,{...headers,'Content-Type':type});
  res.end(req.method==='HEAD' ? undefined : data);
  return true;
}
export async function body(req,ownerOrigin) {
  if(req.headers.origin && req.headers.origin!==ownerOrigin)fail('Use the Airport owner console.',403);
  if(req.headers['x-airport-console']!=='1'||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail('Use the Airport owner console.',403);
  const chunks=[];let n=0;
  for await(const chunk of req){n+=chunk.length;if(n>8192)fail('Request too large.',413);chunks.push(chunk);}
  try {const data=JSON.parse(Buffer.concat(chunks).toString());if(!data||Array.isArray(data)||typeof data!=='object')throw Error();return data;}
  catch {fail('Expected a JSON object.');}
}
function assertEmail(value) {
  if(typeof value!=='string'||value.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(value.trim()))fail('Enter the email address of the Google account you intend to connect.');
  return value.trim().toLowerCase();
}

export function createOwnerHandler({store,requireOwner,ownerOrigin,publicBase,localMcpURL='',getProvider,getCatalog,establishSession}) {
  const actions=createCatalogActions({store,getCatalog,callbackURL:ownerOrigin+'/oauth/done'});
  const run=createToolRunner({store,getProvider,getCatalog});
  const service=()=>getProvider() || fail('App connections are awaiting Airport platform setup.',503);
  const toolCounts='gmail_inbox_counts',toolSend='gmail_send_email';
  return async function owner(req,res) {
    try {
      if(req.headers.host!==new URL(ownerOrigin).host)fail('Invalid host.',403);
      const u=new URL(req.url,ownerOrigin),p=u.pathname;
      const publicURL=typeof publicBase==='function'?publicBase():publicBase;
      if(await serveOwnerAsset(req,res,p))return;
      if(p==='/oauth/done'&&req.method==='GET'){
        let location='/';
        const workspace=u.searchParams.get('workspace'),connectionId=u.searchParams.get('connection');
        if(workspace && connectionId){
          try {
            await requireOwner(req);
            if(connectionId==='pilot-gmail'){
              location=connectionHomeURL(workspace,connectionId,store.get(workspace).status);
            }else{
              // Use the saved account to check consent. Read the stored status even
              // on a transient provider error so a pending sign-in can resume.
              try { await actions.get('connection-check')({workspace,connectionId,pendingOnly:true}); }
              catch { /* The console will retry a pending connection. */ }
              const c=store.getConnection(workspace,connectionId);
              location=connectionHomeURL(c.workspace,c.id,c.status);
            }
          } catch(error){
            // Local launcher cookies can be absent on a cross-site navigation.
            // A missing session or a connection from another tenant just returns home.
            if(error.status!==401 && error.status!==404)throw error;
          }
        }
        res.writeHead(303,{...headers,Location:location});return res.end();
      }
      if(establishSession && p==='/api/session'&&req.method==='POST'){
        const b=await body(req,ownerOrigin);
        return json(res,200,{ok:true},await establishSession(b));
      }
      await requireOwner(req);
      if(isConsolePage(p) && await serveOwnerAsset(req,res,'/'))return;
      if(req.method==='GET'&&p==='/api/state')return json(res,200,{ready:!!getProvider(),providerManaged:true,publicURL,localMcpURL,catalogVersion:1,...store.state()});
      if(req.method!=='POST')fail('Unknown route.',404);
      const b=await body(req,ownerOrigin);
      if(p==='/api/key')fail('Your Airport administrator manages the Composio project.',403);
      if(p==='/api/approve-invite'){
        if(typeof b.id!=='string'||!/^\d{6}$/.test(b.code))fail('Enter the six digits shown by Muse.');
        store.approve(b.id,b.code);return json(res,200,{ok:true});
      }
      const catalogAction=actions.get(p.slice('/api/'.length));
      if(p.startsWith('/api/')&&catalogAction)return json(res,200,await catalogAction(b));
      if(typeof b.workspace!=='string')fail('Choose a workspace.');
      store.get(b.workspace);
      const ws=b.workspace;
      switch(p) {
        case '/api/connect': {
          const api=service(),email=assertEmail(b.expectedEmail),op=store.begin(ws,email);
          const callback=ownerOrigin+'/oauth/done?workspace='+encodeURIComponent(ws)+'&connection=pilot-gmail';
          try { const result=await api.start(op.owner,callback);store.attach(ws,op.attempt,result.connectionId);return json(res,200,{url:result.url}); }
          catch(e){store.cancel(ws,op.attempt);throw e;}
        }
        case '/api/check': {
          const row=store.get(ws);
          if(row.status==='active')return json(res,200,{ok:true,status:'active'});
          if(!row.account||row.status!=='pending')fail('Start the Gmail connection in this workspace first.',409);
          const result=await service().verify(row.owner,row.account);
          if(result.active){
            if(!store.activate(ws,row.attempt,result.email))fail('Google authorized a different address. Reconnect using the expected account.',409);
          } else if(['FAILED','REVOKED','DISABLED','EXPIRED'].includes(result.status)){
            store.cancel(ws,row.attempt);fail('The Google authorization expired or was declined. Start a new connection.',409);
          }
          return json(res,200,{ok:true,status:store.get(ws).status});
        }
        case '/api/policy':store.setPolicy(ws,b.policy,b.connectionId);return json(res,200,{ok:true});
        case '/api/disconnect':store.disconnect(ws);return json(res,200,{ok:true});
        case '/api/connector-grant':return json(res,200,store.issueConnectorGrant(ws));
        case '/api/invite':{
          if(!publicURL)fail('The HTTPS agent endpoint is starting. Try again shortly.',409);
          const {invite,expiresAt}=store.issue(ws,b.replace);
          const prompt=[
            'Set up a saved Custom Connector in Muse for my Airport '+store.get(ws).name+' workspace. Use this connector for the inbox count test.',
            'The public API setup guide is '+publicURL+'/airport/connect. If the connector supports remote MCP, its endpoint is '+publicURL+'/mcp. Ask me for any authorization the connector requires.',
            'Use the HTTPS pairing API: POST JSON {"invite":"'+invite+'"} to '+publicURL+'/pair/start. Show me the six-digit code and keep pairId and receipt private. I will approve the matching code in Airport.',
            'Poll POST /pair/token with pairId and receipt as documented. Save the returned short-lived Bearer credential in your connector secret store and never print it in chat.',
            'After pairing, request gmail_inbox_counts through the saved connector. For a custom HTTP connector, use the documented authenticated counts endpoint. Report the total and unread counts only. If connector setup or the request is blocked, stop and show me the authorization step or error.'
          ].join('\n\n');
          return json(res,200,{prompt,expiresAt});
        }
        case '/api/revoke':store.revoke(ws);return json(res,200,{ok:true});
        case '/api/test':
          if(![toolCounts,toolSend].includes(b.tool))fail('Unknown test tool.');
          return json(res,200,await run({workspace:ws,actor:'Owner console'},b.tool));
        default:fail('Unknown route.',404);
      }
    } catch(e) {if(!res.headersSent)json(res,e.status||502,{error:e.message||'The request failed.'});else res.end();}
  };
}
