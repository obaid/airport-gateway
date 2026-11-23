(() => {
  'use strict';
  const numbers = new Intl.NumberFormat();
  const dates = new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'America/Los_Angeles'});
  const views = new WeakMap();

  function statement(data,ctx) {
    const {escape:esc,icon} = ctx;
    const end = Date.parse(data.periodEnd);
    const datesText = dates.formatRange(new Date(data.periodStart),new Date(end-1))+' · Pacific';
    const beta = data.status==='beta';
    const planTitle = beta?'Free public beta':'Free access';
    const planDetail = beta?'Access stays free after this beta period.':data.status==='upcoming'?'The public beta opens on '+dates.format(new Date(data.launchStart))+'.':'Your free allowance renews every 30 days.';
    const rows = data.byWorkspace.map(w=>'<li><span>'+esc(w.name)+'</span><strong>'+numbers.format(w.used)+'</strong></li>').join('');
    const atLimit = data.used>=data.limit;
    const periodNote = atLimit?'Your app actions resume on '+dates.format(new Date(end))+'. You can still manage your connections, policies, and agents.':
      'One action counts when an agent successfully uses a connected app. App discovery, blocked or failed requests, and console tests use zero actions.';
    return '<section class="bl-plan" aria-labelledby="bl-plan-title"><div><p class="bl-label">Current plan</p><h2 id="bl-plan-title">'+planTitle+'</h2><p>'+planDetail+' Any future paid plan is opt-in.</p></div>'+
      '<div class="bl-price"><strong>$0</strong><span>No credit card required</span></div></section>'+
      '<section class="bl-panel" aria-labelledby="bl-usage-title"><div class="bl-heading"><div><h2 id="bl-usage-title">Account usage</h2><p>'+datesText+'</p></div>'+
      '<button type="button" class="btn" data-billing-refresh>'+icon('refresh',15)+'Refresh</button></div>'+
      '<div class="bl-count"><strong>'+numbers.format(data.used)+'</strong> of '+numbers.format(data.limit)+' app actions</div><p class="bl-note">'+periodNote+'</p>'+
      '<h3>By workspace</h3><ul class="bl-workspaces">'+rows+'</ul></section>'+
      '<p class="bl-footer"><a href="https://airport.so/pricing/">View public pricing '+icon('arrow-up-right',14)+'</a></p>';
  }

  async function refresh(view) {
    const {el,ctx} = view;
    if(view.loading || !ctx.isCurrent())return;
    view.loading=true;
    const button=el.querySelector('[data-billing-refresh]');
    if(button)button.disabled=true;
    el.setAttribute('aria-busy','true');
    try {
      const data=await ctx.request('billing');
      if(!ctx.isCurrent())return;
      el.innerHTML=statement(data,ctx);
      if(button)el.querySelector('[data-billing-refresh]').focus({preventScroll:true});
    } catch {
      if(!ctx.isCurrent())return;
      el.innerHTML='<div class="bl-panel bl-error"><p role="alert">Your billing details could not be loaded.</p><button class="btn" type="button" data-billing-refresh>Try again</button></div>';
    } finally {
      view.loading=false; el.removeAttribute('aria-busy');
    }
  }
  function render(el,ctx) {
    const view=views.get(el);
    if(view){view.ctx=ctx;return;}
    const initial={el,ctx,loading:false};views.set(el,initial);
    el.classList.add('bl-page');
    el.innerHTML='<p role="status">Loading billing details…</p>';
    el.addEventListener('click',event=>{if(event.target.closest('[data-billing-refresh]'))refresh(initial);});
    refresh(initial);
  }
  window.AirportBilling={render};
})();
