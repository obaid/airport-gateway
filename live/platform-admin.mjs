import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import agentIcons from '../dist/agent-icons.js';

const days=30;
const dayMs=86_400_000;
const families=new Map(agentIcons.catalog.map(({key,label})=>[key,label]));
const brands=new Map(Object.entries({
  gmail:'Gmail',github:'GitHub',notion:'Notion',googledrive:'Google Drive',googlesheets:'Google Sheets',
  googlecalendar:'Google Calendar',slack:'Slack',outlook:'Outlook',linkedin:'LinkedIn',twitter:'X',
  youtube:'YouTube',instagram:'Instagram',linear:'Linear',supabase:'Supabase',airtable:'Airtable'
}));

function family(clientType,actor) {
  if(clientType&&clientType!=='auto')return families.has(clientType)?clientType:'other';
  return agentIcons.identify(actor)||'other';
}
function title(slug) {
  return slug.replace(/[-_]+/g,' ').toLowerCase().replace(/^\w/,letter=>letter.toUpperCase());
}
function add(counts,key,value) {
  if(value)counts.set(key,(counts.get(key)||0)+value);
}
function ranked(counts,format) {
  return [...counts].map(([key,count])=>({key,count,label:format(key)}))
    .sort((a,b)=>b.count-a.count||a.key.localeCompare(b.key)).slice(0,10);
}
function sourceTable(db,name) {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
}
function hasColumn(db,table,name) {
  return Boolean(db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name=?').get(table,name));
}
function readTenant(db,report,end) {
  const {totals,integrations,agents,callsByAgent,toolCalls,toolLabels}=report;
  totals.workspaces+=db.prepare('SELECT count(*) AS n FROM workspaces').get().n;
  const pilot=db.prepare("SELECT count(*) AS n FROM workspaces WHERE status='active' AND account IS NOT NULL AND email IS NOT NULL").get().n;
  add(integrations,'gmail',pilot);
  if(sourceTable(db,'catalog_connections')){
    const nonPilot=hasColumn(db,'catalog_connections','pilot')?' AND pilot=0':'';
    const rows=db.prepare("SELECT toolkit,count(*) AS n FROM catalog_connections WHERE status='active'"+nonPilot+' GROUP BY toolkit').all();
    for(const {toolkit,n} of rows)add(integrations,/^[a-z0-9_][a-z0-9_-]{0,255}$/i.test(toolkit)?toolkit.toLowerCase():'other',n);
  }
  db.function('bot_family',{deterministic:true},family);
  const legacy=db.prepare('SELECT count(*) AS n FROM workspaces WHERE grantId IS NOT NULL AND bearerHash IS NOT NULL AND grantExpires>?').get(end).n;
  add(agents,'muse',legacy);
  if(sourceTable(db,'workspace_agents')){
    const type=hasColumn(db,'workspace_agents','clientType')?'clientType':'NULL';
    const rows=db.prepare(`SELECT bot_family(${type},actor) AS bot,count(*) AS n FROM workspace_agents WHERE expires>? GROUP BY bot`).all(end);
    for(const {bot,n} of rows)add(agents,bot,n);
  }
  // Early audit records lack transport attribution and cannot distinguish agent calls from owner tests.
  if(!sourceTable(db,'request_exchanges')||!sourceTable(db,'requests'))return;
  const clients=sourceTable(db,'request_agent_clients');
  const rows=db.prepare(`SELECT bot_family(${clients?'a.clientType':'NULL'},r.actor) AS bot,
    CASE WHEN r.tool='gmail_inbox_counts' THEN 'gmail_inbox_counts' ELSE json_extract(x.request_json,'$.operation.slug') END AS operation,
    CASE WHEN r.tool='gmail_inbox_counts' THEN 'gmail' ELSE json_extract(x.request_json,'$.connection.toolkit') END AS toolkit,
    count(*) AS n
    FROM requests r JOIN request_exchanges x ON x.request_id=r.id
    ${clients?'LEFT JOIN request_agent_clients a ON a.request_id=r.id':''}
    WHERE r.at BETWEEN ? AND ? AND r.outcome='Allowed' AND r.providerCalled=1
      AND x.channel IN ('mcp','http') AND r.actor!='Owner console'
    GROUP BY bot,operation,toolkit`).all(end-days*dayMs,end);
  for(const {bot,operation,toolkit,n} of rows){
    let key='other',label='Other tools';
    if(operation==='gmail_inbox_counts'){
      key='gmail_inbox_counts';label='Gmail · Inbox counts';
    }else if(typeof toolkit==='string'&&typeof operation==='string'&&/^[a-z0-9_-]{1,255}$/i.test(toolkit)&&
      /^[A-Z0-9_][A-Z0-9_-]{0,255}$/i.test(operation)&&operation.toUpperCase().startsWith(toolkit.toUpperCase()+'_')){
      key=operation.toUpperCase();
      label=(brands.get(toolkit.toLowerCase())||title(toolkit))+' · '+title(operation.slice(toolkit.length+1));
    }
    add(callsByAgent,bot,n);add(toolCalls,key,n);toolLabels.set(key,label);
    totals.successfulToolCalls+=n;
  }
}

export function readPlatformOverview(tenantDir,users,end=Date.now()) {
  const totals={users,workspaces:0,connections:0,agents:0,successfulToolCalls:0};
  const integrations=new Map(),agents=new Map(),callsByAgent=new Map(),toolCalls=new Map(),toolLabels=new Map();
  const report={totals,integrations,agents,callsByAgent,toolCalls,toolLabels};
  for(const file of readdirSync(tenantDir,{withFileTypes:true})){
    if(!file.isFile()||!/^[0-9a-f]{64}\.sqlite3$/.test(file.name))continue;
    const db=new DatabaseSync(join(tenantDir,file.name),{readOnly:true});
    try{
      db.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON; BEGIN');
      readTenant(db,report,end);
    }finally{db.close();}
  }
  for(const n of integrations.values())totals.connections+=n;
  for(const n of agents.values())totals.agents+=n;
  const bots=[...new Set([...agents.keys(),...callsByAgent.keys()])].map(key=>({
    key,label:families.get(key)||'Other agents',count:callsByAgent.get(key)||0,activeAgents:agents.get(key)||0
  })).sort((a,b)=>b.count-a.count||b.activeAgents-a.activeAgents||a.key.localeCompare(b.key));
  const asOf=new Date(end).toISOString();
  return {asOf,window:{days,start:new Date(end-days*dayMs).toISOString(),end:asOf},totals,
    integrations:ranked(integrations,key=>brands.get(key)||(key==='other'?'Other integrations':title(key))),
    bots,tools:ranked(toolCalls,key=>toolLabels.get(key))};
}

if(!isMainThread&&workerData?.task==='airport-platform-overview'){
  parentPort.postMessage(readPlatformOverview(workerData.dir,workerData.users));
}

// Run the cross-tenant scan outside the HTTP event loop. Concurrent requests share one snapshot.
export function createPlatformOverview(dir,countUsers) {
  let inFlight;
  return ()=>{
    if(!inFlight)inFlight=new Promise((resolve,reject)=>{
      const worker=new Worker(new URL(import.meta.url),{workerData:{task:'airport-platform-overview',dir,users:countUsers()}});
      worker.once('message',resolve);
      worker.once('error',reject);
      worker.once('exit',code=>{if(code!==0)reject(new Error('Platform overview unavailable.'));});
    }).finally(()=>{inFlight=null;});
    return inFlight;
  };
}
