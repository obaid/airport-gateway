import {createHash} from 'node:crypto';
import {catalogToolRestriction,fail} from './store.mjs';

const presetKinds = new Map([
  ['read-only',['read']], ['write-only',['write']], ['read-write',['read','write']]
]);
const mutatingVerb = /^(?:ADD|APPEND|ARCHIVE|ASSIGN|CANCEL|CHANGE|CLEAR|CLOSE|COPY|CREATE|DELETE|DEPLOY|DISABLE|DISPATCH|EDIT|ENABLE|GENERATE|GRANT|IMPORT|INSERT|INVITE|MARK|MERGE|MODIFY|MOVE|PUBLISH|PUSH|REMOVE|RENAME|REPLACE|RESET|RESTORE|REVOKE|RUN|SAVE|SEND|SET|SHARE|START|SUBMIT|SYNC|TRANSFER|TRIGGER|UPDATE|UPLOAD|UPSERT)(?:_|$)/;
const readVerb = /^(?:CHECK|DESCRIBE|FETCH|FIND|GET|LIST|LOOKUP|READ|RETRIEVE|SEARCH|VIEW)(?:_|$)/;
const destructiveVerb = /^(?:ARCHIVE|CLEAR|DELETE|DESTROY|ERASE|PURGE|REMOVE|REVOKE|TRASH|WIPE)(?:_|$)/;
const sensitive = /(?:^|_)(?:SECRETS?|PASSWORDS?|CREDENTIALS?|TOKENS?|API_KEYS?|PRIVATE_KEYS?|PERMISSIONS?|ACCESS_CONTROL|ROLE_ASSIGNMENTS?|BILLING|PAYMENTS?|PURCHASES?)(?:_|$)/;
const destructiveInput = /^(?:archive[d]?|delete|permanently_delete|delete_existing|purge|trash|in_trash)$/i;
const readSideEffect = /^(?:mark_as_read|mark_read|auto_create|create_if_(?:missing|not_exists)|upsert|save_to_.+|update_existing)$/i;

function hasInput(schema,match) {
  if(!schema || typeof schema!=='object')return false;
  if(schema.properties && Object.keys(schema.properties).some(key=>match.test(key)))return true;
  return Object.values(schema).some(child=>child && typeof child==='object' && hasInput(child,match));
}

// Only positive Composio action hints can enroll a tool. Names and input fields
// can withhold a conflicting hint, but never grant access by themselves.
export function classifyTool(tool) {
  if(catalogToolRestriction(tool))return 'restricted';
  const tags=new Set(tool.tags);
  const read=tags.has('readOnlyHint'),write=tags.has('createHint') || tags.has('updateHint');
  if(read===write || tags.has('destructiveHint') || tool.deprecated)return 'manual';
  const slug=tool.slug.toUpperCase().replaceAll('-','_');
  const prefix=tool.toolkit.toUpperCase().replaceAll('-','_')+'_';
  const action=slug.startsWith(prefix)?slug.slice(prefix.length):slug;
  const verbs=action.split(/_(?:AND|OR)_/);
  if(sensitive.test(action) || verbs.some(verb=>destructiveVerb.test(verb)))return 'manual';
  if(read && (verbs.some(verb=>mutatingVerb.test(verb)) || hasInput(tool.inputSchema,readSideEffect)))return 'manual';
  if(write && (verbs.some(verb=>readVerb.test(verb)) || hasInput(tool.inputSchema,destructiveInput)))return 'manual';
  return read?'read':'write';
}

export function matchesAccessMode(presetClass,tool) {
  return presetClass==null || presetClass===classifyTool(tool);
}

function canonical(key,value) {
  if(!value || typeof value!=='object' || Array.isArray(value))return value;
  return Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]]));
}

async function collectTools(provider,toolkit) {
  const tools=new Map(),cursors=new Set();
  let cursor,total;
  do {
    const page=await provider.listTools({toolkit,cursor,bulk:true});
    if(!Array.isArray(page?.items))fail('Composio returned an incomplete tool catalog. Try again.',502);
    if(page.total!==undefined){
      if(!Number.isSafeInteger(page.total) || page.total<0 || (total!==undefined && total!==page.total))
        fail('The tool catalog changed during review. Try again.',409);
      total=page.total;
    }
    for(const tool of page.items){
      if(tool.toolkit!==toolkit || tools.has(tool.slug))fail('The tool catalog changed during review. Try again.',409);
      tools.set(tool.slug,{tool,kind:classifyTool(tool)});
    }
    cursor=page.nextCursor;
    if(cursor!=null && (typeof cursor!=='string' || !cursor || cursor.length>4096 || cursors.has(cursor) || !page.items.length))
      fail('Composio returned an incomplete tool catalog. Try again.',502);
    if(cursor)cursors.add(cursor);
  }while(cursor);
  if(total!==undefined && total!==tools.size)fail('Composio returned an incomplete tool catalog. Try again.',502);
  return Array.from(tools.values()).sort((a,b)=>a.tool.slug<b.tool.slug?-1:1);
}

export function createAccessActions(store,provider) {
  async function review(b) {
    const c=store.getConnection(b.workspace,b.connectionId);
    if(c.status!=='active')fail('Activate this connection before choosing access.',409);
    const previous=store.listToolPolicies(c.workspace,c.id);
    const rows=await collectTools(provider(),c.toolkit);
    // Bind a preview to the reviewed definitions, versions and account's policy.
    // A second tab can review independently, without keeping private sessions in memory.
    const hash=createHash('sha256').update(JSON.stringify([c.workspace,c.id,c.accessRevision]));
    for(const {tool,kind} of rows){
      hash.update(JSON.stringify([tool.slug,tool.version,kind,tool.name,tool.description,tool.inputSchema,[...(tool.tags||[])].sort()],canonical));
    }
    return {c,previous,rows,previewId:hash.digest('hex')};
  }
  async function preview(b) {
    const {c,previous,rows,previewId}=await review(b);
    const latest=store.getConnection(c.workspace,c.id);
    if(latest.status!=='active' || c.accessRevision!==latest.accessRevision)fail('This connection or its access changed. Review the choices again.',409);
    const current=new Map(previous.map(t=>[t.slug,t.version]));
    const examples={read:[],write:[],manual:[]};
    let manualOnly=0,restricted=0;
    for(const {tool,kind} of rows){
      if(kind==='restricted'){restricted++;continue;}
      if(kind==='manual')manualOnly++;
      if(examples[kind].length<3)examples[kind].push(tool.name||tool.slug);
    }
    const presets={};
    for(const [mode,kinds] of presetKinds){
      const selected=rows.filter(r=>kinds.includes(r.kind));
      const retained=selected.filter(({tool})=>current.get(tool.slug)===tool.version).length;
      presets[mode]={allowed:selected.length,added:selected.length-retained,removed:previous.length-retained};
    }
    return {previewId,total:rows.length,manualOnly,restricted,examples,presets};
  }
  async function apply(b) {
    if((b.mode!=='custom' && !presetKinds.has(b.mode)) || typeof b.previewId!=='string' || !/^[a-f0-9]{64}$/.test(b.previewId))
      fail('Review the available tools and choose a valid access level.');
    const saved=store.getConnection(b.workspace,b.connectionId);
    if(saved.status==='active' && saved.accessMode===b.mode && saved.appliedPreview===b.previewId)
      return {ok:true,mode:b.mode,allowed:store.listToolPolicies(saved.workspace,saved.id).length};
    const {c,rows,previewId}=await review(b);
    if(previewId!==b.previewId)fail('Tool access or the catalog changed. Review the choices again.',409);
    const kinds=presetKinds.get(b.mode)||[];
    return store.applyConnectionAccess(c.workspace,c.id,c.accessRevision,b.mode,rows.filter(row=>kinds.includes(row.kind)),previewId);
  }
  return {'connection-access-preview':preview,'connection-access-apply':apply};
}
