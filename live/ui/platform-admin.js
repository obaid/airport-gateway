(() => {
  'use strict';

  const views = new WeakMap();
  const numbers = new Intl.NumberFormat();
  const timestamp = new Intl.DateTimeFormat(undefined, {
    month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'
  });

  function appMark(ctx,key) {
    const mark = window.AirportDiscovery?.marks?.[key];
    if (typeof mark === 'string' && mark.startsWith('data:image/png;base64,'))
      return `<img src="${ctx.escape(mark)}" width="27" height="27" alt="">`;
    return ctx.logo(key,26);
  }

  function inventory(ctx,totals) {
    const items = [
      ['Registered users',totals.users,'user'],
      ['Workspaces',totals.workspaces,'overview'],
      ['Active connections',totals.connections,'connections'],
      ['Active agent credentials',totals.agents,'agents']
    ];
    return `<section class="pa-stock" aria-label="Current platform totals"><dl>${items.map(([label,value,icon])=>
      `<div><dt><span aria-hidden="true">${ctx.icon(icon,18)}</span>${label}</dt><dd>${numbers.format(value)}</dd></div>`
    ).join('')}</dl></section>`;
  }

  function integrations(ctx,rows,total) {
    const list = rows.length ? `<ul class="pa-list">${rows.map(row=>
      `<li><div class="pa-line"><span class="pa-mark" aria-hidden="true">${appMark(ctx,row.key)}</span>
        <strong class="pa-item-name">${ctx.escape(row.label)}</strong><span class="pa-value">${numbers.format(row.count)}</span></div>
        <meter aria-hidden="true" min="0" max="${Number(total)}" value="${Number(row.count)}"></meter></li>`
    ).join('')}</ul>` : '<p class="pa-empty">No active app connections yet.</p>';
    return `<section class="pa-panel"><header><h2>Top integrations</h2><p>Ranked by active account connections across all workspaces.</p></header>${list}</section>`;
  }

  function agents(ctx,rows,days) {
    const list = rows.length ? `<ul class="pa-list">${rows.map(row=>{
      const mark = ctx.agentLogo?.(row.label,28,row.key) || ctx.icon('agents',22);
      return `<li class="pa-line"><span class="pa-mark" aria-hidden="true">${mark}</span>
        <div class="pa-name-group"><strong class="pa-item-name">${ctx.escape(row.label)}</strong>
          <small>${numbers.format(row.activeAgents)} active credential${row.activeAgents===1?'':'s'}</small></div>
        <span class="pa-value">${numbers.format(row.count)} <small>call${row.count===1?'':'s'}</small></span></li>`;
    }).join('')}</ul>` : '<p class="pa-empty">No connected agents or successful calls in this period.</p>';
    return `<section class="pa-panel"><header><h2>Most-used agents</h2><p>Ranked by successful tool calls over the past ${days} days.</p></header>${list}</section>`;
  }

  function toolUsage(ctx,data) {
    const {tools,totals,window:period} = data;
    const list = tools.length ? `<table class="pa-tools"><thead><tr><th scope="col">Tool</th><th scope="col">Successful calls</th></tr></thead><tbody>${tools.map(row=>
      `<tr><th scope="row"><strong>${ctx.escape(row.label)}</strong>${row.key===row.label?'':`<code>${ctx.escape(row.key)}</code>`}</th>
        <td class="pa-value">${numbers.format(row.count)}</td></tr>`
    ).join('')}</tbody></table>` : '<p class="pa-empty">No successful agent tool calls were recorded in this period.</p>';
    return `<section class="pa-panel"><header class="pa-tools-head"><div><h2>Most-used tools</h2>
      <p>Successful calls agents made to connected apps, from retained activity over the past ${Number(period.days)} days.</p></div>
      <div class="pa-call-total"><strong>${numbers.format(totals.successfulToolCalls)}</strong><span>Total calls</span></div></header>${list}</section>`;
  }

  async function refresh(view) {
    if (view.loading || !view.ctx.isCurrent()) return;
    const {root,status,button,content,ctx} = view;
    view.loading = true;
    button.disabled = true;
    status.textContent = 'Loading platform metrics…';
    content.setAttribute('aria-busy','true');
    try {
      const data = await ctx.request('admin/overview');
      if (!root.isConnected || !ctx.isCurrent()) return;
      const {totals,window:period} = data;
      const date = new Date(data.asOf);
      const html = inventory(ctx,totals)+`<div class="pa-rankings">${integrations(ctx,data.integrations,totals.connections)}${agents(ctx,data.bots,Number(period.days))}</div>`+toolUsage(ctx,data);
      status.textContent = 'Updated '+timestamp.format(date);
      content.innerHTML = html;
      button.textContent = 'Refresh';
    } catch {
      if (!root.isConnected || !ctx.isCurrent()) return;
      content.replaceChildren();
      status.textContent = 'Airport couldn’t load the platform metrics.';
      button.textContent = 'Retry';
    } finally {
      view.loading = false;
      button.disabled = false;
      content.removeAttribute('aria-busy');
    }
  }

  function render(el,ctx) {
    const mounted = views.get(el);
    if (mounted?.root.parentNode === el) {
      mounted.ctx = ctx;
      return;
    }
    const root = document.createElement('div');
    root.className = 'platform-admin';
    root.innerHTML = '<div class="pa-toolbar"><p role="status"></p><button type="button" class="btn">Refresh</button></div><div class="pa-content"></div>';
    el.replaceChildren(root);
    const view = {ctx,root,loading:false,status:root.querySelector('[role="status"]'),
      content:root.querySelector('.pa-content'),button:root.querySelector('button')};
    views.set(el,view);
    view.button.onclick = () => refresh(view);
    refresh(view);
  }

  window.AirportPlatformAdmin = {render};
})();
