(() => {
  'use strict';
  const pages=window.AirportPages ||= {};
  const mounts=new WeakMap(), drafts=new Map(), groups=new WeakMap();
  const PILOT='pilot-gmail', tabs=['tools','settings','activity'];
  const accessModes={
    'read-only':{name:'Read only',description:'Find and read information.'},
    'write-only':{name:'Write only',description:'Create or change content.'},
    'read-write':{name:'Read and write',description:'Read information and make changes.'},
    custom:{name:'Custom',description:'Choose individual tools yourself.'}
  };
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const title=v=>String(v??'').replace(/_/g,' ').replace(/^\w/,x=>x.toUpperCase());
  const appName=c=>window.AirportDiscovery?.apps?.[c.toolkit]?.name||(c.toolkit==='gmail'?'Gmail':title(c.toolkit));
  const count=(n,s)=>n+' '+s+(n===1?'':'s');
  const stamp=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?'':d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});};
  const connectionHref=(ctx,id,tab)=>esc(ctx.href('connections/'+encodeURIComponent(id)+'/'+tab));
  const action=(key,text,kind='',disabled=false)=>`<button type="button" data-cp="${esc(key)}" class="button ${kind}" ${disabled?'disabled':''}>${esc(text)}</button>`;
  function live(v){return mounts.get(v.el)===v && v.el.isConnected && v.ctx.isCurrent();}
  function pins(v){return new Map((v.c?.tools||[]).filter(t=>t.allowed||t.enabled).map(t=>[t.slug,t]));}
  const catalogId=c=>c.pilot?c.connectionId:c.id;
  function listAccounts(v){
    const w=v.ctx.workspace;
    const list=(v.ctx.state.connections||[]).filter(c=>c.workspace===w.id);
    if(w.status && w.status!=='disconnected' || v.ctx.route.id===PILOT)
      list.unshift({...w.gmailCatalog,id:PILOT,label:w.email||w.expectedEmail||'Gmail inbox',toolkit:'gmail',status:w.status,pilot:true});
    return list;
  }
  function accessType(t){
    const types={read:'Read only',write:'Can write',manual:'Individual review',restricted:'Restricted'};
    if(Object.hasOwn(types,t.presetClass))return types[t.presetClass];
    const tags=new Set((Array.isArray(t.tags)?t.tags:[]).map(s=>String(s).toLowerCase()));
    if(t.annotations?.destructiveHint===true || tags.has('destructivehint') || tags.has('writehint'))return 'Can write';
    if(t.annotations?.readOnlyHint===true || tags.has('readonlyhint'))return 'Read only';
    return '';
  }
  function begin(el,ctx,mode){
    const key=JSON.stringify([ctx.workspace.id,mode,ctx.route.id||'',ctx.route.tab||'tools',ctx.route.detail,ctx.route.id===PILOT?ctx.workspace.gmailCatalog?.connectionId:null]);
    let v=mounts.get(el);
    if(v?.key===key){v.ctx=ctx;return v;}
    v={key,el,ctx,mode,search:'',filter:'all',items:[],cursors:[''],index:0,next:null,seq:0,loading:false,
      fetched:false,error:'',notice:'',feedbackError:false,saveLock:false,checking:false,signature:'',id:'',logSearch:'',decision:'',
      accessChoice:null,accessPreview:null,accessError:'',accessLoading:false,accessSaving:false,accessMessage:''};
    mounts.set(el,v);
    // The shell keeps this element for a route. Assigning handlers also removes the previous page handlers.
    el.onclick=e=>click(v,e);
    el.onchange=e=>change(v,e);
    el.onsubmit=e=>{
      if(!e.target.matches('[data-cp-search]'))return;
      e.preventDefault();setSearch(v,e.target.elements.search.value);
    };
    el.oninput=e=>{
      if(e.target.matches('[data-cp-logsearch]')){v.logSearch=e.target.value;paint(v);return;}
      if(!e.target.matches('[data-cp-query]'))return;
      v.input=e.target.value;
      clearTimeout(v.timer);v.timer=setTimeout(()=>{if(live(v))setSearch(v,v.input);},270);
    };
    el.classList.add('cp-page');
    return v;
  }
  function render(el,ctx,mode,group=null){
    const v=begin(el,ctx,mode), accounts=listAccounts(v);
    v.group=group;
    const id=ctx.route.id;
    const c=accounts.find(a=>a.id===id);
    if(v.id!==id){
      v.id=id;v.seq++;v.fetched=false;v.loading=false;v.items=[];v.cursors=[''];v.index=0;v.next=null;
      v.search='';v.input='';v.filter='all';v.error='';v.notice='';v.signature='';
    }
    if(v.c?.status==='pending' && c?.status!=='pending'){v.notice='';v.feedbackError=false;}
    v.c=c;v.accounts=accounts;
    v.tab=mode==='policies'?'tools':tabs.includes(ctx.route.tab)?ctx.route.tab:'tools';
    v.advanced=mode==='policies'||(v.tab==='tools'&&ctx.route.detail==='advanced');
    if(c&&v.tab==='tools'&&!v.advanced){
      const savedMode=currentMode(v);
      if(v.savedMode!==savedMode){
        v.savedMode=savedMode;
        v.accessChoice=savedMode==='custom'?null:savedMode||'read-only';
      }
    }
    const draftKey=JSON.stringify([ctx.workspace.id,id,c?.pilot?c.connectionId:null]);
    if(!drafts.has(draftKey))drafts.set(draftKey,new Map());
    v.draft=drafts.get(draftKey);
    // Leave active fields, focus, paging and staged changes intact during background state polling.
    const sig=JSON.stringify([accounts.map(x=>[x.id,x.label,x.status]),c?.tools,c?.accessMode,ctx.workspace.policy,ctx.workspace.email,
      ctx.state.ready,v.tab==='activity'&&ctx.state.logs]);
    if(v.signature!==sig){v.signature=sig;paint(v);}
    if(c?.status==='active'&&catalogId(c)&&v.tab==='tools'&&!v.advanced&&!v.accessPreview&&!v.accessError&&!v.accessLoading&&!v.accessSaving)loadAccess(v);
    if(c&&v.advanced&&(!group||group.visible.has(id))&&catalogId(c)&&v.filter!=='allowed'&&!v.fetched&&!v.loading&&c.status==='active')load(v);
  }
  function identity(v){
    const c=v.c;
    return `<nav class="cp-tabs section-tabs" aria-label="Connection sections">${tabs.map(t=>`<a href="${connectionHref(v.ctx,c.id,t)}" ${t===v.tab?'aria-current="page"':''}>${t==='tools'?'Tool access':esc(title(t))}</a>`).join('')}</nav>`;
  }
  function currentMode(v){
    return Object.hasOwn(accessModes,v.c.accessMode)?v.c.accessMode:pins(v).size?'custom':null;
  }
  function accessSection(v){
    const c=v.c,allowed=pins(v).size,mode=currentMode(v),workspace=esc(v.ctx.workspace.name);
    if(c.pilot&&c.status==='active'&&!catalogId(c)){
      return `<section class="cp-panel cp-empty"><h3>Airport inbox counts</h3><p>The inbox counter is ${v.ctx.workspace.policy==='Allow'?'allowed':'blocked'} in ${workspace}.</p><a class="button minor" href="${connectionHref(v.ctx,v.id,'tools/advanced')}">Customize individual tools</a></section>`;
    }
    if(c.status!=='active'){
      return `<section class="cp-panel cp-empty"><h3>Tool access</h3><p>Verify the connection to choose access for agents in ${workspace}.</p><a class="button minor" href="${connectionHref(v.ctx,v.id,'settings')}">Connection settings</a></section>`;
    }
    const choice=v.accessChoice,preview=v.accessPreview,selection=preview?.presets?.[choice];
    const counter=c.pilot?`<span class="cp-counter-summary">Airport inbox counts ${v.ctx.workspace.policy==='Allow'?'allowed':'blocked'} separately</span>`:'';
    const summary=mode?`${accessModes[mode].name} · ${count(allowed,c.pilot?'catalog tool':'tool')} allowed`:`No preset applied · ${count(allowed,c.pilot?'catalog tool':'tool')} allowed`;
    const toolsLink=`<a class="cp-text-link" href="${connectionHref(v.ctx,v.id,'tools/advanced')}">Customize individual tools ${v.ctx.icon('chevron-right',14)}</a>`;
    const message=v.accessMessage?`<p class="cp-access-message" role="status">${esc(v.accessMessage)}</p>`:'';
    const head=`<div class="cp-access-head"><span class="cp-access-mark">${v.ctx.icon('policies',22)}</span><div><h3>Access presets</h3><p>Choose what agents in ${workspace} can do with this ${esc(appName(c))} account.</p></div></div>
      <p class="cp-current-access"><span>Current access</span><strong>${summary}</strong>${counter}</p>`;
    const controls=Object.entries(accessModes).filter(([key])=>key!=='custom').map(([key,option])=>{
      const num=preview?.presets?.[key]?.allowed;
      return `<label class="cp-access-option"><input type="radio" name="connection-access" data-access-preset="${key}" value="${key}" ${choice===key?'checked':''} ${v.accessSaving?'disabled':''}>
        <span><strong>${option.name}</strong>${key==='read-only'&&num>0?'<small class="cp-recommended">Recommended</small>':''}
        <span class="cp-option-description">${option.description}</span>${Number.isInteger(num)?`<span class="cp-option-count">${count(num,'tool')}</span>`:''}</span></label>`;
    }).join('');
    let review='';
    if(selection){
      const examples=preview.examples||{};
      const names=[...(choice==='write-only'?[]:examples.read||[]),...(choice==='read-only'?[]:examples.write||[])];
      review=`<p><strong>${count(selection.allowed,'tool')} will be allowed.</strong> ${Number(selection.added)||0} to add · ${Number(selection.removed)||0} to remove.</p>
        ${names.length?`<p>Includes ${esc(names.join(', '))}.</p>`:''}
        ${selection.allowed===0?'<p>This preset has no eligible tools. Open Advanced to review individual tools.</p>':''}
        ${preview.manualOnly||preview.restricted?`<p class="cp-exclusions">${[preview.manualOnly?count(preview.manualOnly,'tool')+(preview.manualOnly===1?' requires':' require')+' individual review (including destructive or unclassified actions).':'',preview.restricted?count(preview.restricted,'tool')+(preview.restricted===1?' is':' are')+' restricted by Airport.':''].filter(Boolean).join(' ')}</p>`:''}
        ${mode&&selection.removed?`<p>Applying this preset replaces your current tool selection.</p>`:''}`;
    }
    const error=v.accessError?`<div class="cp-access-error" role="alert">${esc(v.accessError)} ${action('retry-access','Reload preview','minor')}</div>`:'';
    const draft=v.draft.size?`<p class="cp-draft-warning">Save or discard your ${count(v.draft.size,'unsaved tool change')} in Advanced before applying a preset.</p>`:'';
    const applied=selection&&choice===mode&&selection.added===0&&selection.removed===0;
    const disabled=!selection||applied||v.accessSaving||!!draft;
    const buttonLabel=v.accessSaving?'Saving…':applied?'Preset applied':choice?'Apply '+accessModes[choice].name.toLowerCase():'Apply preset';
    const reviewBody=(v.accessLoading?'<p>Checking available tools…</p>':'')+review+error+draft;
    return `<section class="cp-panel cp-access" data-access-setup>${head}${message}
      <fieldset class="cp-access-options"><legend class="cp-sr">Agent access level</legend>${controls}</fieldset>
      ${reviewBody?`<div class="cp-access-review" aria-live="polite">${reviewBody}</div>`:''}
      <div class="cp-access-actions"><button type="button" class="button primary" data-access-apply ${disabled?'disabled':''}>${buttonLabel}</button></div></section>
      <section class="cp-panel cp-advanced"><div><h3>Advanced</h3><p>Search ${Number.isInteger(preview?.total)?'all '+count(preview.total,'catalog tool'):'the catalog'} and allow or block individual tools.${c.pilot?' Google’s account permissions also apply.':''}</p></div>${toolsLink}</section>`;
  }
  async function loadAccess(v){
    if(v.accessLoading||v.accessSaving)return;
    v.accessLoading=true;v.accessError='';v.accessPreview=null;paint(v);
    try{
      const preview=await v.ctx.request('connection-access-preview',{workspace:v.ctx.workspace.id,connectionId:catalogId(v.c)});
      if(!live(v))return;
      if(!preview.previewId||!preview.presets?.['read-only'])throw new Error('Airport could not confirm the available tools.');
      v.accessPreview=preview;
    }catch(e){if(live(v))v.accessError=e.message||'Could not load the access preview.';}
    finally{if(live(v)){v.accessLoading=false;paint(v);}}
  }
  async function saveAccess(v){
    const mode=v.accessChoice;
    if(v.accessSaving||v.accessLoading||v.c.status!=='active'||v.draft.size||!v.accessPreview?.presets?.[mode])return;
    v.accessSaving=true;v.accessError='';v.accessMessage='';paint(v);
    try{
      const result=await v.ctx.request('connection-access-apply',{workspace:v.ctx.workspace.id,connectionId:catalogId(v.c),mode,previewId:v.accessPreview.previewId});
      if(!live(v))return;
      v.accessPreview=null;
      v.accessMessage=`${accessModes[mode].name} saved. ${count(result.allowed,'tool')} allowed.`;
      try{await v.ctx.refresh();}catch{
        if(!live(v))return;
        v.accessError='Could not refresh the account details. Reload the preview to review the current selection.';
        return;
      }
    }catch(e){
      if(!live(v))return;
      v.accessError=e.message||'Could not save agent access. Review a fresh preview and try again.';
      v.accessPreview=null;
    }finally{
      if(live(v)){
        v.accessSaving=false;
        if(v.accessError)paint(v);else loadAccess(v);
      }
    }
  }
  function settings(v){
    const c=v.c,active=c.status==='active',pending=c.status==='pending',gone=!active&&!pending;
    if(c.pilot)return ''; // The workspace shell renders the original Gmail account settings.
    const status={active:'Connected',pending:'Awaiting sign-in',disabled:'Disconnected'}[c.status]||title(c.status);
    const next=gone?`<a class="button primary" href="${esc(v.ctx.href('integrations?app='+encodeURIComponent(c.toolkit)))}">Connect another account</a>`:action('check',v.checking?'Checking…':pending?'Check sign-in':'Check connection','minor',v.checking);
    return `<section class="cp-panel setting-panel"><div class="cp-section-head"><h3>Account settings</h3></div><div class="cp-settings-form">
      <div class="cp-field"><span>Account label</span><strong class="cp-label-value">${esc(c.label)}</strong></div>
      <dl class="cp-facts"><div><dt>Workspace</dt><dd>${esc(v.ctx.workspace.name)}</dd></div><div><dt>App</dt><dd>${esc(appName(c))}</dd></div><div><dt>Status</dt><dd>${esc(status)}</dd></div></dl>
      ${pending?'<p class="cp-hint">Finish signing in with the provider. Airport will verify the connection and open Tool access.</p>':''}${next}${gone?'<p class="cp-hint">A new sign-in creates a separate connection with its own tool permissions.</p>':''}</div></section>
      ${!gone?`<section class="cp-panel cp-danger disconnect-row"><div><h3>${pending?'Cancel connection':'Disconnect account'}</h3><p>${pending?'Cancel this pending sign-in.':'Remove this account and its permissions from '+esc(v.ctx.workspace.name)+'. Its request history remains available.'}</p></div>${action('disconnect',pending?'Cancel sign-in':'Disconnect','minor')}</section>`:''}`;
  }
  function activity(v){
    const c=v.c,allowedNames=new Set((c.tools||[]).map(t=>t.mcpName));
    const entries=(v.ctx.state.logs||[]).filter(l=>l.workspace===v.ctx.workspace.id && (
      (c.pilot&&['gmail_inbox_counts','gmail_send_email'].includes(l.tool))||
      (catalogId(c)&&l.exchange?.request?.connection?.id===catalogId(c))||allowedNames.has(l.tool)));
    if(!entries.length)return '<section class="cp-panel cp-empty"><h3>No requests yet</h3><p>Requests for this account will appear here.</p></section>';
    const outcomes=[...new Set(entries.map(l=>l.outcome))].sort();
    const q=v.logSearch.trim().toLowerCase(),shown=entries.filter(l=>(!v.decision||l.outcome===v.decision)&&
      [l.actor,l.tool,l.exchange?.request?.operation?.slug,l.outcome,appName(c),c.label].filter(Boolean).join(' ').toLowerCase().includes(q));
    return `<div class="cp-logfilters request-filters"><label class="cp-field"><span>Search requests</span><input data-cp-logsearch type="search" value="${esc(v.logSearch)}" placeholder="Agent, service or tool"></label>
      <label class="cp-field"><span>Decision</span><select data-cp-decision><option value="">All decisions</option>${outcomes.map(x=>`<option ${x===v.decision?'selected':''} value="${esc(x)}">${esc(x)}</option>`).join('')}</select></label></div>
      <section class="cp-panel"><div class="cp-section-head"><h3>Requests</h3><span>${shown.length}</span></div><div class="cp-feed">${shown.map(l=>{
        const slug=l.exchange?.request?.operation?.slug||l.tool,op=(c.tools||[]).find(t=>t.slug===slug||t.mcpName===slug);
        const name=op?.name||slug.replace(/^gmail_/i,'').replace(/_/g,' ').toLowerCase();
        return `<a class="cp-request request-row" href="${esc(v.ctx.href('activity/'+encodeURIComponent(l.id)))}"><span><strong>${esc(title(name))}</strong><small>${esc(l.actor)} → ${esc(appName(c))}</small></span><span class="cp-outcome" data-tone="${l.outcome==='Allowed'?'allow':l.outcome==='Blocked'?'block':'neutral'}">${esc(l.outcome)}</span><time>${esc(stamp(l.at))}</time>${v.ctx.icon('chevron-right',15)}</a>`;
      }).join('')||'<p class="cp-empty">No matching requests. Try another search or decision.</p>'}</div></section>`;
  }
  function inboxCounter(v){
    const slug='gmail_inbox_counts',current=v.ctx.workspace.policy==='Allow',staged=v.draft.get(slug);
    return {slug,name:'Airport inbox counts',description:'Read the total and unread counts in this inbox.',builtin:true,
      tags:['readOnlyHint'],latest:'',current,staged,value:staged?.allow??current};
  }
  function listed(v){
    const pinned=pins(v),text=v.search.toLowerCase(),incoming=new Map(v.items.map(t=>[t.slug,t]));
    let rows;
    if(v.filter==='allowed' || v.error){
      rows=[...pinned.values()].map(p=>incoming.get(p.slug)||{...p,local:true,approvedVersion:p.version});
    }else rows=v.items;
    return rows.map(t=>{
      const pin=pinned.get(t.slug), current=!!pin, latest=t.local?pin?.version:t.version;
      const staged=v.draft.get(t.slug),value=staged?staged.allow:current;
      return {...t,current,latest,pinned:pin?.version,staged,value};
    }).filter(t=>{
      if((v.filter==='allowed'||v.error)&&text && !(t.slug+' '+t.name+' '+(t.description||'')).toLowerCase().includes(text))return false;
      return v.filter==='allowed'?t.current||t.staged?.allow:v.filter==='blocked'?!t.current||t.staged?.allow===false:true;
    });
  }
  function toolRow(v,t){
    const kind=accessType(t),disabled=(v.saveLock||v.group?.saving) || (!t.staged && !t.value && (!!t.unsupportedReason||v.c.status!=='active'));
    const different=t.pinned && t.latest && t.pinned!==t.latest && !t.local;
    const unsupported=t.unsupportedReason||'';
    return `<div class="cp-tool permission-row ${t.staged?'is-staged':''}"><div class="cp-tool-txt"><div class="cp-tool-title"><strong>${esc(t.name||t.slug)}</strong>${kind?`<span class="cp-kind">${esc(kind)}</span>`:''}</div>
      <code title="${esc(t.description||'')}">${esc(t.slug)}</code>${unsupported?`<small>${esc(unsupported)}</small>`:''}
      ${different?`<small>Approved ${esc(t.pinned)} · Available ${esc(t.latest)} ${!unsupported?`<button data-cp-upgrade="${esc(t.slug)}" type="button" ${v.saveLock?'disabled':''}>Use available version</button>`:''}</small>`:''}
      ${t.staged?.error?`<small class="cp-error" role="alert">${esc(t.staged.error)}</small>`:''}</div>
      <div class="cp-permission"><select aria-label="${esc(v.c.label)} permission for ${esc(t.name||t.slug)}" data-cp-tool="${esc(t.slug)}" ${disabled?'disabled':''}><option value="allow" ${t.value?'selected':''}>Allow</option><option value="block" ${!t.value?'selected':''}>Block</option></select>${t.staged?'<small>Unsaved</small>':''}</div></div>`;
  }
  function saveBar(pending,saving){
    return `<div class="cp-savebar policy-save"><span role="status">${pending?count(pending,'unsaved change'):'All changes saved'}</span>${action('discard','Discard','minor',!pending||saving)}${action('save',saving?'Saving…':'Save changes','primary',!pending||saving)}</div>`;
  }
  function editor(v){
    const pending=v.draft.size,rows=listed(v),active=v.c.status==='active',canFetch=catalogId(v.c) && active && v.filter!=='allowed';
    const allowed=pins(v).size;
    const scope=v.search?'matching tool':'catalog tool';
    const totals=Number.isInteger(v.total)&&v.filter==='all'?`${count(v.total,scope)} · ${allowed} allowed`:count(allowed,'allowed tool');
    const counter=v.c.pilot?`<section class="cp-panel" data-pilot-access>${toolRow(v,inboxCounter(v))}</section>`:'';
    const actions=v.group?'':saveBar(pending,v.saveLock);
    if(v.c.pilot&&!catalogId(v.c))return `${actions}${counter}<section class="cp-panel cp-empty"><h3>Gmail tools</h3><p>Verify the Gmail account to manage its catalog tools.</p><a class="button minor" href="${connectionHref(v.ctx,v.id,'settings')}">Gmail settings</a></section>`;
    return `${actions}${counter}<section class="cp-panel cp-editor perm-group"><div class="cp-section-head">${v.group?
      `<div class="cp-bare">${v.ctx.logo(v.c.toolkit,26)}<div><h3>${esc(appName(v.c))}</h3><p>${esc(v.c.label)}</p></div></div><a class="cp-text-link" href="${connectionHref(v.ctx,v.c.id,'tools/advanced')}">Account tools ${v.ctx.icon('chevron-right',14)}</a>`:
      `<h3>${v.c.pilot?'Gmail tools':'Tool permissions'}</h3><span>${totals}</span>`}</div>
      ${active?`<div class="cp-editor-guide"><span>${v.c.pilot?'Choose the tools agents can use with this Google account. Google’s permissions also apply.':'Allow or block individual tools for this account.'}</span><a class="cp-text-link" href="${connectionHref(v.ctx,v.id,'tools')}">Access presets ${v.ctx.icon('chevron-right',14)}</a></div>`:''}
      <div class="cp-toolbar"><form data-cp-search role="search"><span aria-hidden="true">${v.ctx.icon('search',17)}</span><input data-cp-query aria-label="Search tools" name="search" type="search" placeholder="Search tools" value="${esc(v.input??v.search)}" maxlength="200"></form>
      <label><span class="cp-sr">Filter by access</span><select data-cp-filter>${[['all','All tools'],['allowed','Allowed'],['blocked','Blocked']].map(([k,n])=>`<option value="${k}" ${k===v.filter?'selected':''}>${n}</option>`).join('')}</select></label></div>
      ${v.error?`<div class="cp-warning" role="alert">${esc(v.error)} ${action('retry','Retry','minor')}<small>Existing permissions can still be blocked.</small></div>`:''}
      ${(v.loading || (canFetch && !v.fetched)) && !rows.length?'<p class="cp-empty" role="status">Loading tools…</p>':rows.length?`<div class="cp-tools">${rows.map(t=>toolRow(v,t)).join('')}</div>`:`<p class="cp-empty">${!active&&!v.c.pilot?'Verify this connection to manage its tools.':v.filter==='allowed'?'No allowed tools match this view.':v.filter==='blocked' && v.next?'No blocked tools on this page.':'No tools match this view.'}</p>`}
      ${canFetch && (v.index||v.next)?`<div class="cp-pager"><span>Page ${v.index+1}</span><div>${action('previous','Previous','minor',!v.index||v.loading||v.saveLock)}${action('next','Next','minor',!v.next||v.loading||v.saveLock)}</div></div>`:''}
      </section>`;
  }
  function paint(v){
    if(!live(v))return;
    const focused=v.el.contains(document.activeElement)?document.activeElement:null;
    const token=focused && [...focused.attributes].find(a=>a.name.startsWith('data-cp-')||a.name.startsWith('data-access-'));
    const cursor=focused?.matches('[data-cp-query],[data-cp-logsearch]')?[focused.selectionStart,focused.selectionEnd]:null;
    if(!v.c){v.el.innerHTML=`<div class="cp-panel cp-empty"><h3>${v.ctx.route.id?'Connection unavailable':'Choose an app to manage its tools'}</h3><p>${v.ctx.route.id?'This connection is unavailable in the current workspace.':'Connect an account to set its tool permissions.'}</p><a class="button" href="${esc(v.ctx.href(v.ctx.route.id?'connections':'integrations'))}">${v.ctx.route.id?'View connections':'Browse apps'}</a></div>`;return;}
    v.el.innerHTML=(v.group?'':identity(v))+(v.tab==='settings'?settings(v):v.tab==='activity'?activity(v):v.advanced?editor(v):accessSection(v))+
      `<div class="cp-feedback ${v.feedbackError?'cp-error':''}" ${v.notice?'':'hidden'} role="${v.feedbackError?'alert':'status'}">${esc(v.notice)}</div>`;
    v.group?.sync();
    if(token){const node=[...v.el.querySelectorAll('['+token.name+']')].find(n=>n.getAttribute(token.name)===token.value);if(node&&!node.disabled){node.focus({preventScroll:true});if(cursor)try{node.setSelectionRange(...cursor);}catch{}}}
  }
  function setSearch(v,text){
    if(v.search===text)return;
    v.search=text;v.input=text;v.index=0;v.cursors=[''];v.next=null;v.error='';
    if(catalogId(v.c) && v.filter!=='allowed' && v.c.status==='active')load(v);else paint(v);
  }
  async function load(v){
    const seq=++v.seq,workspace=v.ctx.workspace.id,connectionId=catalogId(v.c);
    v.loading=true;v.fetched=true;v.error='';v.items=[];v.total=null;v.next=null;paint(v);
    try{
      const result=await v.ctx.request('connection-tools',{workspace,connectionId,search:v.search||undefined,cursor:v.cursors[v.index]||undefined});
      if(!live(v)||seq!==v.seq||catalogId(v.c)!==connectionId)return;
      v.items=Array.isArray(result.items)?result.items:[];v.next=result.nextCursor||null;v.total=result.total;
    }catch(e){if(!live(v)||seq!==v.seq)return;v.error=e.message||'Could not load the tool catalog.';v.next=null;}
    finally{if(live(v)&&seq===v.seq){v.loading=false;paint(v);}}
  }
  function stage(v,slug,upgrade=false){
    if(v.saveLock||v.group?.saving)return;
    const row=v.c.pilot&&slug==='gmail_inbox_counts'?inboxCounter(v):listed(v).find(t=>t.slug===slug);if(!row)return;
    const allow=upgrade||!row.value;
    if(row.staged && !upgrade && allow===row.current){v.draft.delete(slug);v.notice='';paint(v);return;}
    if(allow && (row.unsupportedReason || v.c.status!=='active'))return;
    if(allow===row.current && (!upgrade || !allow || row.latest===row.pinned || row.builtin))v.draft.delete(slug);
    else v.draft.set(slug,{allow,version:allow?row.latest:row.pinned,name:row.name||slug});
    v.notice='';paint(v);
  }
  async function apply(v){
    const workspace=v.ctx.workspace.id,connectionId=v.id,draft=v.draft;
    let done=0,failed=0,error='';
    for(const [slug,change] of [...draft]){
      if(!live(v)||v.id!==connectionId)break;
      try{
        if(v.c.pilot&&slug==='gmail_inbox_counts')await v.ctx.request('policy',{workspace,connectionId:catalogId(v.c),policy:change.allow?'Allow':'Block'});
        else await v.ctx.request('tool-access',{workspace,connectionId:catalogId(v.c),slug,version:change.version,allow:change.allow});
        if(draft.get(slug)===change)draft.delete(slug);
        done++;
      }catch(e){change.error=e.message||'This change could not be saved.';error=change.error;failed++;}
    }
    return {done,failed,error};
  }
  function saveNotice(done,failed,error,refreshFailed){
    return failed?`${count(done,'change')} saved. ${count(failed,'change')} still pending. ${error}`:
      refreshFailed?'Permissions saved. Refresh to verify the current settings.':count(done,'change')+' saved.';
  }
  async function save(v){
    if(v.saveLock||!v.draft.size)return;
    v.saveLock=true;v.notice='';paint(v);
    const {done,failed,error}=await apply(v);
    if(!live(v))return;
    let refreshFailed=false;
    try{await v.ctx.refresh();}catch{refreshFailed=true;}
    if(!live(v))return;
    v.saveLock=false;v.feedbackError=!!failed||refreshFailed;v.notice=saveNotice(done,failed,error,refreshFailed);paint(v);
  }
  function change(v,e){
    if(!live(v))return;
    if(e.target.matches('[data-access-preset]')&&Object.hasOwn(accessModes,e.target.value)&&!v.accessSaving){
      v.accessChoice=e.target.value;v.accessMessage='';paint(v);return;
    }
    if(e.target.matches('[data-cp-decision]')){v.decision=e.target.value;paint(v);}
    if(e.target.matches('[data-cp-tool]'))stage(v,e.target.dataset.cpTool);
    if(e.target.matches('[data-cp-filter]')){
      v.filter=e.target.value;v.seq++;v.loading=false;v.index=0;v.cursors=[''];v.next=null;v.error='';
      if(v.filter==='allowed'||!catalogId(v.c)||v.c.status!=='active')paint(v);else load(v);
    }
  }
  async function click(v,e){
    if(!live(v))return;
    const button=e.target.closest('button');if(!button||!v.el.contains(button)||button.disabled)return;

    if(button.dataset.cpUpgrade)return stage(v,button.dataset.cpUpgrade,true);
    if(button.dataset.cpLog)return v.ctx.openLog(button.dataset.cpLog);
    if(button.hasAttribute('data-access-apply'))return saveAccess(v);
    switch(button.dataset.cp){
      case 'retry-access':return loadAccess(v);
      case 'save':return save(v);
      case 'discard':if(!v.saveLock){v.draft.clear();v.notice='Changes discarded.';v.feedbackError=false;paint(v);}break;
      case 'retry':return load(v);
      case 'next':if(v.next){v.cursors.splice(v.index+1,Infinity,v.next);v.index++;return load(v);}break;
      case 'previous':if(v.index){v.index--;return load(v);}break;
      case 'disconnect':return v.ctx.manage('remove-app',v.id);
      case 'check':{
        if(v.checking)return;v.checking=true;v.notice='';paint(v);
        const id=v.id,ws=v.ctx.workspace.id;
        try{
          await v.ctx.request('connection-check',{workspace:ws,connectionId:id,pendingOnly:v.c.status==='pending'});
          if(!live(v)||v.id!==id)return;
          await v.ctx.refresh();
          if(!live(v)||v.id!==id)return;
          v.notice=v.c.status==='active'?'Connection verified.':v.c.status==='pending'?'Still waiting for the provider to finish sign-in.':'This connection is disconnected.';
          v.feedbackError=false;
        }
        catch(error){if(!live(v)||v.id!==id)return;v.notice=error.message||'Could not check this connection.';v.feedbackError=true;}
        finally{if(live(v)&&v.id===id){v.checking=false;paint(v);}}
      }
    }
  }
  function policyRoute(ctx,id,advanced=false){
    return ctx.href('policies'+(id?'/'+encodeURIComponent(id):'')+(advanced?'?view=advanced':''));
  }
  function policyAccountPicker(accounts,id,disabled=false){
    if(accounts.length<2&&!id)return '';
    return `<label class="cp-field"><span>Account</span><select data-cp-account aria-label="Account" ${disabled?'disabled':''}><option value="">All accounts</option>${accounts.map(c=>`<option value="${esc(c.id)}" ${c.id===id?'selected':''}>${esc(appName(c))} · ${esc(c.label)}</option>`).join('')}</select></label>`;
  }
  function policySummary(c,ctx){
    const active=c.status==='active',catalog=active&&catalogId(c),mode=currentMode({c});
    const status={pending:'Awaiting sign-in',disabled:'Disconnected',disconnected:'Disconnected',mismatch:'Address mismatch'};
    const pending=drafts.get(JSON.stringify([ctx.workspace.id,c.id,c.pilot?c.connectionId:null]))?.size||0;
    const allowed=count(pins({c}).size,c.pilot?'catalog tool':'tool')+' allowed';
    const counter=c.pilot&&active?`<p>Airport inbox counts ${ctx.workspace.policy==='Allow'?'allowed':'blocked'}</p>`:'';
    const draft=pending?`<p><a class="cp-text-link" href="${esc(policyRoute(ctx,c.id,true))}">${count(pending,'unsaved tool change')}</a></p>`:'';
    const summary=catalog?`<strong>${mode?esc(accessModes[mode].name):'No preset applied'}</strong> · ${allowed}`:
      active?'Inbox counts connection':esc(status[c.status]||'Connection unavailable');
    const tab=catalog?'tools':'settings',label=catalog?'Access presets':'Account settings';
    return `<section class="cp-panel"><div class="cp-section-head"><div class="cp-bare">${ctx.logo(c.toolkit,28)}<div><h3>${esc(appName(c))}</h3><p>${esc(c.label)}</p></div></div></div>
      <div class="cp-editor-guide"><div>${summary}${counter}${draft}</div><a class="cp-text-link" href="${connectionHref(ctx,c.id,tab)}">${label} ${ctx.icon('chevron-right',14)}</a></div></section>`;
  }
  function workspacePolicies(el,ctx){
    const advanced=ctx.route.query.get('view')==='advanced';
    const key=JSON.stringify([ctx.workspace.id,ctx.route.id,advanced]),accounts=listAccounts({ctx}).filter(c=>c.status!=='disabled'||c.id===ctx.route.id);
    const selected=ctx.route.id?accounts.filter(c=>c.id===ctx.route.id):accounts;
    let g=groups.get(el);
    if(g?.key!==key||!selected.length)g?.observer?.disconnect();
    if(!selected.length){
      groups.delete(el);
      el.innerHTML=`<section class="cp-panel cp-empty"><h3>${ctx.route.id?'Connection unavailable':'No connected accounts'}</h3><p>${ctx.route.id?'This account is unavailable in this workspace.':'Connect an account to choose which tools agents can use.'}</p><a class="button" href="${esc(ctx.href(ctx.route.id?'policies':'integrations'))}">${ctx.route.id?'View policies':'Browse integrations'}</a></section>`;
      el.classList.add('cp-page');return;
    }
    if(!advanced){
      const picker=policyAccountPicker(accounts,ctx.route.id);
      const html=`<div class="cp-policy-top policy-toolbar">${picker}<a class="button minor" href="${esc(policyRoute(ctx,ctx.route.id,true))}">Advanced tool editor</a></div><div class="cp-groups">${selected.map(c=>policySummary(c,ctx)).join('')}</div>`;
      if(g?.key===key&&g.stamp===html)return;
      groups.set(el,{key,stamp:html});
      el.classList.add('cp-page');el.innerHTML=html;
      const select=el.querySelector('[data-cp-account]');
      if(select)select.onchange=()=>ctx.navigate(policyRoute(ctx,select.value));
      return;
    }
    if(!g||g.key!==key){
      g={key,el,ctx,children:new Map(),visible:new Set(),saving:false,notice:'',error:false,stamp:''};
      groups.set(el,g);el.classList.add('cp-page');
      el.innerHTML='<div class="cp-policy-top policy-toolbar"></div><div class="cp-group-feedback" role="status" hidden></div><div class="cp-groups"></div>';
      const bar=el.querySelector('.cp-policy-top'),notice=el.querySelector('.cp-group-feedback');
      g.current=()=>groups.get(el)===g&&el.isConnected&&g.ctx.isCurrent();
      g.views=()=>[...g.children.values()].map(child=>mounts.get(child)).filter(Boolean);
      g.sync=()=>{
        if(!g.current())return;
        const pending=g.views().reduce((n,v)=>n+v.draft.size,0);
        const picker=policyAccountPicker(g.accounts,g.ctx.route.id,g.saving);
        const back=`<a class="cp-text-link" href="${esc(policyRoute(g.ctx,g.ctx.route.id))}">Back to access presets</a>`;
        const html=back+picker+saveBar(pending,g.saving);
        if(g.stamp!==html){g.stamp=html;bar.innerHTML=html;}
        notice.textContent=g.notice;notice.hidden=!g.notice;notice.classList.toggle('cp-error',g.error);
      };
      bar.onchange=e=>{if(e.target.matches('[data-cp-account]')&&!g.saving)g.ctx.navigate(policyRoute(g.ctx,e.target.value,true));};
      bar.onclick=async e=>{
        const b=e.target.closest('[data-cp]');if(!b||b.disabled||g.saving||!g.current())return;
        const views=g.views();
        if(b.dataset.cp==='discard'){
          g.notice='Changes discarded.';g.error=false;for(const v of views){v.draft.clear();paint(v);}g.sync();return;
        }
        if(b.dataset.cp!=='save')return;
        g.saving=true;g.notice='';for(const v of views)paint(v);g.sync();
        let done=0,failed=0,error='',refreshFailed=false;
        for(const v of views){
          if(!g.current())return;
          const r=await apply(v);done+=r.done;failed+=r.failed;if(r.error)error=r.error;
        }
        if(!g.current())return;
        try{await g.ctx.refresh();}catch{refreshFailed=true;}
        if(!g.current())return;
        g.saving=false;g.error=!!failed||refreshFailed;g.notice=saveNotice(done,failed,error,refreshFailed);
        for(const v of g.views())paint(v);g.sync();
      };
      if('IntersectionObserver' in window)g.observer=new IntersectionObserver(entries=>{
        if(!g.current()){g.observer.disconnect();return;}
        for(const e of entries)if(e.isIntersecting){
          g.observer.unobserve(e.target);
          const v=mounts.get(e.target);if(!v)continue;
          g.visible.add(v.id);if(v.c.status==='active'&&catalogId(v.c)&&!v.fetched&&v.filter!=='allowed')load(v);
        }
      },{rootMargin:'180px'});
    }
    g.ctx=ctx;g.accounts=accounts;
    const host=el.querySelector('.cp-groups'),ids=new Set(selected.map(c=>c.id));
    for(const [id,child] of g.children)if(!ids.has(id)){g.observer?.unobserve(child);child.remove();g.children.delete(id);g.visible.delete(id);}
    for(const c of selected){
      let child=g.children.get(c.id);
      if(!child){
        child=document.createElement('div');g.children.set(c.id,child);host.append(child);
        if(!g.observer||selected.length===1||c.pilot)g.visible.add(c.id);else g.observer.observe(child);
      }
      render(child,{...ctx,route:{...ctx.route,id:c.id,tab:'tools'}},'policies',g);
    }
    g.sync();
  }
  pages.connections={render:(el,ctx)=>render(el,ctx,'connections')};
  pages.policies={render:workspacePolicies};
})();
