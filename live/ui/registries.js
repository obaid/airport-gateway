(() => {
  'use strict';
  const views=new WeakMap();
  const enc=encodeURIComponent;
  const scoped=(items,ctx)=>(items||[]).filter(item=>item.workspace===ctx.workspace.id);
  const pretty=s=>String(s||'').replace(/[_-]+/g,' ').toLowerCase().replace(/^./,c=>c.toUpperCase());
  const toolkitName=slug=>window.AirportDiscovery?.apps?.[slug]?.name||pretty(slug);
  const chip=(ctx,label,tone='')=>`<span class="chip rg-chip ${tone}">${ctx.escape(label)}</span>`;
  const time=value=>{
    const d=new Date(value);
    return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) : 'Unrecorded';
  };
  const statusTone=s=>/allowed|approved|issued|connected|completed|active/i.test(s)?'allow':/blocked|denied|failed|interrupted/i.test(s)?'block':/pending|running|waiting/i.test(s)?'ask':'';
  function section(ctx,title,body,count) {
    return `<section class="panel rg-panel"><header class="panel-head rg-heading"><h2>${ctx.escape(title)}</h2>${count===undefined?'':chip(ctx,String(count))}</header>${body}</section>`;
  }
  function empty(ctx,title,detail) {
    return `<div class="empty rg-empty"><strong>${ctx.escape(title)}</strong><p>${ctx.escape(detail)}</p></div>`;
  }
  function recordService(row) {
    const binding=row.exchange?.request?.connection;
    if(binding?.toolkit)return toolkitName(binding.toolkit);
    return ['gmail_inbox_counts','gmail_send_email'].includes(row.tool)?'Gmail':'Airport';
  }
  function mark(ctx,key) {
    const url=window.AirportDiscovery?.marks?.[key];
    if(typeof url==='string'&&url.startsWith('data:image/png;base64,'))
      return `<span class="entity-mark rg-mark native"><img alt="" src="${ctx.escape(url)}" width="29" height="29"></span>`;
    return `<span class="entity-mark rg-mark">${ctx.logo(key,28)}</span>`;
  }
  function connections(ctx,logs) {
    const {workspace:w,escape:esc,icon}=ctx;
    const list=scoped(ctx.state.connections,ctx);
    if(['active','pending','mismatch'].includes(w.status))
      list.unshift({id:'pilot-gmail',toolkit:'gmail',label:w.email||w.expectedEmail||'Gmail inbox',status:w.status,pilot:true});
    function row(c) {
      const allowed=c.pilot?(w.policy==='Allow'?1:0):(c.tools||[]).filter(t=>t.allowed||t.enabled).length;
      const count=logs.filter(log=>c.pilot?['gmail_inbox_counts','gmail_send_email'].includes(log.tool):log.exchange?.request?.connection?.id===c.id).length;
      const state={active:'Connected',pending:'Awaiting sign-in',disabled:'Disconnected',mismatch:'Address mismatch'}[c.status]||'Unverified';
      const needsAccess=c.status==='active'&&!c.pilot&&!allowed&&!c.accessMode;
      const mode={'read-only':'Read only','write-only':'Write only','read-write':'Read and write',custom:'Custom'}[c.accessMode];
      const meta=c.status==='active' ? `<strong${needsAccess?' class="rg-setup"':''}>${needsAccess?'Set up agent access':mode||'Connected'}</strong><small>${needsAccess?'Connected · 0 tools':allowed+' tool'+(allowed===1?'':'s')+' allowed'}</small>` : `<strong>${esc(state)}</strong><small>Account status</small>`;
      const label=c.label||toolkitName(c.toolkit), path='#connections/'+enc(c.id)+'/settings';
      return `<a class="entity-row rg-entity rg-account" href="${path}">${mark(ctx,c.toolkit)}<span class="entity-id rg-id"><strong>${esc(toolkitName(c.toolkit))}</strong><small>${esc(label)}</small></span>
        <span class="entity-meta rg-meta">${meta}</span><span class="entity-meta rg-meta" title="Requests in this workspace’s retained activity"><strong>${count}</strong><small>logged request${count===1?'':'s'}</small></span>${icon('chevron-right',16)}</a>`;
    }
    const current=list.filter(c=>c.status!=='disabled'),retired=list.filter(c=>c.status==='disabled');
    const archive=retired.length?`<details class="rg-archive"><summary>${retired.length} disconnected account${retired.length===1?'':'s'}</summary>${retired.map(row).join('')}</details>`:'';
    return section(ctx,'Connected accounts',(current.map(row).join('')||empty(ctx,'No connected accounts','Choose an integration to connect your first account.'))+archive,current.length);
  }
  function operation(row){
    const slug=row.exchange?.request?.operation?.slug;
    return pretty(slug||row.tool);
  }
  function requests(view,rows,heading='Requests') {
    const {ctx}=view,{escape:esc}=ctx;
    if(!rows.length)return section(ctx,heading,empty(ctx,'No requests yet','Recorded agent requests and owner actions will appear here.'),0);
    const outcomes=[...new Set(rows.map(row=>row.outcome).filter(Boolean))].sort();
    const options=outcomes.map(x=>`<option value="${esc(x)}"${view.outcome===x?' selected':''}>${esc(x)}</option>`).join('');
    return `<div class="request-filters rg-filters"><label><span>Search requests</span><input type="search" data-rg-search maxlength="200" value="${esc(view.query)}" placeholder="Agent, service or tool"></label>
      <label><span>Decision</span><select data-rg-outcome><option value="">All decisions</option>${options}</select></label></div>
      <section class="panel rg-panel"><header class="panel-head rg-heading"><h2>${esc(heading)}</h2><span data-rg-count aria-live="polite"></span></header><div data-rg-requests></div></section>`;
  }
  function filterRequests(v) {
    const host=v.el.querySelector('[data-rg-requests]');if(!host)return;
    const {ctx}=v,{escape:esc,icon}=ctx;
    const query=v.query.trim().toLowerCase();
    const rows=v.rows.filter(r=>(!v.outcome||r.outcome===v.outcome)&&[r.actor,r.tool,r.outcome,operation(r),recordService(r),r.exchange?.request?.connection?.label]
      .filter(Boolean).join(' ').toLowerCase().includes(query));
    v.el.querySelector('[data-rg-count]').textContent=String(rows.length);
    host.innerHTML=rows.map(r=>{
      const service=recordService(r);
      return `<a class="request-row rg-request" href="#activity/${enc(r.id)}"><span class="entity-id rg-id"><strong>${esc(operation(r))}</strong><small class="actor-with-icon">${ctx.requestLogo(r,16)}<span>${esc(r.actor||'Unknown')} → ${esc(service)}</span></small></span>
        ${chip(ctx,r.outcome||'Unknown',statusTone(r.outcome))}<time datetime="${esc(r.at)}">${esc(time(r.at))}</time>${icon('chevron-right',15)}</a>`;
    }).join('')||empty(ctx,'No matching requests','Try another search or decision.');
  }
  function agents(ctx,logs) {
    const {workspace:w,escape:esc,icon}=ctx;
    const agents=scoped(ctx.state.agentGrants,ctx).map(a=>({...a,label:a.actor,status:'Active',sub:a.expiresAt?'Expires '+time(a.expiresAt):a.expiresAt===null?'Never expires':'Expiry unrecorded'}));
    const pairing=w.invitation||scoped(ctx.state.invites,ctx).length;
    if(w.grant||pairing)agents.unshift({id:'muse',clientType:'muse',label:'Muse',status:w.grant?'Paired':'Pairing',sub:'Saved connector'});
    const rows=agents.map(a=>{
      const last=logs.find(log=>log.actor===a.label);
      return `<a class="entity-row agent-row rg-entity rg-agent" href="#agents/${enc(a.id)}"><span class="rg-agent-icon">${ctx.agentLogo(a.label,34,a.clientType)}</span><span class="entity-id rg-id"><strong>${esc(a.label)}</strong><small>${esc(a.sub)}</small></span>
        <span class="entity-meta rg-meta"><strong>${last?esc(time(last.at)):'No requests'}</strong><small>Last request</small></span>${chip(ctx,a.status,a.status==='Pairing'?'ask':'allow')}${icon('chevron-right',16)}</a>`;
    }).join('');
    const invitations=scoped(ctx.state.agentInvitations,ctx);
    const pending=invitations.map(i=>`<button type="button" class="entity-row agent-row rg-entity rg-agent" data-manage="inspect-agent-invite" data-id="${esc(i.id)}"><span class="rg-agent-icon">${ctx.invitationLogo(i,34)}</span>
      <span class="entity-id rg-id"><strong>${esc(i.name||'Agent chooses name')}</strong><small>One-use invitation</small></span><span class="entity-meta rg-meta"><strong>${esc(time(i.expiresAt))}</strong><small>Invitation expires</small></span>
      ${chip(ctx,'Pending','ask')}${icon('chevron-right',16)}</button>`).join('');
    return section(ctx,'Workspace agents',rows||empty(ctx,'No agents yet','Add an agent to issue credentials for this workspace.'),agents.length)+
      (invitations.length?section(ctx,'Pending invitations',pending,invitations.length):'');
  }
  function agentDetail(v,a) {
    const {ctx}=v,{escape:esc}=ctx;
    if(!a)return section(ctx,'Agent unavailable',empty(ctx,'This agent is unavailable','Choose another agent in this workspace.'));
    const access=ctx.describeGrant?.(a.expiresAt) || (a.expiresAt?'Expires '+time(a.expiresAt):a.expiresAt===null?'Never expires':'Expiry unrecorded');
    const endpoint=ctx.agentEndpoint?.();
    const facts=`<div class="panel-inner rg-body"><dl class="facts rg-facts"><div><dt>Agent name</dt><dd class="actor-with-icon">${ctx.agentLogo(a.actor,24,a.clientType)}<span>${esc(a.actor)}</span></dd></div><div><dt>Workspace</dt><dd>${esc(ctx.workspace.name)}</dd></div>
      <div><dt>Credential</dt><dd>${esc(access)}</dd></div></dl><button class="button" type="button" data-manage="remove-agent" data-id="${esc(a.id)}">Revoke access</button></div>`;
    const setup=`<div class="panel-inner rg-body"><p>Use the bearer credential issued for this agent in its connector.</p>${endpoint?`<label class="rg-endpoint"><span>MCP endpoint</span><input readonly value="${esc(endpoint)}"></label>`:'<p>The agent endpoint is unavailable.</p>'}</div>`;
    return `<div class="agent-detail-grid rg-columns">${section(ctx,'Workspace access',facts)}${section(ctx,'Connector setup',setup)}</div>${requests(v,v.rows,'Agent activity')}`;
  }
  function render(el,ctx) {
    const {route:r,workspace:w}=ctx,key=[w.id,r.page,r.id||''].join('/');
    let v=views.get(el);
    if(!v||v.key!==key){v={el,key,ctx,query:'',outcome:'',focused:false};views.set(el,v);}
    v.ctx=ctx;
    const logs=scoped(ctx.state.logs,ctx).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
    const oldInput=el.querySelector('[data-rg-search]'),restore=oldInput&&document.activeElement===oldInput;
    const cursor=restore?oldInput.selectionStart:0;
    let html;
    v.rows=logs;
    if(r.page==='connections')html=connections(ctx,logs);
    else if(r.page==='agents'&&!r.id)html=agents(ctx,logs);
    else if(r.page==='agents'){
      const agent=scoped(ctx.state.agentGrants,ctx).find(a=>a.id===r.id);
      v.rows=logs.filter(l=>agent && l.actor===agent.actor);
      html=agentDetail(v,agent);
    }else if(r.id){
      const entry=logs.find(l=>l.id===r.id);
      html=entry?section(ctx,'Request',ctx.auditEntry(entry)) : section(ctx,'Request unavailable',empty(ctx,'This request is unavailable','Open a request from this workspace’s recent activity.'));
    }else{
      const legacy=(ctx.state.activityDetailsVersion||0)<1?'<p class="rg-legacy">This gateway records request summaries. The upgraded gateway records additional response details for new requests.</p>':'';
      html=legacy+requests(v,logs);
    }
    el.classList.add('rg-page');el.innerHTML=html;
    el.oninput=e=>{if(e.target.hasAttribute('data-rg-search')){v.query=e.target.value;filterRequests(v);}};
    el.onchange=e=>{if(e.target.hasAttribute('data-rg-outcome')){v.outcome=e.target.value;filterRequests(v);}};
    filterRequests(v);
    if(restore){const input=el.querySelector('[data-rg-search]');input?.focus({preventScroll:true});input?.setSelectionRange(cursor,cursor);}
    const summary=el.querySelector('.audit-entry[open]>summary');
    if(summary&&!v.focused){v.focused=true;requestAnimationFrame(()=>{if(ctx.isCurrent()&&summary.isConnected)summary.focus({preventScroll:true});});}
  }
  (window.AirportPages ||= {}).registries={render};
})();
