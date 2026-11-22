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
    gateway=createHostedGateway(readHostedConfig({
      AIRPORT_OWNER_ORIGIN:origin,AIRPORT_AGENT_BASE:'https://mcp.example.test',
      AIRPORT_HOSTED_DATA_DIR:dir,AIRPORT_TENANT_SECRET:Buffer.alloc(32,10).toString('base64url'),
      AIRPORT_AUTH_MODE:'email',AIRPORT_SIGNUP_MODE:'open',AIRPORT_EMAIL_ACCOUNT_ID:'a'.repeat(32),
      AIRPORT_EMAIL_FROM:'signin@example.test',AIRPORT_EMAIL_API_TOKEN:'fixture',COMPOSIO_API_KEY:'fixture'
    }),{
      sendCode:async message=>{delivered=message;},provider:{},
      catalog:{listToolkits:async()=>({items:[],nextCursor:null})}
    });
    gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
    browser=await chromium.launch({headless:true,executablePath:process.env.AIRPORT_TEST_CHROMIUM || undefined,
      args:['--no-proxy-server','--host-resolver-rules=MAP airport-owner.test 127.0.0.1']});
    const ctx=await browser.newContext({ignoreHTTPSErrors:true});
    const page=await ctx.newPage();
    page.setDefaultTimeout(10_000);
    const errors=[];
    page.on('pageerror',err=>errors.push(err.message));
    await page.goto(origin);
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
