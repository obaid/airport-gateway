(() => {
  'use strict';
  const perPage=24;
  const aliases={googledrive:'drive',googlecalendar:'calendar'};
  const services=new Set(['gmail','drive','calendar','slack','notion','instagram','yahoo']);
  const schemeNames={API_KEY:'API key',OAUTH2:'OAuth',OAUTH1:'OAuth 1',BASIC:'Basic auth',BASIC_AUTH:'Basic auth',BEARER_TOKEN:'Bearer token',DCR_OAUTH:'Dynamic OAuth',NO_AUTH:'No sign-in'};
  const filters={search:'',category:'',auth:'',page:1};
  let apps=new Map(), popularity=[],categories=[],loading;
  const esc=value=>UI.esc(value);
  const fmt=n=>Number(n).toLocaleString();
  const service=slug=>aliases[slug]||slug;
  const discovery=()=>window.AirportDiscovery || {};
  function load(){
    if(loading)return loading;
    loading=fetch('toolkits.json').then(async response=>{
      if(!response.ok)throw Error();
      const source=await response.json(), meta=discovery();
      const all=new Map(source.map(([slug,name,toolsCount,schemes,managed])=>[slug,{
        slug,name,toolsCount,authSchemes:schemes.split(', '),managedAuthSchemes:managed==='Yes'?['OAUTH2']:[],
        requiresAuth:schemes!=='NO_AUTH',description:'',categories:[]
      }]));
      for(const [slug,data] of Object.entries(meta.apps||{})){
        const app={...all.get(slug),...data,slug};
        all.set(slug,app);
      }
      apps=new Map([...all].sort(([,a],[,b])=>a.name.localeCompare(b.name)||a.slug.localeCompare(b.slug)));
      popularity=(meta.popular||[]).filter(slug=>apps.has(slug));
      categories=[...new Set([...apps.values()].flatMap(app=>app.categories||[]))].sort((a,b)=>a.localeCompare(b));
      return apps;
    }).catch(()=>{loading=null;throw Error('The integrations directory could not be loaded.');});
    return loading;
  }
  function auth(app){
    if(app.requiresAuth===false)return 'No sign-in';
    if(app.managedAuthSchemes?.includes('OAUTH2'))return 'Managed OAuth';
    return (app.authSchemes||[]).map(s=>schemeNames[s]||s).join(', ')||'Provider sign-in';
  }
  function mark(app,size=28){
    if(Object.hasOwn(discovery().apps||{},app.slug))return `<span class="dir-logo real-mark"><img src="integrations/${esc(encodeURIComponent(app.slug))}.webp" width="${size}" height="${size}" alt=""></span>`;
    const key=service(app.slug);
    if(services.has(key))return `<span class="dir-logo">${Art.logo(key,size)}</span>`;
    return `<span class="dir-logo dir-initial" aria-hidden="true">${esc(app.name.slice(0,2).toUpperCase())}</span>`;
  }
  const route=slug=>'integrations/'+slug;
  const card=app=>`<a class="dir-card" href="${esc(UI.href(route(app.slug)))}" data-nav="${esc(route(app.slug))}">${mark(app)}
    <span><strong>${esc(app.name)}</strong><small>${fmt(app.toolsCount||0)} ${app.toolsCount===1?'tool':'tools'} · ${esc(auth(app))}</small></span>${Art.icon('chevron-right',14)}</a>`;
  function select(id,label,choices,selected){
    return `<label class="field"><span>${esc(label)}</span><select id="${id}">${choices.map(([k,v])=>`<option value="${esc(k)}" ${k===selected?'selected':''}>${esc(v)}</option>`).join('')}</select></label>`;
  }
  function directory(){
    const showPopular=popularity.length>0;
    return `<div class="page-head"><div><h1 class="page-title">Integrations</h1><p class="subtitle">Find an app and connect an account to ${esc(DB.w().name)}.</p></div>
      <a class="btn" href="#connections" data-nav="connections">${Art.icon('connections',15)}Connected accounts</a></div>
      ${showPopular?`<section class="popular-section" aria-labelledby="popular-title"><div class="section-bar"><h2 id="popular-title">Popular integrations</h2></div>
      <div class="popular-grid">${popularity.slice(0,6).map(slug=>card(apps.get(slug))).join('')}</div></section>`:''}
      <section class="panel directory"><div class="section-bar"><h2>All integrations</h2><span class="sub" id="directory-count" role="status"></span></div>
      <div class="dir-controls"><label class="field"><span>Search</span><input id="directory-search" type="search" placeholder="Name or toolkit" value="${esc(filters.search)}"></label>
      ${select('directory-category','Category',[['','All categories'],...categories.map(c=>[c,c])],filters.category)}
      ${select('directory-filter','Authentication',[['','All methods'],['managed','Managed OAuth'],['key','API key'],['noauth','No sign-in']],filters.auth)}</div>
      <div id="directory-matches"></div><nav id="directory-pages" aria-label="Integration pages"></nav></section>`;
  }
  function results(){
    const list=document.querySelector('#directory-matches');if(!list)return;
    const query=filters.search.toLowerCase().trim();
    const matches=[...apps.values()].filter(a=> (!query || (a.name+' '+a.slug).toLowerCase().includes(query)) &&
      (!filters.category || a.categories?.includes(filters.category)) &&
      (!filters.auth || (filters.auth==='managed'&&a.managedAuthSchemes?.includes('OAUTH2')) ||
       (filters.auth==='noauth'&&a.requiresAuth===false) || (filters.auth==='key'&&a.authSchemes?.includes('API_KEY'))));
    const pages=Math.max(1,Math.ceil(matches.length/perPage));
    filters.page=Math.max(1,Math.min(filters.page,pages));
    const start=(filters.page-1)*perPage;
    document.querySelector('#directory-count').textContent=fmt(matches.length)+(matches.length===1?' integration':' integrations');
    list.innerHTML=matches.slice(start,start+perPage).map(card).join('')||'<div class="empty"><strong>No matching integrations</strong><p>Try another search or clear the filters.</p><button class="btn" data-dir-reset>Clear filters</button></div>';
    document.querySelector('#directory-pages').innerHTML=matches.length?`<span class="sub">${start+1}–${Math.min(start+perPage,matches.length)} of ${fmt(matches.length)}</span>
      <div><button class="btn" data-dir-page="-1" ${filters.page===1?'disabled':''} aria-label="Previous page">${Art.icon('chevron-left',14)}Previous</button>
      <span class="pager-index">${filters.page} / ${pages}</span><button class="btn" data-dir-page="1" ${filters.page===pages?'disabled':''} aria-label="Next page">Next${Art.icon('chevron-right',14)}</button></div>`:'';
  }
  function detail(app){
    if(!app)return '<header class="page-head"><h1 class="page-title">Integration unavailable</h1></header><a class="btn" href="#integrations" data-nav="integrations">Back to integrations</a>';
    const reference='https://docs.composio.dev/toolkits/'+encodeURIComponent(app.slug);
    const linked=DB.w().connections.filter(c=>c.service===service(app.slug));
    return `<header class="entity-head">${mark(app,42)}<div><h1 class="page-title">${esc(app.name)}</h1><p class="subtitle">${esc(app.categories?.join(' · ')||app.slug)}</p></div>
      <button class="btn primary" data-m-open="connection" data-m-id="${esc(app.slug)}">${Art.icon('plus',15)}Add sample account</button></header>
      <section class="panel integration-detail"><div class="panel-head"><h2>Integration details</h2><a class="text-btn" href="${reference}" target="_blank" rel="noopener noreferrer">Tool reference ${Art.icon('arrow-up-right',14)}</a></div><div class="panel-inner">
      ${app.description?`<p class="app-description">${esc(app.description)}</p>`:''}<dl class="facts"><div><dt>Available tools</dt><dd>${fmt(app.toolsCount||0)}</dd></div>
      <div><dt>Authentication</dt><dd>${esc(auth(app))}</dd></div><div><dt>Toolkit</dt><dd><code>${esc(app.slug)}</code></dd></div></dl>
      </div></section>
      <section class="panel linked-accounts"><div class="panel-head"><h2>Accounts in ${esc(DB.w().name)}</h2></div>
      ${linked.map(c=>`<a class="linked-account" href="#connections/${esc(c.id)}/settings" data-nav="connections/${esc(c.id)}/settings">${esc(c.account)}${Art.icon('chevron-right',14)}</a>`).join('')||'<p class="empty">No sample accounts connected.</p>'}</section>`;
  }
  function page(id){return apps.size ? (id?detail(apps.get(id)):directory()) : '<p class="empty" role="status">Loading integrations…</p>';}
  function render(id){
    load().then(()=>{
      if(UI.route().page!=='integrations'||UI.route().id!==id)return;
      document.querySelector('#main').innerHTML=page(id);
      if(id){const crumb=document.querySelector('.crumb-current');if(crumb&&apps.has(id))crumb.textContent=apps.get(id).name;}
      else results();
    }).catch(()=>{if(UI.route().page==='integrations')document.querySelector('#main').innerHTML='<div class="empty">The integrations directory could not be loaded. <button class="btn" data-dir-retry>Retry</button></div>';});
  }
  window.AirportDirectory={page,render,service,app:slug=>apps.get(slug)};
  document.addEventListener('input',e=>{if(e.target.id==='directory-search'){filters.search=e.target.value;filters.page=1;results();}});
  document.addEventListener('change',e=>{
    if(!['directory-filter','directory-category'].includes(e.target.id))return;
    filters[e.target.id==='directory-filter'?'auth':'category']=e.target.value;filters.page=1;results();
  });
  document.addEventListener('click',e=>{
    if(e.target.closest('[data-dir-retry]'))return render(UI.route().id);
    if(e.target.closest('[data-dir-reset]')){Object.assign(filters,{page:1,category:'',auth:'',search:''});UI.refresh();return;}
    const b=e.target.closest('[data-dir-page]');if(b){filters.page+=Number(b.dataset.dirPage);results();document.querySelector('.directory').scrollIntoView({block:'start'});}
  });
})();
