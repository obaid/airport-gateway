(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const {icon,logo,brand} = Art;
  const pages = {overview:'Overview',connections:'Connections',integrations:'Integrations',agents:'Agents',policies:'Policies',activity:'Activity'};
  function parseRoute(fragment) {
    let hash = String(fragment || 'overview').replace(/^#|^\//g,'');
    const [path,query] = hash.split('?');
    const parts = path.split('/').filter(Boolean);
    const legacy = ['catalog','directory'].includes(parts[0]);
    const page = legacy ? 'integrations' : (parts[0] || 'overview');
    const detail = parts[1] || (legacy ? new URLSearchParams(query).get('app') : '') || '';
    const tab = parts[2] || (page==='connections' && detail ? 'settings':'');
    if (!Object.hasOwn(pages,page) || parts.length>3 || (detail && !/^[a-zA-Z0-9_-]+$/.test(detail)) ||
        (detail && !['integrations','connections','agents','activity'].includes(page)) ||
        (tab && (page!=='connections' || !['settings','tools','activity'].includes(tab)))) return {page:'missing',path:'missing'};
    return {page,id:detail,tab,path:[page,detail,tab].filter(Boolean).join('/')};
  }
  let route = parseRoute(location.hash), page=route.page;
  const href = path => '#'+path.split('/').map(encodeURIComponent).join('/');
  function restoreWorkspace() {
    const all=DB.workspaces();
    const previous=all.find(w=>w.id===history.state?.workspace);
    if(previous) DB.select(previous.id);
    if(route.id && ['connections','agents','activity'].includes(page)){
      const list=page==='activity'?'logs':page;
      if(!DB.w()[list].some(item=>item.id===route.id)){
        const match=all.find(w=>w[list].some(item=>item.id===route.id));
        if(match)DB.select(match.id);
      }
    }
  }
  restoreWorkspace();
  history.replaceState({workspace:DB.w().id},'',location.href);
  let traceId = null;
  let menu = false, mobile = false, timer, mapObserver, returnFocus;
  const time = (v) => new Date(v).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  const week = () => { const cutoff=Date.now()-7*24*3600_000;return DB.w().logs.filter(x=>new Date(x.at).getTime()>=cutoff); };
  function modal(title, html) {
    menu=false;
    const dialog=$('#dialog');
    if(!dialog.open) returnFocus=document.activeElement;
    $('#dialog-title').textContent=title;
    $('#dialog-body').innerHTML=html;
    if(!dialog.open) dialog.showModal();
    dialog.scrollTop=0;
  }
  function close() { const d=$('#dialog');if(d.open)d.close(); }
  function toast(message) {
    $('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(timer);
    timer=setTimeout(()=>$('#toast').classList.remove('show'),3200);
  }
  function nav(name) {
    const next=parseRoute(name);
    if(next.page==='missing')return;
    close();menu=false;mobile=false;route=next;page=route.page;
    if(location.hash!==href(route.path) || history.state?.workspace!==DB.w().id) history.pushState({workspace:DB.w().id},'',href(route.path));
    refresh();window.scrollTo(0,0);$('#main').focus({preventScroll:true});
  }
  function wIcon(w) {return ['work','personal','consulting'].includes(w.id)?w.id:'layers';}
  function chrome() {
    const w=DB.w(),pending=w.logs.filter(l=>l.outcome==='Pending').length;
    document.body.classList.toggle('mobile-nav',mobile);
    const switcher=menu?`<div class="workspace-menu"><div class="menu-label">Switch workspace</div>${DB.workspaces().map(a=>`<button type="button" data-w="${esc(a.id)}">${icon(wIcon(a),16)}<span>${esc(a.name)}</span>${a.id===w.id?icon('check',16):''}</button>`).join('')}<button class="menu-add" data-open="workspace">${icon('plus',16)}Create workspace</button></div>`:'';
    const link=(key,ic)=>`<a href="${href(key)}" class="nav-item ${page===key?'selected':''}" ${page===key?'aria-current="page"':''} data-nav="${key}">${icon(ic,18)}<span>${pages[key]}</span>${key==='activity'&&pending?`<span class="nav-count" title="Pending requests">${pending}</span>`:''}</a>`;
    $('#sidebar').innerHTML=`<div class="brand-row"><button class="brand" data-nav="overview" aria-label="Airport overview">${brand(34)}<span>Airport</span></button><button class="mobile-x icon-btn" aria-label="Close navigation" data-shell="dismiss">${icon('x')}</button></div>
    <div class="ws-wrap"><button class="ws-button" data-shell="workspace" aria-expanded="${menu}"><span class="workspace-icon">${icon(wIcon(w),19)}</span><span class="workspace-label"><small>Workspace</small><strong>${esc(w.name)}</strong></span>${icon('chevrons',15)}</button>${switcher}</div>
    <nav class="nav-sections"><div class="nav-label">Workspace</div>${link('overview','overview')}${link('connections','connections')}${link('integrations','layers')}${link('agents','agents')}<div class="nav-label second">Access control</div>${link('policies','shield')}${link('activity','activity')}</nav>
    <div class="sidebar-foot"><div class="demo-avatar">AM</div><div><strong>Alex Morgan</strong><small>Demo account</small></div></div>`;
    const record=page==='connections'?w.connections.find(c=>c.id===route.id):page==='agents'?w.agents.find(a=>a.id===route.id):page==='activity'?w.logs.find(l=>l.id===route.id):null;
    const caption=record ? (record.account || record.name || record.tool) : route.id;
    const trail=route.id?`<span>/</span><a href="${href(page)}" data-nav="${page}">${pages[page]}</a><span>/</span><span class="crumb-current">${esc(caption)}</span>`:`<span>/</span><span>${pages[page]||'Page unavailable'}</span>`;
    $('#bar').innerHTML=`<div class="crumb"><button class="mobile-trigger icon-btn" data-shell="mobile" aria-label="Open navigation">${icon('menu')}</button>${icon('layers',16)}<button data-shell="crumb" title="Switch workspace">${esc(w.name)}</button>${trail}</div><div class="mode-access"><div class="preview-info"><span class="preview-light"></span>Interactive demo</div></div>`;
    document.title=[caption || pages[page] || 'Page unavailable',w.name,'Airport'].join(' · ');
  }
  function mapPanel(w) {
    const active=w.agents.filter(a=>DB.agentStatus(a)==='Active');
    const recent=w.logs.filter(l=>active.slice(0,4).some(a=>a.id===l.agentId) && w.connections.slice(0,4).some(c=>c.id===l.connectionId)).slice(0,8);
    if(!recent.some(l=>l.id===traceId))traceId=null;
    const trace=recent.find(l=>l.id===traceId);
    const traces=recent.length?`<label class="trace-control"><span>Trace request</span><select id="map-trace"><option value="">All workspace routes</option>${recent.map(l=>`<option value="${esc(l.id)}" ${trace?.id===l.id?'selected':''}>${esc(l.agent)} → ${esc(DB.serviceName(l.service))} · ${esc(l.outcome)} · ${esc(time(l.at))}</option>`).join('')}</select></label>`:'';
    const legend=trace?`<button class="trace-receipt" data-open="log" data-id="${esc(trace.id)}"><strong>${esc(trace.outcome)}</strong><code>${esc(trace.tool)}</code>${icon('chevron-right',14)}</button>`:`<span class="trace-summary">${active.length} active agent${active.length===1?'':'s'} · ${w.connections.length} connected account${w.connections.length===1?'':'s'}</span>`;
    function group(list,side,kind,title) {
      const section=kind==='agent'?'agents':'connections';
      const nodes=list.slice(0,4).map(item=>{
        const name=item.name||DB.serviceName(item.service),path=section+'/'+item.id+(kind==='connection'?'/settings':'');
        const duplicate=item.service && list.filter(other=>other.service===item.service).length>1;
        const caption=kind==='connection'?name+' · '+item.account:name;
        return `<a class="map-node" href="${href(path)}" data-nav="${esc(path)}" data-id="${esc(item.id)}" title="${esc(caption)}" aria-label="${esc(caption)}">
          ${logo(item.provider||item.service,21)}<span>${esc(name)}${duplicate?`<small>${esc(item.account)}</small>`:''}</span></a>`;
      }).join('');
      const add=kind==='connection'?'data-nav="integrations"':'data-open="agent"';
      return `<div class="map-group ${side}"><div class="map-caption">${title}</div><div class="node-stack">${nodes||`<button class="map-empty" ${add}>${icon('plus',14)}Add ${kind}</button>`}</div>
        ${list.length>4?`<button class="more-nodes" data-nav="${section}">+${list.length-4} more</button>`:''}</div>`;
    }
    const frame=AirportOverview.mapFrame({
      legendHTML:'<span></span>Workspace route',
      agentsHTML:group(active,'left','agent','Agents'),
      gatewayHTML:`<button class="gateway-node" title="View gateway policies" data-nav="policies">${brand(53)}<strong>Airport</strong><small>Workspace gateway</small></button>`,
      accountsHTML:group(w.connections,'right','connection','Connections'),
      traceHTML:traces+legend
    },{icon});
    return '<section class="map-panel panel" aria-label="Workspace gateway map">'+frame+'</section>';
  }
  function drawRoutes() {
    const d=$('.diagram');if(!d)return;
    const wrap=d.getBoundingClientRect(),center=d.querySelector('.gateway-node').getBoundingClientRect();
    if(!wrap.width)return;
    const local=(box,side)=>[box[side]-wrap.left,box.top+box.height/2-wrap.top];
    const lines=[];
    const trace=DB.w().logs.find(l=>l.id===traceId);
    d.classList.toggle('tracing',Boolean(trace));
    for(const side of ['left','right']) {
      const nodes=d.querySelectorAll('.'+side+' .map-node');
      for(const [i,node] of Array.from(nodes).entries()){
        const [x1,y1]=local(side==='left'?node.getBoundingClientRect():center,'right');
        const [x2,y2]=local(side==='left'?center:node.getBoundingClientRect(),'left');
        const m=(x1+x2)/2, path=`M ${x1} ${y1} C ${m} ${y1} ${m} ${y2} ${x2} ${y2}`;
        const chosen=trace && node.dataset.id===(side==='left'?trace.agentId:trace.connectionId);
        const denied=chosen && side==='right' && ['Blocked','Denied','Pending'].includes(trace.outcome);
        node.classList.toggle('trace-node',Boolean(chosen));
        lines.push(`<g data-wire="${esc(node.dataset.id)}" class="${chosen?'selected-wire':''} ${denied?'denied-wire':''}"><path d="${path}" class="route ${i===0?'key-route':''}"/><circle cx="${side==='left'?x1:x2}" cy="${side==='left'?y1:y2}" r="2.5" class="port"/>`);
        if(i===0||i===2)lines.push(`<circle cx="${m}" cy="${(y1+y2)/2}" r="3" class="waypoint"/>`);
        lines.push('</g>');
      }
    }
    d.querySelector('svg.route-lines').innerHTML=lines.join('');
  }
  function overview() {
    const w=DB.w(),logs=week();
    const count=(...outcomes)=>logs.filter(l=>outcomes.includes(l.outcome)).length;
    const model={agents:w.agents.filter(a=>DB.agentStatus(a)==='Active').length,accounts:w.connections.length,
      week:{requests:logs.length,allowed:count('Allowed','Approved'),blocked:count('Blocked','Denied'),pending:count('Pending')},
      recent:w.logs.slice(0,4).map(l=>({id:l.id,actor:l.agent,service:DB.serviceName(l.service),tool:l.tool,outcome:l.outcome,at:l.at,mark:w.agents.find(a=>a.id===l.agentId)?.provider})),
      pendingId:w.logs.find(l=>l.outcome==='Pending')?.id};
    const helpers={escape:esc,icon,logo,time,href,activityURL:id=>href('activity/'+id)};
    return `<div class="page-head"><div><h1 class="page-title">Workspace overview</h1><p class="subtitle">Agent access and request activity in ${esc(w.name)}.</p></div><div class="actions"><button class="btn" data-open="test">${icon('play',14)}Test request</button><button class="btn primary" data-open="agent">${icon('plus',16)}Add agent</button></div></div>
    ${AirportOverview.stats(model,helpers)}${mapPanel(w)}${AirportOverview.lower(model,helpers)}`;
  }
  function refresh() {
    if(mapObserver)mapObserver.disconnect();
    chrome();
    $('#main').innerHTML=page==='overview'?overview():page==='integrations'?AirportDirectory.page(route.id):Mgr.page(page,route.id,route.tab);
    if(page==='integrations')AirportDirectory.render(route.id);
    if(page==='overview'){mapObserver=new ResizeObserver(drawRoutes);mapObserver.observe($('.diagram'));requestAnimationFrame(drawRoutes);}
  }
  document.addEventListener('change',e=>{
    if(e.target.id!=='map-trace')return;
    traceId=e.target.value||null;refresh();$('#map-trace')?.focus({preventScroll:true});
  });
  function markWire(e,clear){
    const node=e.target.closest?.('.map-node');if(!node)return;
    const diagram=node.closest('.diagram');
    const wire=[...diagram.querySelectorAll('[data-wire]')].find(edge=>edge.dataset.wire===node.dataset.id);
    wire?.classList.toggle('inspect-wire',!clear);
  }
  for(const type of ['pointerover','focusin','pointerout','focusout']){
    document.addEventListener(type,e=>markWire(e,type==='pointerout'||type==='focusout'));
  }
  window.UI={icon,logo,esc,href,nav,refresh,modal,close,toast,time,route:()=>route};
  document.addEventListener('click', e=>{
    const el=e.target.closest('[data-nav],[data-open],[data-w],[data-shell]');
    if(!el){if(menu&&!e.target.closest('.ws-wrap')){menu=false;chrome();}return;}
    if(el.dataset.nav){if(el.tagName==='A'&&(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey))return;e.preventDefault();nav(el.dataset.nav);}
    else if(el.dataset.open){menu=false;mobile=false;chrome();Mgr.open(el.dataset.open,el.dataset.id);}
    else if(el.dataset.w){DB.select(el.dataset.w);menu=false;mobile=false;nav('overview');}
    else if(el.dataset.shell==='workspace'){menu=!menu;chrome();if(menu)document.querySelector('.workspace-menu button')?.focus();}
    else if(el.dataset.shell==='crumb'){menu=true;mobile=matchMedia('(max-width: 780px)').matches;chrome();}
    else if(el.dataset.shell==='mobile'){mobile=true;chrome();}
    else if(el.dataset.shell==='dismiss'){mobile=false;menu=false;chrome();}
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#dialog').open&&(menu||mobile)){menu=false;mobile=false;chrome();}});
  $('#dialog-close').innerHTML=icon('x',18);$('#dialog-close').onclick=close;
  $('#dialog').addEventListener('close',()=>{if($('#dialog').open)return;$('#dialog-body').replaceChildren();if(returnFocus?.isConnected)returnFocus.focus();});
  $('#dialog').addEventListener('click',e=>{const d=e.currentTarget,r=d.getBoundingClientRect();if(e.target===d&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))close();});
  function followHistory() {
    route=parseRoute(location.hash);page=route.page;restoreWorkspace();
    menu=false;mobile=false;close();refresh();
  }
  window.addEventListener('hashchange',followHistory);
  window.addEventListener('popstate',followHistory);
  $('.skip').addEventListener('click',event=>{event.preventDefault();$('#main').focus();});
  refresh();
})();
