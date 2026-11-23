import assert from 'node:assert/strict';

export async function checkAccountRecovery(context, integrationsURL) {
  const tab=await context.newPage();
  const accountRoute='**/api/account';
  const directory=tab.getByRole('heading',{name:'Integrations',exact:true});
  let attempts=0;
  try {
    await tab.route(accountRoute,route=>{
      attempts++;
      if(attempts===1)return route.fulfill({status:502,contentType:'text/html',body:'Bad Gateway'});
      if(attempts===2)return route.fulfill({status:200,contentType:'application/json',body:'{"identity":'});
      return route.continue();
    });
    await tab.goto(integrationsURL);
    await directory.waitFor();
    assert.equal(attempts,3);
    assert.equal(tab.url(),integrationsURL);

    await tab.unroute(accountRoute);
    await tab.route(accountRoute,route=>route.fulfill({status:503,body:'Service unavailable'}));
    await tab.reload();
    await tab.getByRole('heading',{name:'Airport is temporarily unavailable'}).waitFor();
    assert.equal(await tab.getByRole('link',{name:'Sign in',exact:true}).count(),0);
    await tab.unroute(accountRoute);
    await tab.getByRole('button',{name:'Try again',exact:true}).click();
    await directory.waitFor();
    assert.equal(tab.url(),integrationsURL);

    attempts=0;
    await tab.route(accountRoute,route=>{
      attempts++;
      return route.fulfill({status:401,body:'Unauthorized'});
    });
    await tab.reload();
    await tab.getByRole('link',{name:'Sign in',exact:true}).waitFor();
    assert.equal(attempts,1);
  } finally {
    await tab.close();
  }
}
