import { DatabaseSync } from 'node:sqlite';
import { createEnrollment } from './enrollment.mjs';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

export const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
export const same = (a,b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
export function fail(message, status = 400) { throw Object.assign(new Error(message), {status}); }
const now = () => Date.now();
const iso = ms => new Date(ms).toISOString();
const ttl = 10 * 60 * 1000;
const agentDurations = new Map([['12h',12*3600_000],['7d',7*86400_000],['30d',30*86400_000],['forever',null]]);
// Older concurrent readers require a non-null timestamp they can compare and format as a Date.
const neverExpires = 8_640_000_000_000_000;
const activeAgent = `(expires=${neverExpires} OR expires>?)`;
const agentExpiresAt = expires => expires===neverExpires ? null : iso(expires);

const slugPattern = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,255}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function label(value, fallback) {
  const input=value ?? fallback;
  if(typeof input!=='string') fail('Enter a name.');
  const name=input.trim();
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) fail('Enter a name between 1 and 100 characters.');
  return name;
}

// Inspect provider-owned metadata before offering an operation for approval. An
// open-ended executor would make the per-tool boundary meaningless.
export function catalogToolRestriction(tool) {
  if (!tool || typeof tool.slug!=='string' || typeof tool.toolkit!=='string' || !slugPattern.test(tool.slug) || !slugPattern.test(tool.toolkit)) return 'A toolkit and operation identifier are required.';
  if (typeof tool.version!=='string' || !versionPattern.test(tool.version) || /^(latest|stable|current|default|auto|head|main|master)$/i.test(tool.version)) return 'A concrete provider version is required.';
  if (!record(tool.inputSchema) || tool.inputSchema.type !== 'object') return 'A named-argument schema is required.';
  const toolkit = tool.toolkit.toUpperCase().replace(/[-_]/g,'');
  const slug = tool.slug.toUpperCase().replace(/-/g,'_');
  const text = [tool.name,tool.description].filter(v=>typeof v==='string').join(' ');
  const operation=slug.startsWith(tool.toolkit.toUpperCase()+'_')?slug.slice(tool.toolkit.length+1):slug;
  const metadataRead=/^(?:GET|LIST|CHECK|DESCRIBE|RETRIEVE)_(?:API_|TOOLKIT_|TOOL_|SERVICE_|CONNECTION_|ACCOUNT_)?(?:VERSIONS?|STATUS|CAPABILITIES|REGIONS?|LANGUAGES|MODELS|TIMEZONES?|METADATA|LIMITS|USAGE|HEALTH|PROFILE|ACTIONS|TOOLS|INTEGRATIONS|SESSIONS?|WORKSPACES?|PROJECTS?|ENVIRONMENTS?|FOLDERS?|FILES|LOGS)$/.test(operation);
  if ((!metadataRead && /^(?:COMPOSIO(?:TOOLS?|SEARCH|MANAGE|ROUTER)?|TOOLROUTER|CODEINTERPRETER|CODEEXECUTION|E2B|BROWSER(?:BASE|LESS|USE|TOOL)?|PIPEDREAM|ZAPIER|N8N|HTTP|SSH|SHELL|SQL|CUSTOMTOOLS?|OPENAPI|GRAPHQL|METASPLOIT|SHODAN|CENSYS|SQLMAP|NUCLEI|KALI)$/.test(toolkit))
    || (!metadataRead && /(?:^|_)(?:PROXY|GRAPHQL|SQL|SHELL|TERMINAL|POWERSHELL|SSH|EVAL|WEBHOOK|PENTEST|EXPLOIT|PORT_SCAN|VULNERABILITY_SCAN)(?:_|$)/.test(operation))
    || /(?:^|_)(?:FETCH|OPEN|VISIT|BROWSE|SCRAPE|CRAWL|NAVIGATE)(?:_TO)?_(?:AN?_|ANY_|WEB_)?(?:URL|WEBSITE|WEBPAGE|WEB_PAGE|ENDPOINT)(?:_|$)/.test(operation)
    || /(?:EXECUTE|RUN|EVALUATE|INVOKE)_(?:PYTHON|JAVASCRIPT|NODEJS|BASH|RUBY|LUA|RUST|JAVA|TYPESCRIPT|REPL)(?:_|$)/.test(operation)
    || /(?:EXECUTE|RUN|EVALUATE|INVOKE|TRIGGER|CALL|CREATE|DEPLOY)_(?:[A-Z]+_){0,2}(?:CODE|COMMANDS?|SCRIPT|FUNCTION|WORKFLOW|TOOLS?|LAMBDA|PIPELINE|ACTION|AGENT|JOB|PROGRAM|QUERY)(?:_|$)/.test(slug)
    || /(?:API|HTTP|CUSTOM|ARBITRARY|GENERIC|RAW)_(?:API_|HTTP_)?(?:REQUEST|CALL|ACTION|FETCH)|(?:BATCH|BULK|MULTI)_(?:EXECUTE|CALL|RUN)|(?:ARBITRARY|CUSTOM)_(?:URL|REQUEST)/.test(slug)
    || /(?:arbitrary|custom|generic)\s+(?:authenticated\s+|raw\s+)?(?:HTTP|REST|API|GraphQL|SQL|code|command|script|endpoint)|(?:execute|run)\s+(?:arbitrary|user[- ](?:provided|supplied))\s+(?:code|commands?|scripts?|queries)/i.test(text))
    return 'This operation can issue other requests or run code outside its individual tool permission.';
  // Many catalogs include a proxy under an innocuous name. Inspect nested
  // property names too; generic endpoint + method is not a bounded operation.
  const keys = new Set();
  const visit = value => {
    if (!record(value) && !Array.isArray(value)) return;
    for (const [k,v] of Object.entries(value)) {
      if (k==='properties' && record(v)) for (const prop of Object.keys(v)) keys.add(prop.toLowerCase());
      visit(v);
    }
  };
  visit(tool.inputSchema);
  if (['shell_command','shell_commands','javascript_code','python_code','sql_query','script_body','bash_command','command_line','code_to_execute','base_url_override','auth_credentials','dangerously_allow_proxy','access_token','api_key','authorization_header'].some(k=>keys.has(k))
    || (['url','uri','endpoint','route','path','request_url','api_endpoint'].some(k=>keys.has(k)) && ['method','http_method','httpmethod','request_method','headers','http_headers'].some(k=>keys.has(k))))
    return 'The operation accepts executable instructions, credentials, or an open-ended request destination.';
  return null;
}

export function createStore(filename, {recoverOnOpen = true} = {}) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, expected TEXT, email TEXT,
      owner TEXT, account TEXT, attempt TEXT, status TEXT NOT NULL DEFAULT 'disconnected',
      policy TEXT NOT NULL DEFAULT 'Block', grantId TEXT, bearerHash TEXT, grantExpires INTEGER
    );
    INSERT OR IGNORE INTO workspaces(id,name) VALUES ('personal','Personal'),('work','Work');
    CREATE TABLE IF NOT EXISTS catalog_connections (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(id), toolkit TEXT NOT NULL,
      label TEXT NOT NULL, owner TEXT NOT NULL UNIQUE, account TEXT UNIQUE, authConfigId TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','active','disabled')), at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS catalog_connections_workspace ON catalog_connections(workspace,status);
    CREATE TABLE IF NOT EXISTS catalog_tool_policies (
      connection TEXT NOT NULL REFERENCES catalog_connections(id), slug TEXT NOT NULL, version TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT NOT NULL, schemaJson TEXT NOT NULL, tagsJson TEXT NOT NULL,
      mcpName TEXT NOT NULL UNIQUE, revision TEXT NOT NULL, PRIMARY KEY(connection,slug)
    );
    CREATE TABLE IF NOT EXISTS workspace_agents (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(id), actor TEXT NOT NULL,
      bearerHash TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pairings(
      id TEXT PRIMARY KEY, ws TEXT NOT NULL, inviteHash TEXT UNIQUE, receiptHash TEXT, codeHash TEXT,
      at INTEGER NOT NULL, expires INTEGER NOT NULL, stage TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS requests(
      id TEXT PRIMARY KEY, at INTEGER NOT NULL, workspace TEXT NOT NULL, actor TEXT NOT NULL, tool TEXT NOT NULL,
      outcome TEXT NOT NULL, providerCalled INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS requests_at_workspace ON requests(at,workspace);
    CREATE TABLE IF NOT EXISTS request_exchanges(
      request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK(channel IN ('mcp','http','owner')),
      request_json TEXT NOT NULL CHECK(json_valid(request_json)),
      response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json))
    );
  `);
  // A process interruption leaves an honest record of the attempted lookup.
  const recover = () => transaction(() => {
    db.exec("UPDATE request_exchanges SET response_json=NULL WHERE request_id IN (SELECT id FROM requests WHERE outcome='Running')");
    db.exec("UPDATE requests SET outcome='Interrupted',detail='Airport restarted before the request completed.' WHERE outcome='Running'");
  });
  if(recoverOnOpen) recover();
  const get = ws => db.prepare('SELECT * FROM workspaces WHERE id=?').get(ws) || fail('Unknown workspace.',404);
  const validGrant = row => Boolean(row.grantId && row.grantExpires > now());
  function revoke(ws) {
    get(ws);
    db.prepare('UPDATE workspaces SET grantId=NULL,bearerHash=NULL,grantExpires=NULL WHERE id=?').run(ws);
    db.prepare("DELETE FROM pairings WHERE ws=?").run(ws);
  }
  function transaction(f) {
    db.exec('BEGIN IMMEDIATE');
    try {const value=f();db.exec('COMMIT');return value;} catch(e){db.exec('ROLLBACK');throw e;}
  }
  const hasSource = ws => {
    const pilot = get(ws);
    return (pilot.status==='active' && !!pilot.account && !!pilot.email) ||
      !!db.prepare("SELECT 1 FROM catalog_connections WHERE workspace=? AND status='active' LIMIT 1").get(ws);
  };
  function createWorkspace(name) {
    const id = 'ws_'+randomUUID();
    const display = label(name);
    db.prepare('INSERT INTO workspaces(id,name) VALUES(?,?)').run(id,display);
    return {id,name:display};
  }
  function getConnection(ws,id) {
    const row=db.prepare('SELECT *,account AS accountId FROM catalog_connections WHERE workspace=? AND id=?').get(ws,id);
    if (!row) fail('Unknown connection in this workspace.',404);
    return row;
  }
  function createConnection(ws,{toolkit,label:name,authConfigId}={}) {
    get(ws);
    if (!slugPattern.test(toolkit || '')) fail('Select a provider toolkit.');
    if (authConfigId!=null && (typeof authConfigId!=='string'||authConfigId.length>240)) fail('Invalid auth config.');
    const id=randomUUID();
    db.prepare("INSERT INTO catalog_connections(id,workspace,toolkit,label,owner,authConfigId,status,at) VALUES(?,?,?,?,?,?,'pending',?)")
      .run(id,ws,toolkit.toLowerCase(),label(name,toolkit),'airport_'+randomUUID(),authConfigId||null,now());
    return getConnection(ws,id);
  }
  function attachConnection(ws,id,account) {
    if (account!=null && (typeof account!=='string'||!account.trim()||account.length>240)) fail('Invalid connected account.');
    return transaction(()=>{
      const connection=getConnection(ws,id);
      if (connection.status!=='pending' || (connection.account && connection.account!==account)) fail('This connection attempt has changed.',409);
      if (account && (db.prepare('SELECT 1 FROM workspaces WHERE account=?').get(account) ||
        db.prepare('SELECT 1 FROM catalog_connections WHERE account=? AND id!=?').get(account,id))) fail('This provider account is already bound.',409);
      db.prepare('UPDATE catalog_connections SET account=? WHERE id=?').run(account??null,id);
      return getConnection(ws,id);
    });
  }
  function activateConnection(ws,id,account) {
    const c=getConnection(ws,id);
    if (c.status==='disabled' || c.account!==(account??null)) fail('This connection attempt has changed.',409);
    const change=db.prepare("UPDATE catalog_connections SET status='active' WHERE id=? AND workspace=? AND status IN ('pending','active') AND account IS ?")
      .run(id,ws,account??null);
    if(!change.changes) fail('This connection attempt has changed.',409);
    return getConnection(ws,id);
  }
  function disableConnection(ws,id) {
    return transaction(()=>{
      getConnection(ws,id);
      db.prepare("UPDATE catalog_connections SET status='disabled' WHERE id=?").run(id);
      db.prepare('DELETE FROM catalog_tool_policies WHERE connection=?').run(id);
      if (!hasSource(ws)) revoke(ws);
    });
  }
  function blockTool(ws,id,slug) {
    getConnection(ws,id);
    if(typeof slug!=='string' || !slugPattern.test(slug)) fail('Select a tool.');
    db.prepare('DELETE FROM catalog_tool_policies WHERE connection=? AND slug=?').run(id,slug);
  }
  function listToolPolicies(ws,id) {
    getConnection(ws,id);
    return db.prepare('SELECT slug,version,name,mcpName FROM catalog_tool_policies WHERE connection=? ORDER BY name,slug').all(id)
      .map(t=>({...t,enabled:true,allowed:true}));
  }
  function listConnections(ws) {
    get(ws);
    return db.prepare('SELECT id,workspace,toolkit,label,status FROM catalog_connections WHERE workspace=? ORDER BY at,id').all(ws)
      .map(c=>({...c,tools:listToolPolicies(ws,c.id)}));
  }
  function setToolPolicy(ws,id,tool,enabled) {
    const c=getConnection(ws,id);
    if (!tool||typeof tool.slug!=='string'||typeof enabled!=='boolean') fail('Select an operation and its policy.');
    if (tool.toolkit?.toLowerCase()!==c.toolkit) fail('This operation belongs to a different toolkit.',409);
    if (!enabled) {
      db.prepare('DELETE FROM catalog_tool_policies WHERE connection=? AND slug=? AND version=?').run(id,tool.slug,tool.version);
      return;
    }
    if(c.status!=='active') fail('Activate this connection before enabling tools.',409);
    const reason=catalogToolRestriction(tool);
    if(reason) fail(reason,403);
    const mcpName='c_'+hash(JSON.stringify([id,tool.slug,tool.version])).slice(0,22)+'_'+tool.slug.toLowerCase().slice(0,38);
    const schema=JSON.stringify(tool.inputSchema), tags=JSON.stringify(Array.isArray(tool.tags)?tool.tags.filter(t=>typeof t==='string'):[]);
    db.prepare(`INSERT INTO catalog_tool_policies(connection,slug,version,name,description,schemaJson,tagsJson,mcpName,revision) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(connection,slug) DO UPDATE SET version=excluded.version,name=excluded.name,description=excluded.description,schemaJson=excluded.schemaJson,tagsJson=excluded.tagsJson,mcpName=excluded.mcpName,revision=excluded.revision`)
      .run(id,tool.slug,tool.version,String(tool.name||tool.slug).slice(0,200),String(tool.description||'').slice(0,4000),schema,tags,mcpName,randomUUID());
    return {slug:tool.slug,version:tool.version,name:tool.name||tool.slug,mcpName,enabled:true,allowed:true};
  }
  const approvedSQL=`SELECT t.*,c.toolkit,c.label,c.owner,c.account,c.workspace FROM catalog_tool_policies t
    JOIN catalog_connections c ON c.id=t.connection WHERE c.workspace=? AND c.status='active'`;
  function unpackTool(row) {
    if (!row) return null;
    const {schemaJson,tagsJson,...fields}=row;
    return {...fields,inputSchema:JSON.parse(schemaJson),tags:JSON.parse(tagsJson)};
  }
  const resolveTool=(ws,mcpName)=>unpackTool(db.prepare(approvedSQL+' AND t.mcpName=?').get(ws,mcpName));
  const approvedTools=ws=>db.prepare(approvedSQL+' ORDER BY t.mcpName').all(ws).map(unpackTool);
  function listAgentGrants(ws) {
    get(ws);
    return db.prepare(`SELECT id,workspace,actor,expires FROM workspace_agents WHERE workspace=? AND ${activeAgent} ORDER BY actor`).all(ws,now())
      .map(({expires,...r})=>({...r,expiresAt:agentExpiresAt(expires)}));
  }
  function availableAgentName(ws,name) {
    const actor=label(name);
    const key=v=>v.normalize('NFKC').replace(/\s+/g,' ').toLowerCase();
    if (['owner','owner console','muse'].includes(key(actor)) || /\p{Cf}/u.test(actor)) fail('Choose a distinct agent name.');
    const active=db.prepare(`SELECT actor FROM workspace_agents WHERE workspace=? AND ${activeAgent}`).all(ws,now());
    if (active.some(row=>key(row.actor)===key(actor))) fail('This agent name is already in use in the workspace.',409);
    return actor;
  }
  function grantDuration(lifetime='12h') {
    if (!agentDurations.has(lifetime)) fail('Choose a credential lifetime of 12h, 7d, 30d, or forever.');
    return agentDurations.get(lifetime);
  }
  // Called only within the issuing or registering transaction.
  function insertNamedGrant(ws,name,lifetime) {
    const actor=availableAgentName(ws,name);
    const duration=grantDuration(lifetime);
    const id=randomUUID(),token=secret(),expires=duration===null ? neverExpires : now()+duration;
    db.prepare(`DELETE FROM workspace_agents WHERE workspace=? AND expires!=${neverExpires} AND expires<=?`).run(ws,now());
    db.prepare('INSERT INTO workspace_agents(id,workspace,actor,bearerHash,expires) VALUES(?,?,?,?,?)').run(id,ws,actor,hash(token),expires);
    return {id,workspace:ws,actor,token,expiresAt:agentExpiresAt(expires)};
  }
  function issueAgentGrant(ws,name,lifetime) {
    return transaction(()=>{
      get(ws);
      const grant=insertNamedGrant(ws,name,lifetime);
      insertLog(ws,'Owner console','issue_agent_grant','Issued',false,'Issued a named agent workspace credential.');
      return grant;
    });
  }
  const enrollment=createEnrollment({db,transaction,get,grantDuration,availableAgentName,insertNamedGrant,insertLog,secret,hash,fail});
  function revokeAgentGrant(ws,id) {
    get(ws);
    if(!db.prepare('DELETE FROM workspace_agents WHERE workspace=? AND id=?').run(ws,id).changes) fail('Unknown agent grant.',404);
  }
  function canUseCatalog(grant) {
    if (grant.actor==='Owner console' && !grant.id) return true;
    if (!grant.id) return false;
    return !!db.prepare(`SELECT 1 FROM workspace_agents WHERE id=? AND workspace=? AND actor=? AND ${activeAgent}`)
      .get(grant.id,grant.workspace,grant.actor,now());
  }
  function isGrantActive(grant) {
    if(canUseCatalog(grant)) return true;
    if(!grant.id || grant.actor!=='Muse') return false;
    const row=get(grant.workspace);
    return grant.id===row.grantId && validGrant(row) && hasSource(grant.workspace);
  }
  function begin(ws,email) {
    return transaction(()=>{
      if(get(ws).status==='active')fail('Disconnect the current account before replacing it.',409);
      const other=db.prepare("SELECT id FROM workspaces WHERE id!=? AND status IN ('active','pending') AND expected=? COLLATE NOCASE").get(ws,email);
      if(other)fail('That address is already selected in the other workspace.',409);
      const attempt=randomUUID(), owner='airport_'+randomUUID();
      revoke(ws);
      db.prepare("UPDATE workspaces SET attempt=?,owner=?,expected=?,email=NULL,account=NULL,status='pending' WHERE id=?").run(attempt,owner,email,ws);
      return {attempt,owner};
    });
  }
  function activate(ws,attempt,email) {
    return transaction(()=>{
      const row=get(ws);
      if(row.attempt!==attempt||row.status!=='pending')fail('This sign-in has been replaced.',409);
      if(!row.account)fail('This sign-in has no pending Composio connection.',409);
      if(email.toLowerCase()!==row.expected.toLowerCase()) {
        db.prepare("UPDATE workspaces SET account=NULL,owner=NULL,attempt=NULL,status='mismatch' WHERE id=?").run(ws);
        return false;
      }
      db.prepare("UPDATE workspaces SET email=?,status='active' WHERE id=?").run(email,ws);
      return true;
    });
  }
  const livePairing = db.prepare("SELECT stage,expires FROM pairings WHERE ws=? AND tries<5 AND expires>? ORDER BY at DESC LIMIT 1");
  function invitation(ws) {
    const row=livePairing.get(ws,now());
    return row ? {stage:row.stage,expiresAt:iso(row.expires)} : null;
  }
  function issue(ws,replace) {
    if(!hasSource(ws))fail('Connect and verify an account first.',409);
    const invite=secret(),expires=now()+ttl;
    transaction(()=>{
      const existing=invitation(ws);
      if(existing && (existing.stage!==replace?.stage || existing.expiresAt!==replace?.expiresAt)) {
        fail('An invitation is already in progress. Review its current status before replacing it.',409);
      }
      if(!existing && replace) fail('The previous invitation is no longer outstanding. Check the current pairing status.',409);
      db.prepare('DELETE FROM pairings WHERE ws=? OR expires<=?').run(ws,now());
      db.prepare("INSERT INTO pairings(id,ws,inviteHash,at,expires,stage) VALUES (?,?,?,?,?,'new')").run(randomUUID(),ws,hash(invite),now(),expires);
    });
    return {invite,expiresAt:iso(expires)};
  }
  function pairStart(invite) {
    return transaction(()=>{
      const row=db.prepare("SELECT * FROM pairings WHERE inviteHash=? AND expires>? AND stage='new'").get(hash(invite),now());
      if(!row)fail('Invalid or expired invitation.',403);
      const receipt=secret(),code=String(randomInt(100000,1000000));
      db.prepare("UPDATE pairings SET inviteHash=NULL,stage='waiting',receiptHash=?,codeHash=? WHERE id=?").run(hash(receipt),hash(code),row.id);
      return {pairId:row.id,receipt,code,expiresAt:iso(row.expires)};
    });
  }
  function approve(id,code) {
    const row=db.prepare("SELECT * FROM pairings WHERE id=? AND stage='waiting' AND expires>? AND tries<5").get(id,now());
    if(!row)fail('This pairing has expired or was replaced.',409);
    if(!same(hash(code),row.codeHash)){db.prepare('UPDATE pairings SET tries=tries+1 WHERE id=?').run(id);fail('The code does not match.',403);}
    db.prepare("UPDATE pairings SET stage='approved',codeHash=NULL WHERE id=?").run(id);
  }
  // Call inside the issuing transaction, so only the newest workspace grant
  // can be used and no earlier invitation can replace it after commit.
  function replaceGrant(ws) {
    if (!hasSource(ws)) fail('Connect and verify an account first.',409);
    const token = secret();
    const expires = now() + 12 * 3600_000;
    db.prepare('UPDATE workspaces SET bearerHash=?,grantId=?,grantExpires=? WHERE id=?').run(hash(token),randomUUID(),expires,ws);
    db.prepare('DELETE FROM pairings WHERE ws=?').run(ws);
    return {token, expiresAt:iso(expires)};
  }
  function insertLog(ws,actor,tool,outcome,called,detail,exchange) {
    const id = randomUUID();
    db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?)').run(id,now(),ws,actor,tool,outcome,called?1:0,detail);
    if (exchange) {
      db.prepare('INSERT INTO request_exchanges(request_id,channel,request_json,response_json) VALUES(?,?,?,?)')
        .run(id,exchange.channel,JSON.stringify(exchange.request),exchange.response == null ? null : JSON.stringify(exchange.response));
    }
    return id;
  }
  function log(...args) {
    return transaction(() => insertLog(...args));
  }
  function finish(id,outcome,detail,response) {
    return transaction(() => {
      db.prepare('UPDATE requests SET outcome=?,detail=? WHERE id=?').run(outcome,detail,id);
      if (response !== undefined) db.prepare('UPDATE request_exchanges SET response_json=? WHERE request_id=?')
        .run(JSON.stringify(response),id);
    });
  }
  function issueConnectorGrant(ws) {
    return transaction(() => {
      const grant = replaceGrant(ws);
      insertLog(ws,'Owner console','issue_connector_grant','Issued',false,'Issued a 12-hour Muse connector credential for this workspace.',{
        channel:'owner',request:{method:'POST',path:'/api/connector-grant',params:{workspace:ws}},
        response:{expiresAt:grant.expiresAt,token:'[redacted]'}
      });
      return grant;
    });
  }
  function pairToken(id,receipt) {
    return transaction(()=>{
      const row=db.prepare('SELECT * FROM pairings WHERE id=? AND expires>? AND tries<5').get(id,now());
      if(!row||!same(row.receiptHash,hash(receipt))||!['waiting','approved'].includes(row.stage))fail('Invalid or expired pairing.',403);
      if(row.stage==='waiting')return {status:'pending'};
      const {token} = replaceGrant(row.ws);
      insertLog(row.ws,'Muse','pair_connector_grant','Issued',false,'Muse claimed its approved workspace credential.',{
        channel:'http',request:{method:'POST',path:'/pair/token',params:{pairId:'[redacted]',receipt:'[redacted]'}},
        response:{status:'approved',token:'[redacted]'}
      });
      return {status:'approved',token};
    });
  }
  const state = () => ({
    activityDetailsVersion:1,
    weeklyUsage:db.prepare(`SELECT workspace, count(*) AS requests,
      sum(outcome='Allowed') AS allowed, sum(outcome='Blocked') AS blocked,
      sum(outcome IN ('Failed','Interrupted')) AS failed, sum(outcome='Running') AS other
      FROM requests WHERE at>=? AND at<=? AND outcome IN ('Allowed','Blocked','Failed','Interrupted','Running')
      GROUP BY workspace`).all(now()-7*24*3600_000,now()),
    agentAccessLifetimes:[...agentDurations.keys()],
    agentInvitations:enrollment.listAgentInvitations(),
    connections:db.prepare('SELECT id FROM workspaces').all().flatMap(w=>listConnections(w.id)),
    agentGrants:db.prepare('SELECT id FROM workspaces').all().flatMap(w=>listAgentGrants(w.id)),
    workspaces:db.prepare('SELECT * FROM workspaces ORDER BY id').all().map(r=>({
      id:r.id,name:r.name,status:r.status,email:r.email,expectedEmail:r.expected,policy:r.policy,grant:validGrant(r),invitation:invitation(r.id)
    })),
    invites:db.prepare("SELECT id,ws AS workspace,at FROM pairings WHERE stage='waiting' AND tries<5 AND expires>? ORDER BY at DESC").all(now()).map(r=>({...r,at:iso(r.at)})),
    logs:db.prepare(`SELECT r.*,x.channel,x.request_json,x.response_json FROM requests r
      LEFT JOIN request_exchanges x ON x.request_id=r.id ORDER BY r.at DESC,r.rowid DESC LIMIT 100`).all()
      .map(({channel,request_json,response_json,...r})=>({
        ...r,at:iso(r.at),providerCalled:!!r.providerCalled,exchange:channel ? {
          channel,request:JSON.parse(request_json),response:response_json === null ? null : JSON.parse(response_json)
        } : null
      }))
  });
  return {
    createWorkspace,createConnection,attachConnection,activateConnection,getConnection,listConnections,disableConnection,listToolPolicies,blockTool,setToolPolicy,resolveTool,approvedTools,
    issueAgentGrant,revokeAgentGrant,listAgentGrants,canUseCatalog,isGrantActive,...enrollment,
    get,state,begin,activate,issue,issueConnectorGrant,pairStart,pairToken,approve,revoke,recover,log,finish,close:()=>db.close(),
    getPolicy(ws){return get(ws).policy;},
    setPolicy(ws,policy){get(ws);if(!['Allow','Block'].includes(policy))fail('Unknown Gmail read policy.');db.prepare('UPDATE workspaces SET policy=? WHERE id=?').run(policy,ws);},
    attach(ws,attempt,account){
      return transaction(()=>{
        if(db.prepare('SELECT 1 FROM catalog_connections WHERE account=?').get(account) ||
          db.prepare('SELECT 1 FROM workspaces WHERE id!=? AND account=?').get(ws,account)) fail('This provider account is already bound.',409);
        if(!db.prepare("UPDATE workspaces SET account=? WHERE id=? AND attempt=? AND status='pending' AND (account IS NULL OR account=?)").run(account,ws,attempt,account).changes)
          fail('This sign-in has been replaced.',409);
      });
    },
    cancel(ws,attempt,status='disconnected'){db.prepare("UPDATE workspaces SET status=?,owner=NULL,attempt=NULL,account=NULL,email=NULL WHERE id=? AND attempt=? AND status='pending'").run(status,ws,attempt);},
    disconnect(ws){transaction(()=>{revoke(ws);db.prepare("UPDATE workspaces SET owner=NULL,expected=NULL,email=NULL,account=NULL,attempt=NULL,status='disconnected',policy='Block' WHERE id=?").run(ws);
    });},
    authenticate(token){
      const digest=hash(token);
      const r=db.prepare('SELECT id,grantId FROM workspaces WHERE bearerHash=? AND grantExpires>?').get(digest,now());
      if(r && hasSource(r.id)) return {workspace:r.id,id:r.grantId,actor:'Muse'};
      const named=db.prepare(`SELECT id,workspace,actor FROM workspace_agents WHERE bearerHash=? AND ${activeAgent}`).get(digest,now());
      return named ? {...named} : null;
    }
  };
}
