import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createStore} from './store.mjs';
import {createCatalogActions} from './owner-catalog.mjs';
import {classifyTool} from './access-presets.mjs';
import {createToolRunner} from './agent.mjs';

function action(slug,tags,overrides={}) {
  return {slug,toolkit:slug.split('_')[0].toLowerCase(),version:'20261120_00',name:slug,description:'',
    inputSchema:{type:'object',properties:{}},tags,...overrides};
}
const read=action('NOTION_SEARCH_NOTION_PAGE',['readOnlyHint','openWorldHint']);
const write=action('NOTION_CREATE_NOTION_PAGE',['createHint']);
const remove=action('NOTION_DELETE_BLOCK',['destructiveHint']);
const unknown=action('NOTION_MAGIC',['idempotentHint']);
const restricted=action('NOTION_RAW_API_REQUEST',['readOnlyHint']);

function fixture(t) {
  const store=createStore(':memory:');t.after(()=>store.close());
  const c=store.createConnection('personal',{toolkit:'notion'});
  store.attachConnection('personal',c.id,'ca_personal');
  store.activateConnection('personal',c.id,'ca_personal');
  const provider={
    listTools:async ({cursor})=>cursor?{items:[write,restricted],nextCursor:null,total:5}:
      {items:[read,remove,unknown],nextCursor:'next',total:5},
    getTool:async slug=>[read,write,remove,unknown,restricted].find(t=>t.slug===slug)
  };
  const b={workspace:'personal',connectionId:c.id};
  const actions=createCatalogActions({store,getCatalog:()=>provider,callbackURL:'https://test.invalid/oauth/done'});
  const call=(name,args)=>actions.get(name)({...b,...args});
  return {store,c,provider,call,preview:()=>call('connection-access-preview'),apply:(plan,mode)=>call('connection-access-apply',{previewId:plan.previewId,mode})};
}

test('presets require unambiguous provider hints and exclude conflicting actions, destructive inputs and general-purpose tools',()=>{
  for(const tool of [unknown,remove, action('GITHUB_DELETE_REPOSITORY',['updateHint']),action('GITHUB_CREATE_ISSUE',['readOnlyHint']),
    action('GITHUB_GET_OR_CREATE_BRANCH',['readOnlyHint']),action('GITHUB_LIST_ORGANIZATION_SECRETS',['readOnlyHint']),
    action('NOTION_QUERY_DATABASE',[]), action('GITHUB_LIST_PULL_REQUESTS',['updateHint','readOnlyHint']),
    action('NOTION_UPDATE_PAGE',['updateHint'],{inputSchema:{type:'object',properties:{archived:{type:'boolean'}}}}),
    action('GMAIL_FETCH_EMAILS',['readOnlyHint'],{inputSchema:{type:'object',properties:{mark_as_read:{type:'boolean'}}}}),
    {...read,deprecated:true}])assert.equal(classifyTool(tool),'manual',tool.slug);
  assert.equal(classifyTool(restricted),'restricted');
  assert.equal(classifyTool(action('GITHUB_SEARCH_ISSUES',['readOnlyHint'])),'read');
  assert.equal(classifyTool(action('GITHUB_CREATE_ISSUE',['createHint','idempotentHint'])),'write');
});

test('previews include every page, match changes against existing pins and replace only the chosen connection',async t=>{
  const {store,c,call,preview,apply}=fixture(t);
  const initial=await preview();
  assert.deepEqual(initial.presets,{'read-only':{allowed:1,added:1,removed:0},'write-only':{allowed:1,added:1,removed:0},'read-write':{allowed:2,added:2,removed:0}});
  assert.deepEqual(initial.examples,{read:[read.name],write:[write.name],manual:[remove.name,unknown.name]});
  assert.equal(initial.total,5);assert.equal(initial.manualOnly,2);assert.equal(initial.restricted,1);
  assert.equal(store.getConnection('personal',c.id).accessMode,null);
  assert.deepEqual(store.approvedTools('personal'),[]);
  assert.equal((await preview()).previewId,initial.previewId);
  await assert.rejects(call('connection-access-apply',{workspace:'work',previewId:initial.previewId,mode:'read-write'}),{status:404});
  const results=await Promise.all([apply(initial,'write-only'),apply(initial,'write-only')]);
  assert.deepEqual(results,[{ok:true,mode:'write-only',allowed:1},{ok:true,mode:'write-only',allowed:1}]);
  assert.deepEqual(store.approvedTools('personal').map(t=>[t.slug,t.version,t.presetClass]),[[write.slug,write.version,'write']]);
  const next=await preview();
  assert.deepEqual(next.presets['read-only'],{allowed:1,added:1,removed:1});
  await apply(next,'read-only');
  assert.deepEqual(store.approvedTools('personal').map(t=>t.slug),[read.slug]);
  const pin=store.approvedTools('personal')[0];
  await apply(await preview(),'read-write');
  assert.equal(store.resolveTool('personal',pin.mcpName).revision,pin.revision);
  await apply(await preview(),'custom');
  assert.equal(store.getConnection('personal',c.id).accessMode,'custom');
  assert.equal(store.approvedTools('personal').length,2);
  const old=await preview();
  await call('tool-access',{slug:remove.slug,allow:true});
  await assert.rejects(apply(old,'read-only'),{status:409});
  const edit=await preview();
  assert.deepEqual(edit.presets['read-only'],{allowed:1,added:0,removed:2});
  await call('tool-access',{slug:read.slug,allow:false});
  await assert.rejects(apply(edit,'read-only'),{status:409});
  assert.deepEqual(store.approvedTools('personal').map(t=>t.slug).sort(),[write.slug,remove.slug].sort());
});

test('incomplete, inconsistent, stale or revoked catalogs cannot replace the current policy',async t=>{
  const {store,c,provider,preview,apply}=fixture(t);
  await apply(await preview(),'read-only');
  const plan=await preview(), policy=store.approvedTools('personal');
  for(const page of [
    {items:[read],nextCursor:'repeat'}, {items:[read],total:2},
    {items:[read,read]}, {items:[{...read,toolkit:'github'}]},
    {items:[{...read,version:'20261201_00'}]}, {items:[{...read,tags:['createHint']}]}
  ]){
    provider.listTools=async()=>page;
    await assert.rejects(apply(plan,'write-only'));
    assert.deepEqual(store.approvedTools('personal'),policy);
  }
  provider.listTools=async({cursor})=>{
    if(cursor)throw Error('Provider unavailable.');
    return {items:[read],nextCursor:'more'};
  };
  await assert.rejects(apply(plan,'write-only'),/Provider unavailable/);
  assert.deepEqual(store.approvedTools('personal'),policy);
  provider.listTools=async()=>{
    store.disableConnection('personal',c.id);
    return {items:[read]};
  };
  await assert.rejects(apply(plan,'read-only'),{status:409});
  assert.deepEqual(store.approvedTools('personal'),[]);
});

test('manual changes during a provider read win over older approvals and preset reviews',async t=>{
  const {store,c,provider,call,preview}=fixture(t);
  provider.getTool=async()=>{
    store.blockTool('personal',c.id,read.slug);
    return read;
  };
  await assert.rejects(call('tool-access',{allow:true,slug:read.slug}),{status:409});
  provider.listTools=async()=>{
    store.setToolPolicy('personal',c.id,write,true);
    return {items:[read,write]};
  };
  await assert.rejects(preview(),{status:409});
  assert.deepEqual(store.approvedTools('personal').map(t=>t.slug),[write.slug]);
});

test('a preset read remains guarded against tag drift after customization',async t=>{
  const {store,provider,call,preview,apply}=fixture(t);
  await apply(await preview(),'read-only');
  const pin=store.approvedTools('personal')[0];
  await call('tool-access',{allow:true,slug:write.slug});
  let dispatched=0;
  provider.execute=async ({beforeDispatch})=>{
    beforeDispatch({...read,tags:['updateHint']});
    dispatched++;return {data:{}};
  };
  const grant=store.authenticate(store.issueAgentGrant('personal','Reader').token);
  const run=createToolRunner({store,getCatalog:()=>provider,getProvider:()=>null});
  assert.equal((await run(grant,pin.mcpName,undefined,{})).outcome,'Blocked');
  assert.equal(dispatched,0);
});

test('an existing database keeps every manual pin, requires setup for empty connections and rolls back a partial preset write',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'airport-presets-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const file=join(directory,'tenant.sqlite3');
  const original=createStore(file);
  const activated=original.createConnection('personal',{toolkit:'notion'}), empty=original.createConnection('personal',{toolkit:'notion'});
  original.activateConnection('personal',activated.id,null);
  original.activateConnection('personal',empty.id,null);
  const pinned=original.setToolPolicy('personal',activated.id,remove,true);
  original.close();
  const db=new DatabaseSync(file);
  db.exec(`ALTER TABLE catalog_tool_policies DROP COLUMN presetClass;
    ALTER TABLE catalog_connections DROP COLUMN accessMode;
    ALTER TABLE catalog_connections DROP COLUMN accessRevision;
    ALTER TABLE catalog_connections DROP COLUMN appliedPreview`);
  db.close();
  const store=createStore(file);
  t.after(()=>store.close());
  assert.equal(store.getConnection('personal',activated.id).accessMode,'custom');
  assert.equal(store.getConnection('personal',empty.id).accessMode,null);
  assert.equal(store.resolveTool('personal',pinned.mcpName).slug,remove.slug);
  const provider={listTools:async()=>({items:[read,write]})};
  const actions=createCatalogActions({store,getCatalog:()=>provider});
  const b={workspace:'personal',connectionId:activated.id};
  const {previewId}=await actions.get('connection-access-preview')(b);
  const writer=new DatabaseSync(file);
  writer.exec("CREATE TRIGGER abort_preset BEFORE INSERT ON catalog_tool_policies WHEN NEW.slug='NOTION_SEARCH_NOTION_PAGE' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  writer.close();
  await assert.rejects(actions.get('connection-access-apply')({...b,previewId,mode:'read-write'}),/test failure/);
  assert.deepEqual(store.approvedTools('personal').map(t=>t.slug),[remove.slug]);
  assert.equal(store.getConnection('personal',activated.id).accessMode,'custom');
  assert.equal((await actions.get('connection-access-preview')(b)).previewId,previewId);
});
