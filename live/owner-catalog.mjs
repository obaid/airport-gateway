import {readFileSync} from 'node:fs';
import {classifyTool,createAccessActions} from './access-presets.mjs';
import {internalToolkit} from './catalog.mjs';
import {catalogToolRestriction,fail} from './store.mjs';

// This published directory lets owners explore before adding a Composio project key.
// Connected projects use Composio's paginated API as the source for permissions and execution.
const directory = JSON.parse(readFileSync(new URL('../dist/toolkits.json',import.meta.url),'utf8'));
const popular = ['gmail','googledrive','googlecalendar','slack','github','notion','linear','outlook','dropbox','asana'];
const rank = new Map(popular.map((slug,index)=>[slug,index]));
const sorted = [...directory].sort((a,b)=>(rank.get(a[0])??100)-(rank.get(b[0])??100) || a[1].localeCompare(b[1]));
const optionalString = (value,max,title) => {
  if(value==null || value==='')return undefined;
  if(typeof value!=='string' || value.length>max || /[\u0000-\u001f]/.test(value))fail('Invalid '+title+'.');
  return value.trim() || undefined;
};
function paging(body) {
  return {search:optionalString(body.search,200,'search term'),cursor:optionalString(body.cursor,4096,'page cursor')};
}
function browseDirectory({search='',cursor='0'}) {
  if(!/^\d{1,6}$/.test(cursor))fail('Invalid directory page.');
  const q=search.toLowerCase(),start=Number(cursor);
  const matches=q?sorted.filter(([slug,name])=>(name+' '+slug).toLowerCase().includes(q)):sorted;
  const items=matches.slice(start,start+36).map(([slug,name,toolCount,auth,managed])=>({
    slug,name,toolsCount:toolCount,toolCount,authSchemes:auth.split(', '),requiresAuth:auth!=='NO_AUTH',managedAuth:managed==='Yes',
    description:'',docsURL:'https://docs.composio.dev/toolkits/'+encodeURIComponent(slug)
  }));
  return {items,nextCursor:start+items.length<matches.length?String(start+items.length):null,total:matches.length,source:'directory'};
}

export function createCatalogActions({store,getCatalog,callbackURL}) {
  const provider=()=>getCatalog() || fail('Airport’s app connections are awaiting platform setup. Contact your Airport administrator.',503);
  const checks=new Map();
  function ws(body){store.get(body.workspace);return body.workspace;}
  function conn(body){return store.getConnection(ws(body),body.connectionId);}
  async function listTools(b) {
    const connection=conn(b);
    const result=await provider().listTools({...paging(b),toolkit:connection.toolkit});
    const enabled=new Map(store.listToolPolicies(b.workspace,connection.id).map(t=>[t.slug,t]));
    return {...result,items:result.items.filter(t=>t.toolkit===connection.toolkit).map(t=>{
      const pinned=enabled.get(t.slug);
      return {...t,allowed:pinned?.version===t.version && Boolean(pinned?.allowed || pinned?.enabled),approvedVersion:pinned?.version,
        presetClass:classifyTool(t),unsupportedReason:catalogToolRestriction(t)};
    })};
  }
  async function add(b) {
    const workspace=ws(b),catalog=provider();
    if(typeof b.toolkit!=='string'||!/^[_a-z0-9][a-z0-9_-]{0,255}$/.test(b.toolkit)||internalToolkit(b.toolkit))fail('Choose an available app from the catalog.');
    const label=optionalString(b.label,100,'connection name') || b.toolkit;
    if(Object.hasOwn(b,'authConfigId'))fail('Airport manages app sign-in configurations.',403);
    const c=store.createConnection(workspace,{toolkit:b.toolkit,label});
    try {
      const returnURL=new URL(callbackURL);
      returnURL.searchParams.set('workspace',workspace);
      returnURL.searchParams.set('connection',c.id);
      const linked=await catalog.start({owner:c.owner,toolkit:c.toolkit,callbackURL:returnURL.href});
      store.attachConnection(workspace,c.id,linked.accountId);
      if(!linked.url){
        const verified=await catalog.verify({owner:c.owner,accountId:linked.accountId,toolkit:c.toolkit});
        if(!verified.active)fail('This connection has not been verified.',409);
        store.activateConnection(workspace,c.id,linked.accountId);
      }
      return {connectionId:c.id,url:linked.url,status:linked.url?'pending':'active'};
    }catch(err){store.disableConnection(workspace,c.id);throw err;}
  }
  async function verifyConnection(c) {
    const {active,status}=await provider().verify({owner:c.owner,toolkit:c.toolkit,accountId:c.accountId,authConfigId:c.authConfigId});
    const current=store.getConnection(c.workspace,c.id);
    if(current.status===c.status && current.accountId===c.accountId){
      if(active && c.status==='pending')store.activateConnection(c.workspace,c.id,c.accountId);
      if(!active && (c.status==='active'||['FAILED','DISABLED','EXPIRED','REVOKED'].includes(status)))store.disableConnection(c.workspace,c.id);
    }
    return {status:store.getConnection(c.workspace,c.id).status};
  }
  function check(b) {
    const c=conn(b);
    if(c.pilot)fail('Manage this Gmail sign-in from its Gmail settings.',409);
    if(b.pendingOnly===true && (c.status!=='pending' || !c.accountId))return {status:c.status};
    if(c.status==='disabled')fail('This connection has been disconnected.',409);
    // The provider return and the original console can arrive together.
    if(!checks.has(c.id))checks.set(c.id,verifyConnection(c).finally(()=>checks.delete(c.id)));
    return checks.get(c.id);
  }
  async function access(b) {
    const c=conn(b);
    if(typeof b.allow!=='boolean' || typeof b.slug!=='string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,255}$/.test(b.slug))fail('Select a valid tool and policy.');
    if(!b.allow){store.blockTool(b.workspace,c.id,b.slug);return {ok:true};}
    const tool=await provider().getTool(b.slug);
    if(tool.slug!==b.slug || tool.toolkit!==c.toolkit)fail('The tool belongs to another connection.',409);
    if(b.version && b.version!==tool.version)fail('The tool changed. Refresh its permissions before allowing it.',409);
    const restriction=catalogToolRestriction(tool);
    if(restriction)fail(restriction,403);
    store.setToolPolicy(b.workspace,c.id,tool,true,c.accessRevision);
    return {ok:true};
  }
  return new Map(Object.entries({
    ...createAccessActions(store,provider),
    'workspace-create':b=>({workspace:store.createWorkspace(b.name)}),
    catalog:async b=>{ws(b); const page=paging(b);const p=getCatalog();return p?{...await p.listToolkits({...page,connectableOnly:true}),source:'live'}:browseDirectory(page);},
    'connection-add':add,'connection-check':check,'connection-tools':listTools,'tool-access':access,
    'connection-remove':b=>{const c=conn(b);store.disableConnection(b.workspace,c.id);return {ok:true};},
    'agent-add':b=>store.issueAgentGrant(ws(b),b.name,b.lifetime,b.clientType),
    'agent-invite':b=>store.issueAgentInvitation(ws(b),b.name,b.lifetime,b.clientType),
    'agent-invite-remove':b=>{store.revokeAgentInvitation(ws(b),b.id);return {ok:true};},
    'agent-remove':b=>{store.revokeAgentGrant(ws(b),b.id);return {ok:true};}
  }));
}
