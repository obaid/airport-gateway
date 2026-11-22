import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalog, parseProjectAuthConfigs } from './catalog.mjs';

const kit = {
  slug:'testapp',name:'Test App',meta:{description:'Tools for tests',tools_count:8},
  no_auth:false,auth_schemes:['OAUTH2'],composio_managed_auth_schemes:['OAUTH2']
};
const noAuth = {...kit,no_auth:true,auth_schemes:[],composio_managed_auth_schemes:[]};
const tool = {
  slug:'TESTAPP_READ',name:'Read',description:'Fetch a record',toolkit:{slug:'testapp'},
  input_parameters:{type:'object',properties:{id:{type:'string'}},required:['id']},
  no_auth:false,version:'20261117_01',tags:['readOnlyHint'],scopes:['read']
};
const account = {id:'ca_example',user_id:'airport:work',toolkit:{slug:'testapp'},status:'ACTIVE',is_disabled:false};
const owner = 'airport:work', accountId = 'ca_example', toolkit = 'testapp';
const callbackURL = 'http://127.0.0.1:14000/callback';
const signIn = 'https://connect.composio.dev/link/ln_demo';
const execute = {owner,toolkit,accountId,slug:tool.slug,args:{id:'42'},version:tool.version};

function mock(t, outputs) {
  const calls = [];
  t.mock.method(globalThis,'fetch',async (target,options) => {
    const url = new URL(target);
    assert.equal(url.origin,'https://backend.composio.dev');
    assert.equal(options.redirect,'error');
    assert.equal(options.headers['x-api-key'],'test-only-project-key');
    assert(url.pathname.startsWith('/api/v3.1/'));
    calls.push({path:url.pathname.replace('/api/v3.1',''),params:Object.fromEntries(url.searchParams),method:options.method,
      body:options.body && JSON.parse(options.body)});
    const value=outputs[calls.length-1];
    assert(value !== undefined,'Unexpected network call');
    if (value instanceof Response) return value;
    return Response.json(value);
  });
  return {api:createCatalog('test-only-project-key'),calls};
}

test('toolkit and tool pages use published filters, cursors and schemas',async t => {
  const {api,calls} = mock(t,[{items:[kit],next_cursor:'next++='},{items:[tool],next_cursor:null},tool]);
  const kits = await api.listToolkits({search:'test app',cursor:'last++='});
  assert.equal(kits.nextCursor,'next++=');
  assert.deepEqual(kits.items[0],{
    slug:'testapp',name:'Test App',description:'Tools for tests',logo:null,toolsCount:8,requiresAuth:true,
    authSchemes:['OAUTH2'],managedAuthSchemes:['OAUTH2']
  });
  assert.deepEqual(calls[0].params,{search:'test app',cursor:'last++=',type:'all',limit:'50'});
  const tools = await api.listTools({toolkit,search:'read',cursor:'n='});
  assert.deepEqual(calls[1].params,{toolkit_slug:toolkit,query:'read',cursor:'n=',limit:'50'});
  assert.equal(tools.nextCursor,null);
  assert.deepEqual(tools.items[0].inputSchema,tool.input_parameters);
  assert.deepEqual(tools.items[0],await api.getTool(tool.slug,tool.version));
  assert.equal(calls[2].params.version,tool.version);
});

test('managed and explicitly configured accounts get verified hosted links',async t => {
  const found = {items:[kit],next_cursor:null};
  const session = {session_id:'trs_demo'};
  const link = {connected_account_id:accountId,redirect_url:signIn,link_token:'internal'};
  const customKit = {...kit,composio_managed_auth_schemes:[]};
  const {api,calls} = mock(t,[
    {items:[{...kit,slug:'other_testapp'}],next_cursor:'p2'},found,session,link,
    {items:[customKit]}, {id:'ac_custom',toolkit:{slug:toolkit},status:'ENABLED',credentials:{secret:'not returned'}},session,link,
    {items:[customKit]}, {items:[customKit]}, {id:'ac_custom',toolkit:{slug:'different'},status:'ENABLED'}
  ]);
  const expected = {accountId,url:signIn};
  const customApi = createCatalog('test-only-project-key',{authConfigs:{[toolkit]:'ac_custom'}});
  await assert.rejects(api.start({owner,toolkit,callbackURL,authConfigId:'ac_custom'}),/Airport manages/);
  assert.equal(calls.length,0);
  assert.deepEqual(await api.start({owner,toolkit,callbackURL}),expected);
  assert.deepEqual(calls[2].body,{user_id:owner,toolkits:{enable:[toolkit]},multi_account:{enable:true}});
  assert.deepEqual(calls[3].body,{toolkit,callback_url:callbackURL});
  assert.deepEqual(await customApi.start({owner,toolkit,callbackURL}),expected);
  assert.equal(calls[5].path,'/auth_configs/ac_custom');
  assert.deepEqual(calls[6].body.auth_configs,{testapp:'ac_custom'});
  await assert.rejects(api.start({owner,toolkit,callbackURL}),/Airport has not enabled sign-in/);
  await assert.rejects(customApi.start({owner,toolkit,callbackURL}),/enabled Composio auth config/);
  assert(!calls.some(c=>c.path==='/auth_configs'));
});

test('documented field maps publish named MCP inputs; unfamiliar schema shapes remain ineligible',async t=>{
  const fields={repo_name:{type:'string',description:'owner/repo',required:true},dry_run:{type:'boolean',required:false}};
  const nested={type:'object',properties:{value:{type:'string'}},required:['value']};
  const unsupported={anyOf:[nested,{type:'string'}]};
  const {api}=mock(t,[fields,{},nested,unsupported].map(input_parameters=>({...tool,input_parameters})));
  assert.deepEqual((await api.getTool(tool.slug)).inputSchema,{
    type:'object',properties:{repo_name:{type:'string',description:'owner/repo'},dry_run:{type:'boolean'}},
    additionalProperties:false,required:['repo_name']
  });
  assert.deepEqual((await api.getTool(tool.slug)).inputSchema,{type:'object',properties:{},additionalProperties:false});
  assert.deepEqual((await api.getTool(tool.slug)).inputSchema,nested);
  assert.deepEqual((await api.getTool(tool.slug)).inputSchema,unsupported);
});

test('server config mapping accepts custom toolkit slugs and rejects malformed configuration',()=>{
  assert.deepEqual({...parseProjectAuthConfigs('{"abc_def":"ac_123","GMAIL":"ac_mail"}')},{abc_def:'ac_123',gmail:'ac_mail'});
  assert.deepEqual({...parseProjectAuthConfigs(undefined)},{});
  for (const value of ['broken','[]','{"gmail":"token"}','{"gmail":"ac_x","GMAIL":"ac_y"}','{"bad/slug":"ac_ok"}']) {
    assert.throws(()=>parseProjectAuthConfigs(value));
  }
});

test('operator opt-in discovery only accepts an unambiguous enabled project config for a nonmanaged toolkit',async t=>{
  const found = {items:[{...kit,composio_managed_auth_schemes:[]}]};
  const entry = {id:'ac_org',status:'ENABLED',toolkit:{slug:toolkit}};
  const {calls} = mock(t,[
    found,{items:[entry]}, {session_id:'trs_example'}, {connected_account_id:accountId,redirect_url:signIn},
    found,{items:[entry,{...entry,id:'ac_other'}]},found,{items:[entry],next_cursor:'more'},found,{items:[]}
  ]);
  const api = createCatalog('test-only-project-key',{discoverProjectConfigs:true});
  assert.deepEqual(await api.start({owner,toolkit,callbackURL}),{accountId,url:signIn});
  assert.deepEqual(calls[1].params,{toolkit_slug:toolkit,show_disabled:'false',limit:'2'});
  assert.deepEqual(calls[2].body.auth_configs,{[toolkit]:entry.id});
  for(let i=0;i<3;i++)await assert.rejects(api.start({owner,toolkit,callbackURL}),/Airport has not enabled/);
  assert(!calls.some(c=>c.path==='/auth_configs' && c.method==='POST'));
});

test('account checks honor pinned config; verifier posts server identity and distinct opaque session',async t=>{
  const {calls} = mock(t,[{items:[{...account,auth_config:{id:'ac_other'}}]},{connected_account_id:accountId,toolkit_slug:toolkit}]);
  const api = createCatalog('test-only-project-key',{authConfigs:{[toolkit]:'ac_pinned'}});
  await assert.rejects(api.verify({owner,toolkit,accountId}),/could not be verified/);
  await assert.rejects(api.completeAuth({owner,sessionUri:''}),/verification session/);
  assert.deepEqual(await api.completeAuth({owner,sessionUri:'opaque-value'}),{accountId,toolkit});
  assert.deepEqual(calls[1],{path:'/connected_accounts/complete_auth',params:{},method:'POST',body:{user_id:owner,session_uri:'opaque-value'}});
});

test('account owner, toolkit, ID, active state, version and provider output are pinned',async t => {
  const {api,calls} = mock(t,[
    tool,{items:[account]},{successful:true,error:null,data:{record:42},log_id:'private'},
    tool,{items:[{...account,user_id:'personal'}]},tool,{items:[{...account,id:'ca_other'}]},
    tool,{items:[{...account,toolkit:{slug:'other'}}]},tool,{items:[{...account,status:'INACTIVE'}]},
    tool,{items:[{...account,experimental:{account_type:'SHARED'}}]},
    {...tool,version:'other'}, {...tool,toolkit:{slug:'other'}},
    tool,{items:[account]},{successful:false,error:'sensitive provider error',data:{private:'credentials'}}
  ]);
  assert.deepEqual(await api.execute(execute),{data:{record:42}});
  assert.deepEqual(calls[1].params,{user_ids:owner,connected_account_ids:accountId,toolkit_slugs:toolkit,limit:'1'});
  assert.deepEqual(calls[2],{path:'/tools/execute/TESTAPP_READ',params:{},method:'POST',
    body:{user_id:owner,version:tool.version,connected_account_id:accountId,arguments:{id:'42'}}});
  for (const reason of [/workspace and toolkit/,/workspace and toolkit/,/workspace and toolkit/,/inactive/,/workspace and toolkit/,/different tool or version/,/another toolkit/,/did not report/]) {
    await assert.rejects(api.execute(execute),reason);
  }
  assert.equal(calls.filter(c => c.method === 'POST').length,2);
});

test('credentialless tools require both the toolkit and pinned tool to explicitly allow it',async t => {
  const found = {items:[noAuth]};
  const freeTool = {...tool,no_auth:true};
  const {api,calls} = mock(t,[found,found,freeTool,found,{successful:true,error:null,data:{}},tool,freeTool,{items:[kit]}]);
  assert.deepEqual(await api.start({owner,toolkit,callbackURL}),{accountId:null,url:null});
  assert.deepEqual(await api.verify({owner,toolkit,accountId:null}),{active:true,status:'NO_AUTH'});
  const input = {...execute,accountId:null};
  assert.deepEqual(await api.execute(input),{data:{}});
  assert.deepEqual(calls[4].body,{user_id:owner,version:tool.version,arguments:{id:'42'}});
  await assert.rejects(api.execute(input),/requires a connected account/);
  await assert.rejects(api.execute(input),/Connect an account/);
});

test('invalid links, credentials, envelope overrides, route names and provider errors remain contained',async t => {
  const {api,calls} = mock(t,[
    {items:[kit]},{session_id:'trs_x'},{connected_account_id:accountId,redirect_url:'https://connect.composio.dev.example.com/link/ln_x'},
    {items:[kit]},
    new Response('private provider log\nsecret',{status:403}),
    new Response('sensitive provider trace',{status:429})
  ]);
  await assert.rejects(api.execute({...execute,custom_auth_params:{base_url:'https://example.com'}}),/execution parameters/);
  await assert.rejects(api.execute({...execute,slug:'proxy'}),/named catalog tool/);
  await assert.rejects(api.getTool('../proxy'),/Invalid Composio slug/);
  await assert.rejects(api.verify({owner,toolkit,accountId:'instant_account'}),/Invalid connected account ID/);
  assert.equal(calls.length,0);
  await assert.rejects(api.start({owner,toolkit,callbackURL}),/invalid sign-in link/);
  await assert.rejects(api.start({owner,toolkit,callbackURL:'http://insecure.example'}),/Invalid connector callback/);
  await assert.rejects(api.listToolkits({}),/^Error: Composio denied this request\./);
  await assert.rejects(api.listTools({}),/^Error: Composio is rate-limiting/);
});

test('the local dispatch guard sees completed remote preflight and can stop a write',async t => {
  const {api,calls} = mock(t,[tool,{items:[account]},tool,{items:[account]}]);
  let guardSaw;
  await assert.rejects(api.execute({...execute,beforeDispatch(verifiedTool) {
    assert.equal(verifiedTool.slug,tool.slug);
    assert.deepEqual(verifiedTool.inputSchema,tool.input_parameters);
    guardSaw = calls.map(c => c.method);
    throw Error('Workspace permission was revoked.');
  }}),/permission was revoked/);
  assert.deepEqual(guardSaw,['GET','GET']);
  await assert.rejects(api.execute({...execute,beforeDispatch:()=>Promise.resolve(false)}),/synchronous/);
  assert(calls.every(c => c.method === 'GET'));
});
