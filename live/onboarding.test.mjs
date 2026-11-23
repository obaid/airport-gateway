import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const window = {};
runInNewContext(readFileSync(new URL('./ui/onboarding.js',import.meta.url),'utf8'),{window});
const guide = window.AirportOnboarding;
const personal = {id:'personal',name:'Personal'};
const work = {id:'work',name:'Work'};

function stateFor(tools) {
  return {
    workspaces:[personal,work],
    connections:[{id:'inbox',workspace:'personal',toolkit:'gmail',label:'My mailbox',status:'active',tools}],
    agentGrants:[{workspace:'personal',actor:'My assistant'}]
  };
}

test('a Gmail starter question uses the approved inbox tool on the selected account',()=>{
  const state = stateFor([
    {slug:'GMAIL_LIST_LABELS',name:'List labels',allowed:true,readOnly:true},
    {slug:'GMAIL_GET_LABEL',name:'Get label details',allowed:true,readOnly:true}
  ]);
  const model = guide.model(state,personal);
  assert.equal(model.stage,'request');
  assert.equal(model.read.slug,'GMAIL_GET_LABEL');
  const html = guide.view({w:personal,state,model,esc:String,href:String,icon:()=>'',mark:()=>'',agentLogo:()=>''});
  assert.match(html,/How many messages are unread in my Gmail inbox\?/);
  assert.match(html,/Use "My mailbox" in my "Personal" Airport workspace/);
  assert.equal(guide.model(state,work).stage,'connect');
});

test('custom or write-only access permits agent setup without offering an unverified read',()=>{
  const state = stateFor([{slug:'GMAIL_SEND_EMAIL',name:'Send email',allowed:true,readOnly:false}]);
  const model = guide.model(state,personal);
  assert.equal(model.stage,'request');
  assert.ok(!model.read);
  const html = guide.view({w:personal,state,model,esc:String,href:String,icon:()=>'',mark:()=>'',agentLogo:()=>''});
  assert.doesNotMatch(html,/id="setup-prompt"|data-manage="setup-copy"/);
  assert.equal(guide.model({...state,agentGrants:[]},personal).stage,'invite');
  assert.equal(guide.model(stateFor([]),personal).stage,'policy');
});

test('the completed guide shows the recorded route after the original agent and app have been removed',()=>{
  const receipt = {id:'receipt-1',actor:'Original assistant',at:'2026-01-02T03:04:05Z',tool:'c_example',
    exchange:{request:{connection:{id:'old',label:'My projects',toolkit:'github'},operation:{slug:'GITHUB_LIST_REPOSITORIES'}}}};
  const w = {...personal,firstAgentRequest:receipt};
  const state = stateFor([]);
  const model = guide.model(state,w);
  assert.equal(model.stage,'complete');
  const html = guide.view({w,state,model,esc:String,href:String,icon:()=>'',mark:()=>'',agentLogo:()=>'',when:String});
  assert.match(html,/Original assistant used My projects in Personal/);
  assert.match(html,/>List repositories</);
  assert.match(html,/#activity\/receipt-1/);
  assert.doesNotMatch(html,/My mailbox|My assistant/);
});
