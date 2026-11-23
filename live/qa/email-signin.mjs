import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { createHostedGateway, readHostedConfig } from '../hosted.mjs';
import { firstWorkspaceJourney } from './onboarding.mjs';
import { checkAccountRecovery } from './account-recovery.mjs';

test('a customer signs in, creates an account, switches workspaces and signs out in Chromium',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'airport-browser-'));
  const key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
  let tls,gateway,browser;
  try {
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-keyout',key,'-out',cert],{stdio:'ignore'});
    tls=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
      const upstream=request({host:'127.0.0.1',port:gateway.address().port,path:req.url,method:req.method,headers:req.headers},r=>{
        res.writeHead(r.statusCode,r.headers);r.pipe(res);
      });
      upstream.on('error',()=>res.writeHead(502).end());
      req.pipe(upstream);
    });
    tls.listen(0,'127.0.0.1');await once(tls,'listening');
    const origin='https://airport-owner.test:'+tls.address().port;
    let delivered;
    const githubAuthorizations=new Map();
    const githubTools=[
      ['GITHUB_LIST_REPOSITORIES','List repositories','readOnlyHint'],
      ['GITHUB_CREATE_ISSUE','Create issue','createHint'],
      ['GITHUB_DELETE_REPOSITORY','Delete repository','destructiveHint']
    ].map(([slug,name,tag])=>({toolkit:'github',slug,name,description:name,
      tags:[tag],scopes:[],version:'20261101_00',inputSchema:{type:'object',properties:{},additionalProperties:false}}));
    const gmailTools=[
      ['GMAIL_GET_MESSAGE','Get message','readOnlyHint'],
      ['GMAIL_LIST_LABELS','List labels','readOnlyHint'],
      ['GMAIL_SEND_EMAIL','Send email','createHint']
    ].map(([slug,name,tag])=>({...githubTools[0],toolkit:'gmail',slug,name,description:name,tags:[tag]}));
    gateway=createHostedGateway(readHostedConfig({
      AIRPORT_OWNER_ORIGIN:origin,AIRPORT_AGENT_BASE:'https://mcp.example.test',
      AIRPORT_HOSTED_DATA_DIR:dir,AIRPORT_TENANT_SECRET:Buffer.alloc(32,10).toString('base64url'),
      AIRPORT_AUTH_MODE:'email',AIRPORT_SIGNUP_MODE:'open',AIRPORT_PUBLIC_BETA:'1',AIRPORT_BOOTSTRAP_OWNER_EMAIL:'admin@example.test',AIRPORT_EMAIL_ACCOUNT_ID:'a'.repeat(32),
      AIRPORT_EMAIL_FROM:'signin@example.test',AIRPORT_EMAIL_API_TOKEN:'fixture',COMPOSIO_API_KEY:'fixture'
    }),{
      sendCode:async message=>{delivered=message;},
      provider:{
        start:async owner=>({connectionId:'ca_'+owner,url:'https://connect.composio.dev/link/test-gmail'}),
        verify:async (owner,account)=>{assert.equal(account,'ca_'+owner);return {active:true,status:'ACTIVE',email:'pilot@example.test'};}
      },
      catalog:{
        listToolkits:async()=>({items:[{slug:'github',name:'GitHub',authSchemes:['OAUTH2']}],nextCursor:null}),
        listTools:async({toolkit,search,cursor,bulk})=>{
          if(toolkit==='gmail'){
            const matches=gmailTools.filter(t=>t.name.toLowerCase().includes((search||'').toLowerCase()));
            const start=Number(cursor||0),limit=bulk?matches.length:2;
            return {items:matches.slice(start,start+limit),total:matches.length,nextCursor:start+limit<matches.length?String(start+limit):null};
          }
          assert.equal(toolkit,'github');
          return {items:githubTools,nextCursor:null};
        },
        getTool:async slug=>[...githubTools,...gmailTools].find(tool=>tool.slug===slug),
        execute:async({owner,accountId,slug,version,beforeDispatch})=>{
          const auth=githubAuthorizations.get(accountId);
          assert.ok(auth?.approved);
          assert.equal(auth.owner,owner);
          const tool=githubTools.find(tool=>tool.slug===slug);
          assert.equal(tool?.slug,'GITHUB_LIST_REPOSITORIES');
          assert.equal(tool.version,version);
          beforeDispatch(tool);
          return {data:{items:[{name:'onboarding-example'}]}};
        },
        start:async({owner,toolkit,callbackURL})=>{
          assert.equal(toolkit,'github');
          const accountId='ca_browser_'+(githubAuthorizations.size+1);
          githubAuthorizations.set(accountId,{owner,callbackURL,approved:false});
          return {accountId,url:'https://connect.composio.dev/link/'+accountId};
        },
        verify:async({owner,toolkit,accountId})=>{
          const auth=githubAuthorizations.get(accountId);
          assert.equal(toolkit,'github');
          assert.equal(owner,auth.owner);
          return {active:auth.approved,status:auth.approved?'ACTIVE':auth.expired?'EXPIRED':'INITIATED'};
        }
      }
    });
    gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
    browser=await chromium.launch({headless:true,executablePath:process.env.AIRPORT_TEST_CHROMIUM || undefined,
      args:['--no-proxy-server','--host-resolver-rules=MAP airport-owner.test 127.0.0.1']});
    const ctx=await browser.newContext({ignoreHTTPSErrors:true});
    const page=await ctx.newPage();
    page.setDefaultTimeout(10_000);
    const errors=[];
    page.on('pageerror',err=>errors.push(err.message));
    const personal=origin+'/w/personal',work=origin+'/w/work';
    const githubDirectory=work+'/integrations?app=github';
    await page.goto(githubDirectory);
    await page.getByLabel('Email address').fill('pilot@example.test');
    await page.getByRole('button',{name:'Send code'}).click();
    const code=page.getByLabel('Eight-digit code');
    await code.waitFor();
    assert.equal(delivered.email,'pilot@example.test');
    await page.reload();
    await code.fill(delivered.code==='00000000'?'00000001':'00000000');
    await page.getByRole('button',{name:'Continue'}).click();
    await page.getByText('That code is incorrect',{exact:false}).waitFor();
    await code.fill(delivered.code);
    await page.getByRole('button',{name:'Continue'}).click();
    await page.getByLabel('Display name').fill('Local Pilot');
    await page.getByRole('button',{name:'Create account'}).click();
    await page.getByRole('button',{name:'Account menu for Local Pilot'}).waitFor();
    await page.waitForURL(githubDirectory);
    await page.getByRole('heading',{name:'GitHub',exact:true}).first().waitFor();
    assert.equal(await page.locator('#workspace-name').textContent(),'Work');

    await t.test('a gateway interruption during account loading preserves the signed-in integrations link',
      ()=>checkAccountRecovery(ctx,personal+'/integrations'));

    await t.test('temporary gateway failures recover on the Personal integrations page',async()=>{
      const view=await ctx.newPage();
      try{
        let stateAvailable=false,malformedState=false,catalogAvailable=false,remainingCatalogFailures=0;
        const down=route=>route.fulfill({status:502,contentType:'text/html',body:'Bad gateway'});
        await view.route('**/api/state',route=>{
          if(malformedState)return route.fulfill({status:200,contentType:'text/html',body:'Reconnecting'});
          return stateAvailable?route.continue():down(route);
        });
        await view.route('**/api/catalog',route=>{
          if(!catalogAvailable)return down(route);
          if(remainingCatalogFailures){remainingCatalogFailures--;return down(route);}
          return route.continue();
        });
        await view.goto(personal+'/integrations');
        const retryWorkspace=view.getByRole('button',{name:'Retry now'});
        await retryWorkspace.waitFor();
        assert.equal(await view.locator('#gateway-status').textContent(),'Reconnecting');
        assert.equal(await view.locator('#gateway-light').isVisible(),false);
        stateAvailable=true;
        await retryWorkspace.click();
        const retryCatalog=view.getByRole('button',{name:'Retry live catalog'});
        await retryCatalog.waitFor();
        await view.getByRole('heading',{name:'Popular integrations'}).waitFor();
        assert.equal(await view.locator('#network').isVisible(),false);
        const search=view.getByRole('searchbox',{name:'Search'});
        await search.fill('github');
        const result=view.locator('.int-results').getByRole('link',{name:/GitHub/});
        await result.waitFor();

        // A single missed poll keeps search usable. Continued failures surface retry.
        stateAvailable=false;
        await Promise.all([
          view.waitForResponse(r=>r.url()===origin+'/api/state' && r.status()===502),
          view.evaluate(()=>window.dispatchEvent(new Event('focus')))
        ]);
        assert.equal(await view.locator('#network').isVisible(),false);
        malformedState=true;
        await view.getByText(/Workspace updates are temporarily delayed/).waitFor();
        assert.equal(await search.inputValue(),'github');
        malformedState=false;
        stateAvailable=true;
        await retryWorkspace.click();
        await retryWorkspace.waitFor({state:'hidden'});
        assert.equal(await view.locator('#gateway-status').textContent(),'Live gateway');
        assert.equal(await view.locator('#gateway-light').isVisible(),true);
        catalogAvailable=true;
        remainingCatalogFailures=1;
        await retryCatalog.click();
        await retryCatalog.waitFor({state:'hidden'});
        assert.equal(remainingCatalogFailures,0);
        assert.equal(await search.inputValue(),'github');

        catalogAvailable=false;
        await result.click();
        const availability=view.getByRole('button',{name:'Check live availability'});
        await availability.waitFor();
        await view.getByRole('heading',{name:'Accounts in Personal'}).waitFor();
        const connect=view.getByRole('button',{name:'Connect account'});
        assert.equal(await connect.isEnabled(),false);
        catalogAvailable=true;
        remainingCatalogFailures=1;
        await availability.click();
        await availability.waitFor({state:'hidden'});
        await view.waitForFunction(()=>document.querySelector('[data-connect-integration]')?.disabled===false);
        assert.equal(await connect.isEnabled(),true);
        await view.route('**/api/catalog',route=>route.fulfill({status:401,body:'Expired'}));
        await view.getByRole('navigation',{name:'Workspace pages'}).getByRole('link',{name:'Integrations'}).click();
        await view.getByText('Sign-in required',{exact:true}).waitFor();
        assert.equal(await view.locator('#network').isVisible(),true);
        assert.equal(await retryWorkspace.isVisible(),false);
        assert.equal(await view.locator('#gateway-light').isVisible(),false);
      }finally{await view.close();}
    });

    await t.test('workspace links open independently in two tabs and account settings are global',async ()=>{
      const sidebar=page.getByRole('navigation',{name:'Workspace pages'});
      const workConnections=await sidebar.getByRole('link',{name:'Connections'}).evaluate(a=>a.href);
      assert.equal(workConnections,work+'/connections');

      const workTab=await ctx.newPage();
      try{
        await workTab.goto(workConnections);
        await workTab.getByRole('heading',{name:'Connections',exact:true}).waitFor();
        await page.goto(personal+'/overview?workspace=work');
        await page.waitForURL(personal+'/setup');
        await page.getByRole('button',{name:'Skip setup for now'}).click();
        await page.waitForURL(personal+'/overview');
        await page.getByRole('heading',{name:'Workspace overview',exact:true}).waitFor();
        await workTab.reload();
        await workTab.getByRole('heading',{name:'Connections',exact:true}).waitFor();
        assert.equal(await workTab.locator('#workspace-name').textContent(),'Work');
        assert.equal(await page.locator('#workspace-name').textContent(),'Personal');
        assert.equal(page.url(),personal+'/overview');
        assert.equal(await sidebar.getByRole('link',{name:'Connections'}).evaluate(a=>a.href),personal+'/connections');

        await workTab.getByRole('button',{name:'Account menu for Local Pilot'}).click();
        const settings=workTab.getByRole('link',{name:'Account settings',exact:true});
        assert.equal(await settings.evaluate(a=>a.href),origin+'/account');
        await settings.click();
        await workTab.waitForURL(origin+'/account');
        await workTab.goBack();
        await workTab.waitForURL(workConnections);
        assert.equal(await workTab.locator('#workspace-name').textContent(),'Work');
      }finally{
        await workTab.close();
      }
    });
    await t.test('an invited agent keeps its selected icon across the dashboard',async ()=>{
      const nickname='Weekend planner',brand='img[src="/assets/agents/grok-bot.png"]';
      await page.getByRole('link',{name:'Agents',exact:true}).click();
      await page.getByRole('button',{name:'Add agent',exact:true}).click();
      const invite=page.locator('#create-agent-invitation');
      const name=invite.getByLabel('Agent name (optional)'),client=invite.getByLabel('Agent icon');
      await name.fill('Lighthouse');
      assert.equal(await invite.locator('.agent-icon-letter').textContent(),'L');
      await name.fill('');
      await client.selectOption('muse');
      assert.equal(await name.inputValue(),'Personal Muse');
      await client.selectOption('grok-bot');
      assert.equal(await name.inputValue(),'');
      await name.fill(nickname);
      await invite.locator(brand).waitFor();
      await invite.getByRole('button',{name:'Create setup prompt'}).click();
      const prompt=await page.locator('#enrollment-prompt').inputValue();
      const registration=prompt.match(/POST JSON to (\S+) with this body: (\{.*?\})\./);
      assert.ok(registration,'setup prompt includes a registration URL and body');
      await page.getByRole('button',{name:'Done',exact:true}).click();
      await page.locator('[data-manage="inspect-agent-invite"]').filter({hasText:nickname}).locator(brand).waitFor();

      const url=new URL(registration[1]);
      const registered=await ctx.request.post('http://127.0.0.1:'+gateway.address().port+url.pathname,{
        headers:{host:url.host},data:JSON.parse(registration[2])
      });
      assert.equal(registered.status(),200);
      const credential=await registered.json();
      const countsPath=url.pathname.replace(/\/agents\/register$/,'/api/gmail/inbox-counts');
      const counts=await ctx.request.get('http://127.0.0.1:'+gateway.address().port+countsPath,{
        headers:{host:url.host,authorization:'Bearer '+credential.token}
      });
      assert.equal(counts.status(),403);
      await page.reload();
      const row=page.locator('.rg-agent').filter({hasText:nickname});
      await row.locator(brand).waitFor();
      await row.click();
      await page.locator('dd').filter({hasText:nickname}).locator(brand).waitFor();
      await page.locator('.rg-request').filter({hasText:'Blocked'}).locator(brand).waitFor();
      await page.getByRole('link',{name:'Overview',exact:true}).click();
      await page.locator('.map-node').filter({hasText:nickname}).locator(brand).waitFor();
      const recent=page.locator('.feed-row').filter({hasText:nickname});
      await recent.locator(brand).waitFor();
      assert.ok(await recent.locator(brand).evaluate(img=>img.complete && img.naturalWidth>0));
      const trace=page.getByLabel('Trace request');
      await trace.selectOption(await trace.locator('option').filter({hasText:'Blocked'}).getAttribute('value'));
      await page.locator('[data-node="trace-actor"]').locator(brand).waitFor();
      await recent.click();
      await page.locator('.audit-actor').filter({hasText:nickname}).locator(brand).waitFor();

      await page.getByRole('link',{name:'Agents',exact:true}).click();
      await page.getByRole('button',{name:'Add agent',exact:true}).click();
      await page.getByText('Connect with a bearer token instead').click();
      const direct=page.locator('#named-agent');
      await direct.getByLabel('Agent name',{exact:true}).fill('Duet');
      await direct.getByLabel('Agent icon').selectOption('custom');
      assert.equal(await direct.locator('.agent-icon-letter').textContent(),'D');
      await direct.getByRole('button',{name:'Issue agent credential'}).click();
      await page.getByRole('button',{name:'Done',exact:true}).click();
      assert.equal(await page.locator('.rg-agent').filter({hasText:'Duet'}).locator('.agent-icon-letter').textContent(),'D');
    });
    const searchTools=page.getByRole('searchbox',{name:'Search tools'});
    const advancedLink=page.getByRole('link',{name:/Customize individual tools/i});
    await t.test('Gmail opens with presets and preserves independent grants across advanced navigation',async ()=>{
      const owner=async (action,data={})=>{
        const response=await ctx.request.post(origin+'/api/'+action,{
          headers:{'x-airport-console':'1'},data:{workspace:'personal',...data}
        });
        assert.equal(response.status(),200);
        return response.json();
      };
      await owner('connect',{expectedEmail:'pilot@example.test'});
      assert.equal((await owner('check')).status,'active');
      await owner('policy',{policy:'Allow'});
      const toolsURL=personal+'/connections/pilot-gmail/tools';
      const advancedURL=toolsURL+'/advanced';
      await page.goto(personal+'/overview');
      await page.getByRole('heading',{name:'Workspace overview',exact:true}).waitFor();
      await page.goto(origin+'/#connection/pilot-gmail/tools/advanced?workspace=personal');
      await page.waitForURL(advancedURL);
      await searchTools.waitFor();
      await page.goBack();
      await page.waitForURL(personal+'/overview');
      await page.goto(toolsURL);
      await page.reload();
      const control=slug=>page.locator('[data-cp-tool="'+slug+'"]');
      const readOnly=page.locator('[data-access-preset="read-only"]');
      await readOnly.waitFor();
      assert.equal(await readOnly.isChecked(),true);
      assert.deepEqual(await page.locator('[data-access-preset]').evaluateAll(inputs=>inputs.map(input=>input.value)),
        ['read-only','write-only','read-write']);
      assert.equal(await searchTools.count(),0);
      assert.equal(await advancedLink.evaluate(a=>a.href),advancedURL);
      await advancedLink.click();
      await page.waitForURL(advancedURL);
      await searchTools.waitFor();
      await page.goBack();
      await page.waitForURL(toolsURL);
      await readOnly.waitFor();
      assert.equal(await searchTools.count(),0);
      await page.goForward();
      await page.waitForURL(advancedURL);
      assert.equal(await control('gmail_inbox_counts').inputValue(),'allow');
      assert.equal(await control('GMAIL_GET_MESSAGE').inputValue(),'block');
      await page.getByRole('button',{name:'Next',exact:true}).click();
      assert.equal(await control('GMAIL_SEND_EMAIL').inputValue(),'block');
      await searchTools.fill('labels');
      await control('GMAIL_LIST_LABELS').selectOption('allow');
      await page.getByRole('link',{name:'Access presets'}).click();
      await page.getByText(/1 unsaved tool change/).waitFor();
      assert.equal(await page.locator('[data-access-apply]').isDisabled(),true);
      await advancedLink.click();
      assert.equal(await control('GMAIL_LIST_LABELS').inputValue(),'allow');
      await page.getByRole('button',{name:'Save changes'}).click();
      await page.getByText('1 change saved.',{exact:true}).waitFor();
      await page.reload();
      assert.equal(await control('GMAIL_LIST_LABELS').inputValue(),'allow');
      assert.equal(await control('GMAIL_GET_MESSAGE').inputValue(),'block');
      assert.equal(await control('gmail_inbox_counts').inputValue(),'allow');
      assert.equal(page.url(),advancedURL);
      await page.getByRole('link',{name:'Access presets'}).click();
      await page.waitForURL(toolsURL);
      await readOnly.check();
      await page.getByRole('button',{name:'Apply read only'}).click();
      await page.getByText(/Read only · 2 catalog tools allowed/).waitFor();
      await advancedLink.click();
      assert.equal(await control('GMAIL_GET_MESSAGE').inputValue(),'allow');
      assert.equal(await control('gmail_inbox_counts').inputValue(),'allow');
      assert.equal(page.url(),advancedURL);

      await page.getByRole('link',{name:'Policies',exact:true}).click();
      await page.getByRole('link',{name:'Advanced tool editor',exact:true}).waitFor();
      assert.equal(await searchTools.count(),0);
      await page.getByRole('link',{name:'Advanced tool editor',exact:true}).click();
      await searchTools.waitFor();
      assert.equal(page.url(),personal+'/policies?view=advanced');
      await page.reload();
      await searchTools.waitFor();
      assert.equal(await page.locator('#workspace-name').textContent(),'Personal');
      await page.getByRole('link',{name:'Back to access presets',exact:true}).click();
      await page.getByRole('link',{name:'Advanced tool editor',exact:true}).waitFor();
      assert.equal(await searchTools.count(),0);
    });
    const workspaceButton=page.locator('#ws-button');
    const workspaceMenu=page.locator('#workspace-menu');
    await workspaceButton.click();
    await page.locator('#page-title').click();
    assert.equal(await workspaceMenu.isVisible(),false);
    await workspaceButton.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await workspaceMenu.locator('button:focus').getAttribute('data-workspace'),'personal');
    await page.keyboard.press('ArrowDown');
    assert.equal(await workspaceMenu.locator('button:focus').getAttribute('data-workspace'),'work');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.getElementById('workspace-name').textContent==='Work');
    assert.equal(await workspaceMenu.isVisible(),false);
    assert.equal(page.url(),work+'/policies');
    await ctx.route('https://connect.composio.dev/link/ca_browser_*',route=>
      route.fulfill({contentType:'text/html',body:'<title>Provider sign-in fixture</title>'}));
    for(const returnsToAirport of [true,false]){
      const label=returnsToAirport?'GitHub callback':'GitHub closed tab';
      await t.test(label+' activates in Work without a manual check',async ()=>{
        await page.goto(returnsToAirport?origin+'/integrations/github':githubDirectory);
        await page.waitForURL(returnsToAirport?personal+'/integrations/github':githubDirectory);
        await page.getByRole('button',{name:'Connect account',exact:true}).click();
        const form=page.locator('#toolkit-add');
        if(returnsToAirport){
          assert.equal(await form.getByRole('combobox',{name:'Workspace',exact:true}).inputValue(),'personal');
          await form.getByRole('combobox',{name:'Workspace',exact:true}).selectOption('work');
        } else {
          // A browser may decline automatic popups. The original link must still work.
          await page.evaluate(()=>{window.open=()=>null;});
        }
        await form.getByRole('textbox').fill(label);
        const popupPromise=returnsToAirport?ctx.waitForEvent('page'):null;
        const [added]=await Promise.all([
          page.waitForResponse(r=>r.url()===origin+'/api/connection-add'),
          form.getByRole('button',{name:'Continue to sign-in'}).click()
        ]);
        assert.equal(added.status(),200);
        const {connectionId,url,status}=await added.json();
        assert.equal(status,'pending');
        const connectionURL=work+'/connections/'+connectionId;
        const settings=connectionURL+'/settings';
        const toolsURL=connectionURL+'/tools';
        const advancedURL=toolsURL+'/advanced';
        const popup=popupPromise?await popupPromise:(await Promise.all([
          ctx.waitForEvent('page'),page.getByRole('link',{name:/Open sign-in/}).click()
        ]))[0];
        await popup.waitForURL(url);
        const accountId=new URL(url).pathname.split('/').pop();
        const auth=githubAuthorizations.get(accountId);
        auth.approved=true;
        if(returnsToAirport){
          const callback=new URL(auth.callbackURL);
          callback.searchParams.set('status','success');
          callback.searchParams.set('connected_account_id',accountId);
          await popup.goto(callback.href);
          await popup.waitForURL(toolsURL);
          await popup.locator('[data-access-preset="read-only"]').waitFor();
        }
        await popup.close();
        await page.bringToFront();
        await page.getByRole('heading',{name:'Connection verified'}).waitFor({timeout:35_000});
        await page.getByRole('dialog').getByRole('link',{name:'Choose tool access'}).click();
        await page.waitForURL(toolsURL);
        assert.equal(await page.locator('#workspace-name').textContent(),'Work');
        assert.equal(await page.locator('dialog[open]').count(),0);
        const access=page.locator('[data-access-setup]');
        assert.equal(await access.locator('[data-access-preset="read-only"]').isChecked(),true);
        await access.getByText('1 tool will be allowed.',{exact:true}).waitFor();
        assert.equal(await searchTools.count(),0);
        if(!returnsToAirport)return;

        const applyPreset=async mode=>{
          await access.locator('[data-access-preset="'+mode+'"]').check();
          const [saved]=await Promise.all([
            page.waitForResponse(r=>r.url()===origin+'/api/connection-access-apply'),
            access.locator('[data-access-apply]').click()
          ]);
          assert.equal(saved.status(),200);
          return saved.json();
        };
        for(const [mode,expected] of [['read-only',1],['write-only',1],['read-write',2]]){
          const result=await applyPreset(mode);
          assert.equal(result.allowed,expected);
        }
        await access.getByText(/Read and write · 2 tools allowed/).waitFor();
        await advancedLink.click();
        await page.waitForURL(advancedURL);
        const toolControl=slug=>page.locator('[data-cp-tool="'+slug+'"]');
        assert.equal(await toolControl('GITHUB_LIST_REPOSITORIES').inputValue(),'allow');
        assert.equal(await toolControl('GITHUB_CREATE_ISSUE').inputValue(),'allow');
        assert.equal(await toolControl('GITHUB_DELETE_REPOSITORY').inputValue(),'block');
        await page.goBack();
        await page.waitForURL(toolsURL);
        await access.getByText(/Read and write · 2 tools allowed/).waitFor();
        await advancedLink.click();
        await toolControl('GITHUB_CREATE_ISSUE').selectOption('block');
        await page.getByRole('button',{name:'Save changes'}).click();
        await page.getByText('1 change saved.',{exact:true}).waitFor();
        await page.getByRole('link',{name:'Access presets'}).click();
        await access.getByText(/Custom · 1 tool allowed/).waitFor();
        await page.goto(settings);
        await page.locator('.cp-facts dd').filter({hasText:/^Connected$/}).waitFor();
        assert.equal(await page.locator('.cp-label-value').textContent(),label);
        await page.getByRole('navigation',{name:'Workspace pages'}).getByRole('link',{name:'Connections',exact:true}).click();
        await page.locator('.rg-account').filter({hasText:label}).click();
        await page.waitForURL(toolsURL);
        await access.getByText(/Custom · 1 tool allowed/).waitFor();
      });
    }
    await t.test('only the verified platform owner can open the aggregate dashboard',async ()=>{
      assert.equal(await page.getByRole('link',{name:'Admin',exact:true}).count(),0);
      const customerResponse=await ctx.request.get(origin+'/api/admin/overview');
      assert.ok([403,404].includes(customerResponse.status()));
      assert.ok([403,404].includes((await ctx.request.get(origin+'/admin')).status()));

      const adminContext=await browser.newContext({ignoreHTTPSErrors:true});
      try{
        const admin=await adminContext.newPage();
        admin.on('pageerror',err=>errors.push(err.message));
        await admin.goto(origin+'/login');
        await admin.getByLabel('Email address').fill('admin@example.test');
        await admin.getByRole('button',{name:'Send code'}).click();
        const verification=admin.getByLabel('Eight-digit code');
        await verification.waitFor();
        await verification.fill(delivered.code);
        await admin.getByRole('button',{name:'Continue',exact:true}).click();
        await admin.getByLabel('Display name').fill('Airport operator');
        await admin.getByRole('button',{name:'Create account',exact:true}).click();
        const adminLink=admin.getByRole('link',{name:'Admin',exact:true});
        await adminLink.waitFor();
        assert.equal(await adminLink.evaluate(el=>el.href),origin+'/admin');
        const [report]=await Promise.all([
          admin.waitForResponse(r=>r.url()===origin+'/api/admin/overview'),
          adminLink.click()
        ]);
        assert.equal(report.status(),200);
        const overview=await report.json();
        assert.equal(overview.totals.users,2);
        assert.ok(overview.totals.workspaces>=2);
        assert.equal(overview.totals.connections,3);
        await admin.getByRole('heading',{name:'Platform admin',exact:true}).waitFor();
        await admin.getByText('Registered users',{exact:true}).waitFor();
        await admin.getByRole('heading',{name:'Public beta usage'}).waitFor();
        assert.equal(overview.beta.limit,1000);
        assert.ok(overview.beta.engagement);
        if(overview.beta.daily.length){
          await admin.getByText('Daily usage',{exact:true}).click();
          await admin.getByRole('columnheader',{name:'Date (Pacific)'}).waitFor();
        }
        if(process.env.AIRPORT_BETA_SCREENSHOTS){
          await admin.evaluate(()=>document.fonts.ready);
          await admin.screenshot({path:join(process.env.AIRPORT_BETA_SCREENSHOTS,'beta-admin.png'),animations:'disabled'});
        }
        await admin.reload();
        await admin.getByText('Registered users',{exact:true}).waitFor();
        assert.equal(admin.url(),origin+'/admin');
      }finally{await adminContext.close();}
    });
    await t.test('a failed start and an expired authorization can retry in the chosen workspace',async ()=>{
      await page.goto(work+'/integrations/github');
      await page.getByRole('button',{name:'Connect account',exact:true}).click();
      const form=page.locator('#toolkit-add');
      await form.getByRole('textbox').fill('Retry account');
      await page.route('**/api/connection-add',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'The provider is temporarily unavailable.'})}),{times:1});
      await page.evaluate(()=>{window.open=()=>null;});
      await form.getByRole('button',{name:'Continue to sign-in'}).click();
      await form.getByRole('alert').filter({hasText:'The provider is temporarily unavailable.'}).waitFor();
      assert.equal(await form.getByRole('textbox').inputValue(),'Retry account');
      assert.equal(await form.getByRole('combobox',{name:'Workspace',exact:true}).inputValue(),'work');
      const [res]=await Promise.all([
        page.waitForResponse(r=>r.url()===origin+'/api/connection-add'),
        form.getByRole('button',{name:'Continue to sign-in'}).click()
      ]);
      const attempt=await res.json();
      githubAuthorizations.get(new URL(attempt.url).pathname.split('/').pop()).expired=true;
      await page.getByRole('button',{name:'Check status'}).click();
      await page.getByRole('heading',{name:'Sign-in incomplete'}).waitFor();
      await page.getByRole('button',{name:'Try again'}).click();
      assert.equal(await form.getByRole('textbox').inputValue(),'Retry account');
      assert.equal(await form.getByRole('combobox',{name:'Workspace',exact:true}).inputValue(),'work');
      await form.getByRole('button',{name:'Cancel'}).click();
    });
    await t.test('a new workspace guides a customer to its first agent request',async ()=>{
      await firstWorkspaceJourney({browser,origin,gateway,githubAuthorizations,delivery:()=>delivered});
    });
    await page.getByRole('button',{name:'Account menu for Local Pilot'}).click();
    await page.getByRole('link',{name:'Sign out'}).click();
    await page.getByLabel('Email address').waitFor();
    assert.equal(await page.evaluate(async ()=>(await fetch('/api/state')).status),401);
    assert.equal((await ctx.cookies()).some(c=>c.name==='__Host-airport_session'),false);
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();
    for (const server of [tls,gateway]) {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise(resolve=>server.close(resolve));
      }
    }
    rmSync(dir,{recursive:true,force:true});
  }
});
