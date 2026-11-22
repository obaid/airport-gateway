(() => {
  'use strict';
  const directory=window.AirportDiscovery, views=new WeakMap(), preferences=new Map();
  const published=Object.values(directory.apps).sort((a,b)=>a.name.localeCompare(b.name)||a.slug.localeCompare(b.slug));
  const pageSize=24;
  const schemes={API_KEY:'API key',OAUTH2:'OAuth',OAUTH1:'OAuth 1',BASIC:'Basic auth',BASIC_AUTH:'Basic auth',BEARER_TOKEN:'Bearer token',DCR_OAUTH:'Dynamic OAuth',NO_AUTH:'No sign-in'};
  const link=slug=>'#integrations?app='+encodeURIComponent(slug);
  function auth(item){
    if(item.requiresAuth===false || item.authSchemes?.includes('NO_AUTH'))return 'No sign-in';
    if(item.managedAuthSchemes?.includes('OAUTH2')||item.managedAuth)return 'Managed OAuth';
    return (item.authSchemes||[]).map(s=>schemes[s]||s).join(', ')||'Provider sign-in';
  }
  function enriched(row){
    const base=directory.apps[row.slug]||{};
    return {...base,...row,categories:row.categories||base.categories||[],description:row.description||base.description||''};
  }
  const mark=(ctx,a,size=26)=>{
    const src=directory.marks[a.slug];
    if(typeof src==='string'&&src.startsWith('data:image/png;base64,'))return `<span class="dir-logo real-mark"><img width="${size}" height="${size}" alt="" src="${ctx.escape(src)}"></span>`;
    return `<span class="dir-logo dir-initial" aria-hidden="true">${ctx.escape(String(a.name||a.slug).slice(0,2).toUpperCase())}</span>`;
  };
  function card(ctx,a){
    const metadata=[Number.isFinite(a.toolsCount)?a.toolsCount.toLocaleString()+(a.toolsCount===1?' tool':' tools'):'',auth(a)].filter(Boolean).join(' · ');
    return `<a class="dir-card" href="${link(a.slug)}">${mark(ctx,a)}<span><strong>${ctx.escape(a.name||a.slug)}</strong><small>${ctx.escape(metadata)}</small></span>${ctx.icon('chevron-right',14)}</a>`;
  }
  function select(ctx,key,label,choices,value) {
    const {escape:e}=ctx;
    return `<label class="field"><span>${e(label)}</span><select data-int-filter="${key}">${choices.map(([k,v])=>`<option value="${e(k)}"${k===value?' selected':''}>${e(v)}</option>`).join('')}</select></label>`;
  }
  function mount(v) {
    const {ctx,pref}=v;
    v.el.innerHTML=`<div class="int-browser"><section class="popular-section"><div class="section-bar"><h2>Popular integrations</h2>
      <span class="sub" title="Composio snapshot ${ctx.escape(directory.asOf)}">By Composio usage</span></div><div class="popular-grid">${directory.popular.slice(0,6).map(k=>card(ctx,directory.apps[k])).join('')}</div></section>
      <section class="panel directory int-directory"><div class="section-bar"><h2>All integrations</h2><span class="sub" data-int-count aria-live="polite"></span></div>
      <div class="dir-controls"><label class="field"><span>Search</span><input type="search" data-int-search maxlength="200" placeholder="Name or toolkit" value="${ctx.escape(pref.search)}"></label>
      ${select(ctx,'category','Category',[['','All categories'],...directory.categories.map(c=>[c,c])],pref.category)}
      ${select(ctx,'auth','Authentication',[['','All methods'],['managed','Managed OAuth'],['key','API key'],['noauth','No sign-in']],pref.auth)}</div>
      <div data-int-notice></div><div class="int-results" aria-live="polite"></div><div class="int-pager" aria-label="Integration pages"></div></section></div>`;
    const input=v.el.querySelector('[data-int-search]');
    const changed=()=>{v.page=0;v.seq++;clearTimeout(v.timer);};
    input.oninput=()=>{changed();pref.search=input.value;v.timer=setTimeout(()=>load(v),180);};
    v.el.onchange=e=>{
      const field=e.target.dataset.intFilter;
      if(field==='category'||field==='auth'){changed();pref[field]=e.target.value;load(v);}
    };
    v.el.onclick=e=>{
      const step=e.target.closest('[data-int-page]');
      if(step){v.page=Math.max(0,v.page+Number(step.dataset.intPage));load(v).then(()=>{if(ctx.isCurrent())v.el.querySelector('.int-directory')?.scrollIntoView({block:'start'});});}
      if(e.target.closest('[data-int-clear]')){
        Object.assign(pref,{category:'',auth:'',search:''});v.page=0;clearTimeout(v.timer);mount(v);v.el.querySelector('[data-int-search]').focus();
      }
      if(e.target.closest('[data-int-retry]')){v.pool=null;v.offline=false;v.page=0;load(v);}
    };
    load(v);
  }
  function matches(item,pref) {
    return (!pref.category||item.categories?.includes(pref.category)) && (!pref.auth || (pref.auth==='managed'&&auth(item)==='Managed OAuth') ||
      (pref.auth==='key'&&item.authSchemes?.includes('API_KEY')) || (pref.auth==='noauth'&&auth(item)==='No sign-in'));
  }
  function local(v){
    const q=v.pref.search.trim().toLowerCase();
    return published.filter(a=>(!q||(a.name+' '+a.slug).toLowerCase().includes(q))&&matches(a,v.pref));
  }
  function poolFor(v,query) {
    if(v.pool?.query!==query)v.pool={query,items:[],seen:new Set(),cursors:new Set(),cursor:null,done:false,pending:null};
    return v.pool;
  }
  async function nextBatch(v,pool){
    if(pool.pending)return pool.pending;
    pool.pending=v.ctx.request('catalog',{workspace:v.ctx.workspace.id,search:pool.query||undefined,cursor:pool.cursor||undefined})
      .then(result=>{
        for(const raw of result.items){if(!pool.seen.has(raw.slug)){pool.seen.add(raw.slug);pool.items.push(enriched(raw));}}
        pool.cursor=result.nextCursor||null;
        if(pool.cursor&&pool.cursors.has(pool.cursor))throw Error('Repeated provider cursor');
        if(pool.cursor)pool.cursors.add(pool.cursor);
        pool.done=!pool.cursor;
      }).finally(()=>{pool.pending=null;});
    return pool.pending;
  }
  async function load(v){
    const seq=++v.seq, {el,ctx}=v;
    const current=()=>seq===v.seq&&ctx.isCurrent()&&views.get(el)===v;
    if(!current())return;
    const listing=el.querySelector('.int-results'), pager=el.querySelector('.int-pager');
    if(!listing)return;
    const offset=v.page*pageSize;
    const exclude=new Set(!v.pref.search.trim()&&!v.pref.category&&!v.pref.auth ? directory.popular.slice(0,6):[]);
    const filtered=(source,complete)=>{
      const items=source.filter(a=>matches(a,v.pref));
      if(!exclude.size)return items;
      const rest=items.filter(a=>!exclude.has(a.slug));
      return complete?rest.concat(items.filter(a=>exclude.has(a.slug))):rest;
    };
    let rows,finished;
    listing.setAttribute('aria-busy','true');listing.innerHTML='<p class="int-note">Loading integrations…</p>';pager.replaceChildren();
    if(ctx.state.ready&&!v.offline){
      const pool=poolFor(v,v.pref.search.trim());
      try{
        rows=filtered(pool.items,pool.done);
        while(rows.length<=offset+pageSize&&!pool.done){
          await nextBatch(v,pool);if(!current())return;
          rows=filtered(pool.items,pool.done);
        }
        finished=pool.done;
      }catch{if(!current())return;v.offline=true;v.page=0;}
    }
    if(!ctx.state.ready||v.offline){rows=filtered(local(v),true);finished=true;}
    if(!current())return;
    const start=Math.min(v.page*pageSize,Math.max(0,Math.floor((rows.length-1)/pageSize))*pageSize);
    v.page=Math.floor(start/pageSize);
    const slice=rows.slice(start,start+pageSize);
    const total=finished?rows.length:null;
    const {escape:esc,icon}=ctx;
    const label=total===null?'Live catalog':total.toLocaleString()+(total===1?' integration':' integrations');
    el.querySelector('[data-int-count]').textContent=label;
    el.querySelector('[data-int-notice]').innerHTML=v.offline?'<p class="int-note">The live catalog is unavailable. Showing the published directory. <button data-int-retry type="button">Retry live catalog</button></p>':
      !ctx.state.ready?'<p class="int-note">Published directory. Sign-in becomes available when Airport’s provider is configured.</p>':'';
    listing.removeAttribute('aria-busy');
    listing.innerHTML=slice.map(a=>card(ctx,a)).join('')||`<div class="empty"><strong>No matching integrations</strong><p>Try another search or clear the filters.</p><button class="button" type="button" data-int-clear>Clear filters</button></div>`;
    if(!slice.length)return;
    const pages=finished?Math.ceil(rows.length/pageSize):null;
    pager.innerHTML=`<span class="sub">${start+1}–${start+slice.length}${pages?' of '+rows.length.toLocaleString():''}</span><div>
      <button class="button" type="button" data-int-page="-1" aria-label="Previous page" ${v.page===0?'disabled':''}>${icon('chevron-left',14)}Previous</button>
      <span class="pager-index">${v.page+1}${pages?' / '+esc(pages):''}</span><button class="button" type="button" data-int-page="1" aria-label="Next page" ${finished&&start+slice.length>=rows.length?'disabled':''}>Next${icon('chevron-right',14)}</button></div>`;
  }
  function accounts(ctx,slug) {
    const w=ctx.workspace;
    const rows=(ctx.state.connections||[]).filter(c=>c.workspace===w.id&&c.toolkit===slug&&['active','pending'].includes(c.status));
    if(slug==='gmail'&&['active','pending','mismatch'].includes(w.status))rows.unshift({id:'pilot-gmail',label:w.email||w.expectedEmail||'Gmail inbox',status:w.status});
    return rows;
  }
  async function detail(v,slug) {
    const {ctx,el}=v,{escape:esc,icon}=ctx;
    const seq=++v.seq, current=()=>seq===v.seq&&views.get(el)===v&&ctx.isCurrent();
    const known=directory.apps[slug];
    function paint(a,live){
      if(!current())return;
      let linked=accounts(ctx,slug);
      const reference=known?`<a class="text-btn int-reference" href="https://docs.composio.dev/toolkits/${encodeURIComponent(slug)}" target="_blank" rel="noopener noreferrer">Tool reference ${icon('arrow-up-right',14)}</a>`:'';
      el.innerHTML=`<div class="int-detail"><section class="panel integration-detail"><div class="panel-head"><h2>${known?'Integration details':esc(a.name||a.slug)}</h2>${reference}</div><div class="panel-inner">
        ${a.description?`<p class="app-description">${esc(a.description)}</p>`:''}<dl class="facts"><div><dt>Available tools</dt><dd>${Number.isFinite(a.toolsCount)?a.toolsCount.toLocaleString():'See connected tools'}</dd></div>
        <div><dt>Authentication</dt><dd>${esc(auth(a))}</dd></div><div><dt>Toolkit</dt><dd><code>${esc(a.slug)}</code></dd></div></dl>
        <button class="button primary" type="button" data-connect-integration ${live?'':'disabled'}>${icon('plus',15)}Connect account</button>
        ${!live?`<p class="int-note">${ctx.state.ready?'Waiting for confirmation from the live catalog.':'Airport’s provider must be configured before connecting an account.'}</p>`:''}</div></section>
        <section class="panel linked-accounts"><div class="panel-head"><h2>Accounts in ${esc(ctx.workspace.name)}</h2></div>
        ${linked.map(c=>{
          const needsAccess=c.id!=='pilot-gmail'&&!c.accessMode&&!(c.tools||[]).some(t=>t.allowed||t.enabled);
          const status=c.status==='active'?(needsAccess?'Connected · Set up access':'Connected'):c.status==='pending'?'Awaiting sign-in':'Address mismatch';
          return `<a class="linked-account" href="#connections/${encodeURIComponent(c.id)}/settings"><span>${esc(c.label||a.name)}</span><span class="int-status">${status}</span>${icon('chevron-right',14)}</a>`;
        }).join('')||'<p class="empty">No accounts connected.</p>'}</section></div>`;
      el.onclick=e=>{if(live&&current()&&e.target.closest('[data-connect-integration]'))ctx.connectToolkit(a);};
    }
    if(known)paint(known,false);
    else el.innerHTML='<p class="int-note">Looking up this integration…</p>';
    if(!ctx.state.ready&&known)return;
    try{
      let cursor;const seen=new Set();
      do{
        const result=await ctx.request('catalog',{workspace:ctx.workspace.id,search:slug,cursor});
        if(!current())return;
        const row=result.items.find(a=>a.slug===slug);
        if(row){paint(enriched(row),ctx.state.ready&&result.source!=='directory');return;}
        cursor=result.nextCursor;
        if(!cursor||seen.has(cursor))break;
        seen.add(cursor);
      }while(cursor);
      el.innerHTML='<div class="panel empty"><strong>Integration unavailable</strong><p>This app is unavailable in the current project catalog.</p><a class="button" href="#integrations">All integrations</a></div>';
    }catch{
      if(current()){el.innerHTML='<div class="panel empty"><strong>The live catalog could not be reached.</strong><p>Retry to check this integration.</p><button class="button" data-int-retry>Retry</button></div>';el.querySelector('[data-int-retry]').onclick=()=>detail(v,slug);}
    }
  }
  function render(el,ctx) {
    const slug=ctx.route.query.get('app')||ctx.route.id||'', key=ctx.workspace.id+'/'+slug;
    let v=views.get(el);
    const signature=JSON.stringify([ctx.state.ready,ctx.workspace.status,ctx.workspace.email,ctx.workspace.expectedEmail,(ctx.state.connections||[]).filter(c=>c.workspace===ctx.workspace.id).map(c=>[c.id,c.label,c.toolkit,c.status])]);
    if(v?.key===key){
      v.ctx=ctx;
      if(v.signature!==signature){v.signature=signature;v.offline=false;if(slug)detail(v,slug);else load(v);}
      return;
    }
    if(v)clearTimeout(v.timer);
    const pref=preferences.get(ctx.workspace.id)||{search:'',category:'',auth:''};preferences.set(ctx.workspace.id,pref);
    v={el,ctx,pref,key,signature,seq:0,page:0,offline:false,pool:null};views.set(el,v);
    if(slug)detail(v,slug);else mount(v);
  }
  (window.AirportPages ||= {}).integrations={render};
})();
