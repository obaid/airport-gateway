import assert from 'node:assert/strict';
import { join } from 'node:path';

async function capture(page, name) {
  const dir = process.env.AIRPORT_ONBOARDING_SCREENSHOTS;
  if (dir) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(dir, name + '.png'), animations: 'disabled' });
  }
}

export async function firstWorkspaceJourney({ browser, origin, gateway, githubAuthorizations, delivery }) {
  const context = await browser.newContext({ignoreHTTPSErrors:true, viewport:{width:1440, height:1000}});
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const email = 'first-flight@example.test';
    const personal = origin + '/w/personal';
    const stage = name => page.locator('[data-setup-stage="' + name + '"]:visible');
    const guideAction = name => page.locator('[data-setup-action="' + name + '"]:visible');
    const viewerState = async () => {
      const response = await context.request.get(origin + '/api/state');
      assert.equal(response.status(), 200);
      return response.json();
    };
    const firstRequest = (state, workspace = 'personal') =>
      state.workspaces.find(item => item.id === workspace).firstAgentRequest;

    await page.goto(origin);
    await page.getByLabel('Email address').fill(email);
    await page.getByRole('button', {name:'Send code'}).click();
    const code = page.getByLabel('Eight-digit code');
    await code.waitFor();
    assert.equal(delivery().email, email);
    await code.fill(delivery().code);
    await page.getByRole('button', {name:'Continue', exact:true}).click();
    await page.getByLabel('Display name').fill('Casey');
    await page.getByRole('button', {name:'Create account'}).click();
    await stage('connect').waitFor();
    await page.waitForURL(personal + '/setup');
    assert.equal(await page.locator('#workspace-name').textContent(), 'Personal');
    await capture(page, 'airport-onboarding-desktop');
    await page.setViewportSize({width:390, height:844});
    await stage('connect').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const primary = await page.locator('[data-manage="setup-connect"]:visible').boundingBox();
    assert.ok(primary && primary.y + primary.height <= 844, 'The first action fits on a mobile screen');
    await capture(page, 'airport-onboarding-mobile');
    await page.setViewportSize({width:1440, height:1000});

    await page.locator('[data-manage="setup-dismiss"]:visible').click();
    await stage('connect').waitFor({state:'hidden'});
    await page.reload();
    await page.getByRole('heading', {name:'Workspace overview', exact:true}).waitFor();
    assert.equal(await stage('connect').count(), 0);
    await page.getByRole('link', {name:'Setup guide', exact:true}).first().click();
    await page.waitForURL(personal + '/setup');
    await stage('connect').waitFor();
    await page.getByLabel('Setup workspace').selectOption('work');
    await page.waitForURL(origin + '/w/work/setup');
    await stage('connect').getByText(/Your Personal accounts stay separate/).waitFor();
    await page.getByLabel('Setup workspace').selectOption('personal');
    await page.waitForURL(personal + '/setup');
    await page.locator('#setup-app-choice').selectOption('github');
    await page.locator('[data-manage="setup-connect"][data-id="github"]').click();
    const form = page.locator('#toolkit-add');
    assert.equal(await form.getByRole('combobox', {name:'Workspace', exact:true}).inputValue(), 'personal');
    const label = 'Personal GitHub';
    await form.getByRole('textbox').fill(label);
    await context.route('https://connect.composio.dev/link/ca_browser_*', route =>
      route.fulfill({contentType:'text/html', body:'<title>Provider sign-in fixture</title>'}));
    const [popup, started] = await Promise.all([
      context.waitForEvent('page'),
      page.waitForResponse(response => response.url() === origin + '/api/connection-add'),
      form.getByRole('button', {name:'Continue to sign-in'}).click()
    ]);
    assert.equal(started.status(), 200);
    const {url, connectionId, status} = await started.json();
    assert.equal(status, 'pending');
    await popup.waitForURL(url);
    const account = new URL(url).pathname.split('/').pop();
    const auth = githubAuthorizations.get(account);
    auth.approved = true;
    const callback = new URL(auth.callbackURL);
    callback.searchParams.set('status', 'success');
    callback.searchParams.set('connected_account_id', account);
    const policyURL = personal + '/connections/' + connectionId + '/tools';
    await popup.goto(callback.href);
    await popup.waitForURL(policyURL);
    await popup.close();
    await page.bringToFront();
    await page.getByRole('heading', {name:'Connection verified'}).waitFor({timeout:35_000});
    await page.getByRole('dialog').getByRole('link', {name:'Choose tool access'}).click();
    await page.waitForURL(policyURL);
    // A verified provider account still needs an explicit tool policy.
    await guideAction('continue').click();
    await stage('policy').waitFor();
    await page.reload();
    await stage('policy').waitFor();
    await guideAction('policy').click();
    await page.waitForURL(policyURL);
    const preset = page.locator('[data-access-setup]');
    assert.equal(await preset.locator('[data-access-preset="read-only"]').isChecked(), true);
    const savePreset = async mode => {
      await preset.locator('[data-access-preset="' + mode + '"]').check();
      const [saved] = await Promise.all([
        page.waitForResponse(response => response.url() === origin + '/api/connection-access-apply'),
        preset.locator('[data-access-apply]').click()
      ]);
      assert.equal(saved.status(), 200);
      assert.equal((await saved.json()).allowed, 1);
      await guideAction('continue').click();
    };
    await savePreset('write-only');
    await stage('invite').waitFor();
    assert.equal((await viewerState()).connections.find(c => c.id === connectionId).accessMode, 'write-only');

    await page.locator('[data-manage="setup-invite"]').click();
    const agentName = 'Casey’s assistant';
    const invite = page.locator('#create-agent-invitation');
    await invite.getByLabel('Agent name (optional)').fill(agentName);
    await invite.getByRole('button', {name:'Create setup prompt'}).click();
    const prompt = await page.locator('#enrollment-prompt').inputValue();
    const register = prompt.match(/POST JSON to (\S+) with this body: (\{.*?\})\./);
    assert.ok(register, 'An agent can register using the instruction issued by Airport');
    const destination = new URL(register[1]);
    assert.equal(destination.hostname, 'mcp.example.test');
    const local = 'http://127.0.0.1:' + gateway.address().port;
    const headers = {host:destination.host};
    await page.getByRole('button', {name:'Done', exact:true}).click();
    await page.reload();
    await stage('invite').waitFor();
    const registration = await context.request.post(local + destination.pathname, {
      headers, data:JSON.parse(register[2])
    });
    assert.equal(registration.status(), 200);
    const {token} = await registration.json();
    assert.ok(token);
    const mcp = local + destination.pathname.replace(/\/agents\/register$/, '/mcp');
    const rpc = async (method, params) => {
      const response = await context.request.post(mcp, {
        headers:{...headers, authorization:'Bearer ' + token},
        data:{jsonrpc:'2.0', id:1, method, params}
      });
      assert.equal(response.status(), 200);
      const payload = await response.json();
      assert.ok(payload.result, JSON.stringify(payload.error));
      return payload.result;
    };
    await stage('request').getByRole('heading', {name:'Try your workspace policy'}).waitFor();
    assert.equal(await page.locator('#setup-prompt').count(), 0);
    await guideAction('policy').click();
    await savePreset('read-only');
    await stage('request').waitFor();
    const promptText = await page.locator('#setup-prompt').inputValue();
    assert.match(promptText, /GitHub/i);
    assert.match(promptText, /repositor/i);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin});
    await page.locator('[data-manage="setup-copy"]').click();
    await page.getByText('Request copied', {exact:true}).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), promptText);
    const inventory = await rpc('tools/call', {name:'airport_list_connections', arguments:{}});
    assert.deepEqual(inventory.structuredContent, {
      workspace:'Personal', connections:[{label, toolkit:'github', allowedToolCount:1}]
    });
    const denied = await rpc('tools/call', {name:'gmail_send_email', arguments:{}});
    assert.equal(denied.isError, true);
    assert.equal(firstRequest(await viewerState()), null);
    await page.reload();
    await stage('request').getByRole('link', {name:'View the attempt in Activity'}).waitFor();
    const tools = (await rpc('tools/list', {})).tools;
    const read = tools.find(tool => tool.title === label + ' · List repositories');
    assert.ok(read);
    const result = await rpc('tools/call', {name:read.name, arguments:{}});
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, {data:{items:[{name:'onboarding-example'}]}});
    await stage('complete').waitFor();

    const state = await viewerState();
    const receipt = firstRequest(state);
    assert.equal(receipt.actor, agentName);
    assert.equal(receipt.workspace, 'personal');
    assert.equal(receipt.tool, read.name);
    assert.equal(receipt.providerCalled, true);
    assert.equal(receipt.exchange.channel, 'mcp');
    assert.equal(receipt.exchange.response.dispatched, true);
    assert.equal(firstRequest(state, 'work'), null);
    await capture(page, 'airport-onboarding-complete');
    await guideAction('receipt').click();
    await page.waitForURL(personal + '/activity/' + receipt.id);
    await page.getByRole('heading', {name:'Request details', exact:true}).waitFor();
    await page.reload();
    await page.getByRole('heading', {name:'Request details', exact:true}).waitFor();
    assert.match(await page.locator('#main').innerText(), /Allowed/);
    assert.match(await page.locator('#main').innerText(), /Casey’s assistant/);
    await page.goto(origin + '/w/work/setup');
    await stage('connect').waitFor();
    await page.goto(personal + '/overview');
    await page.getByRole('heading', {name:'Workspace overview', exact:true}).waitFor();
    assert.equal(await stage('connect').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
