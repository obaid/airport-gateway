import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

async function expectLogo(image, expected) {
  await image.waitFor();
  assert.equal(await image.getAttribute('alt'),'');
  const src=await image.evaluate(async img=>{
    await img.decode();
    return img.naturalWidth && img.naturalHeight ? img.currentSrc : '';
  });
  assert.equal(src,expected);
}

export async function checkIntegrationIcons(context, integrationsURL) {
  const view=await context.newPage();
  view.setDefaultTimeout(8_000);
  const origin=new URL(integrationsURL).origin;
  const provider='https://logos.composio.dev/api/';
  const apps=[
    {slug:'linear',name:'Linear',logo:provider+'linear'},
    {slug:'fixture_clock',name:'Fixture Clock',logo:provider+'fixture_clock'},
    {slug:'fixture_archive',name:'Archive Box',logo:provider+'fixture_archive'}
  ];
  try {
    await view.route('https://logos.composio.dev/**',route=>{
      if(route.request().url()===provider+'fixture_clock'){
        return route.fulfill({contentType:'image/png',body:readFileSync(new URL('../../dist/agents/muse.png',import.meta.url))});
      }
      return route.fulfill({status:404});
    });
    await view.route('**/api/catalog',route=>{
      const search=route.request().postDataJSON().search?.toLowerCase() || '';
      const items=search ? apps.filter(a=>(a.name+' '+a.slug).toLowerCase().includes(search)) : [];
      return route.fulfill({json:{items,source:'live',nextCursor:null}});
    });
    await view.goto(integrationsURL);
    const popular=view.locator('.popular-grid').getByRole('link');
    await popular.first().waitFor();
    assert.equal(await popular.count(),6);
    for(const app of await popular.all()){
      const slug=new URL(await app.getAttribute('href'),origin).searchParams.get('app');
      await expectLogo(app.locator('img'),origin+'/assets/integrations/'+slug+'.webp');
    }

    const search=view.getByRole('searchbox',{name:'Search'});
    const results=view.locator('.int-results');
    await search.fill('fixture clock');
    const liveApp=results.getByRole('link',{name:/Fixture Clock/});
    await expectLogo(liveApp.locator('img'),provider+'fixture_clock');

    await Promise.all([
      view.waitForResponse(response=>response.url()===provider+'fixture_archive' && response.status()===404),
      search.fill('archive')
    ]);
    const missing=results.getByRole('link',{name:/Archive Box/});
    await missing.getByText(/^[A-Z]{1,2}$/).waitFor();
    assert.equal(await missing.locator('img:visible').count(),0);

    await search.fill('linear');
    const linear=results.getByRole('link',{name:/Linear/});
    const logo=origin+'/assets/integrations/linear.webp';
    await expectLogo(linear.locator('img'),logo);
    await linear.click();
    await view.getByRole('heading',{name:'Integration details',exact:true}).waitFor();
    await expectLogo(view.locator('main img[src$="/linear.webp"]'),logo);
  } finally {
    await view.close();
  }
}
