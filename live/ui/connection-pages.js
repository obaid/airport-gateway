(() => {
  'use strict';
  const pages=window.AirportPages ||= {};
  const mounts=new WeakMap(), drafts=new Map(), groups=new WeakMap();
  const PILOT='pilot-gmail', tabs=['settings','tools','activity'];
  const accessModes={
    'read-only':{name:'Read only',description:'Find and read information.'},
    'write-only':{name:'Write only',description:'Create or change content.'},
    'read-write':{name:'Read and write',description:'Read information and make changes.'},
    custom:{name:'Custom',description:'Choose individual tools yourself.'}
  };
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const title=v=>String(v??'').replace(/_/g,' ').replace(/^\w/,x=>x.toUpperCase());
  const appName=c=>c.pilot?'Gmail pilot':window.AirportDiscovery?.apps?.[c.toolkit]?.name||title(c.toolkit);
  const count=(n,s)=>n+' '+s+(n===1?'':'s');
  const stamp=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?'':d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});};
  const route=(id,tab)=>'#connections/'+encodeURIComponent(id)+'/'+tab;
  const action=(key,text,kind='',disabled=false)=>`<button type="button" data-cp="${esc(key)}" class="button ${kind}" ${disabled?'disabled':''}>${esc(text)}</button>`;
  function live(v){return mounts.get(v.el)===v && v.el.isConnected && v.ctx.isCurrent();}
  function pins(v){return new Map((v.c?.tools||[]).filter(t=>t.allowed||t.enabled).map(t=>[t.slug,t]));}
  function listAccounts(v){
    const w=v.ctx.workspace;
    const list=(v.ctx.state.connections||[]).filter(c=>c.workspace===w.id);
    if(w.status && w.status!=='disconnected' || v.ctx.route.id===PILOT)
      list.unshift({id:PILOT,label:w.email||w.expectedEmail||'Gmail pilot',toolkit:'gmail',status:w.status,pilot:true});
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
    const key=JSON.stringify([ctx.workspace.id,mode,ctx.route.id||'',ctx.route.tab||'settings']);
    let v=mounts.get(el);
    if(v?.key===key){v.ctx=ctx;return v;}
    v={key,el,ctx,mode,search:'',filter:'all',items:[],cursors:[''],index:0,next:null,seq:0,loading:false,
      fetched:false,error:'',notice:'',feedbackError:false,saveLock:false,checking:false,signature:'',id:'',logSearch:'',decision:'',
      accessOpen:false,accessChoice:'read-only',accessPreview:null,accessError:'',accessLoading:false,accessSaving:false,accessMessage:''};
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
    v.c=c;v.accounts=accounts;v.tab=mode==='policies'?'tools':tabs.includes(ctx.route.tab)?ctx.route.tab:'settings';
    const draftKey=JSON.stringify([ctx.workspace.id,id]);
    if(!drafts.has(draftKey))drafts.set(draftKey,new Map());
    v.draft=drafts.get(draftKey);
    // Leave active fields, focus, paging and staged changes intact during background state polling.
    const sig=JSON.stringify([accounts.map(x=>[x.id,x.label,x.status]),c?.tools,c?.accessMode,ctx.workspace.policy,ctx.workspace.email,
      ctx.state.ready,v.tab==='activity'&&ctx.state.logs]);
    if(v.signature!==sig){v.signature=sig;paint(v);}
    if(c?.status==='active'&&!c.pilot&&v.tab==='settings'&&(!currentMode(v)||v.accessOpen)&&!v.accessPreview&&!v.accessError&&!v.accessLoading&&!v.accessSaving)loadAccess(v);
    if(c&&v.tab==='tools'&&(!group||group.visible.has(id))&&!c.pilot&&v.filter!=='allowed'&&!v.fetched&&!v.loading&&c.status==='active')load(v);
  }
  function identity(v){
    const c=v.c;
    return `<nav class="cp-tabs section-tabs" aria-label="Connection sections">${tabs.map(t=>`<a href="${route(c.id,t)}" ${t===v.tab?'aria-current="page"':''}>${esc(title(t))}</a>`).join('')}</nav>`;
  }
  function currentMode(v){
    return Object.hasOwn(accessModes,v.c.accessMode)?v.c.accessMode:pins(v).size?'custom':null;
  }
  function accessSection(v){
    const mode=currentMode(v),allowed=pins(v).size,workspace=esc(v.ctx.workspace.name);
    const toolsLink=`<a class="cp-text-link" href="${route(v.id,'tools')}">Manage individual tools ${v.ctx.icon('chevron-right',14)}</a>`;
    const editing=v.accessOpen||!mode;
    const message=v.accessMessage?`<p class="cp-access-message" role="status">${esc(v.accessMessage)}</p>`:'';
    const heading=editing?(mode?'Change agent access':'Choose agent access'):'Agent access';
    const description=editing?`Choose which ${esc(appName(v.c))} tools agents in ${workspace} can use on this account.`:
      `${esc(accessModes[mode].name)} · ${count(allowed,'tool')} allowed for agents in ${workspace}.`;
    const head=`<div class="cp-access-head"><span class="cp-access-mark">${v.ctx.icon('policies',22)}</span><div><h3>${heading}</h3><p>${description}</p></div></div>`;
    if(!editing)return `<section class="cp-panel cp-access" data-access-setup>${head}${message}
      <div class="cp-access-actions">${action('edit-access','Change access','minor')}${toolsLink}</div></section>`;
    const choice=v.accessChoice,preview=v.accessPreview,custom=choice==='custom',selection=preview?.presets?.[choice];
    const controls=Object.entries(accessModes).map(([key,option])=>{
      const num=preview?.presets?.[key]?.allowed;
      return `<label class="cp-access-option"><input type="radio" name="connection-access" data-access-preset="${key}" value="${key}" ${choice===key?'checked':''} ${v.accessSaving?'disabled':''}>
        <span><strong>${option.name}</strong>${key==='read-only'?'<small class="cp-recommended">Recommended</small>':''}
        <span class="cp-option-description">${option.description}</span>${Number.isInteger(num)?`<span class="cp-option-count">${count(num,'tool')}</span>`:''}</span></label>`;
    }).join('');
    let review='';
    if(custom)review=`<p>You’ll start with ${count(allowed,'allowed tool')}. Choose Allow or Block for each tool, then save your changes.</p>`;
    else if(selection){
      const examples=preview.examples||{};
      const names=[...(choice==='write-only'?[]:examples.read||[]),...(choice==='read-only'?[]:examples.write||[])];
      review=`<p><strong>${count(selection.allowed,'tool')} will be allowed.</strong> ${Number(selection.added)||0} to add · ${Number(selection.removed)||0} to remove.</p>
        ${names.length?`<p>Includes ${esc(names.join(', '))}.</p>`:''}
        ${selection.allowed===0?'<p>This preset has no eligible tools. Choose Custom to review individual tools.</p>':''}
        ${preview.manualOnly||preview.restricted?`<p class="cp-exclusions">${[preview.manualOnly?count(preview.manualOnly,'tool')+(preview.manualOnly===1?' requires':' require')+' individual review (including destructive or unclassified actions).':'',preview.restricted?count(preview.restricted,'tool')+(preview.restricted===1?' is':' are')+' restricted by Airport.':''].filter(Boolean).join(' ')}</p>`:''}
        ${mode&&selection.removed?`<p>Applying this preset replaces your current tool selection.</p>`:''}`;
    }
    const error=v.accessError?`<div class="cp-access-error" role="alert">${esc(v.accessError)} ${action('retry-access','Reload preview','minor')}</div>`:'';
    const draft=v.draft.size&&!custom?`<p class="cp-draft-warning">You have ${count(v.draft.size,'unsaved tool change')}. Open individual tools to save or discard your edits before applying a preset.</p>`:'';
    const manualFallback=custom&&!preview&&v.accessError;
    const busy=v.accessSaving||(!manualFallback&&!preview)||!!draft;
    const buttonLabel=v.accessSaving?'Saving…':custom?'Choose individual tools':'Apply '+accessModes[choice].name.toLowerCase();
    return `<section class="cp-panel cp-access" data-access-setup>${head}${message}
      <fieldset class="cp-access-options"><legend class="cp-sr">Agent access level</legend>${controls}</fieldset>
      <div class="cp-access-review" aria-live="polite">${v.accessLoading?'<p>Checking available tools…</p>':''}${review}${error}${draft}</div>
      <div class="cp-access-actions"><button type="button" class="button primary" data-access-apply ${busy?'disabled':''}>${buttonLabel}</button>
      ${mode?action('cancel-access','Cancel','minor',v.accessSaving):''}${draft||(!custom&&v.accessError)?toolsLink:''}</div></section>`;
  }
  async function loadAccess(v){
    if(v.accessLoading||v.accessSaving)return;
    v.accessLoading=true;v.accessError='';v.accessPreview=null;paint(v);
    try{
      const preview=await v.ctx.request('connection-access-preview',{workspace:v.ctx.workspace.id,connectionId:v.id});
      if(!live(v))return;
      if(!preview.previewId||!preview.presets?.['read-only'])throw new Error('Airport could not confirm the available tools.');
      v.accessPreview=preview;
    }catch(e){if(live(v))v.accessError=e.message||'Could not load the access preview.';}
    finally{if(live(v)){v.accessLoading=false;paint(v);}}
  }
  async function saveAccess(v){
    const mode=v.accessChoice,custom=mode==='custom';
    if(v.accessSaving||v.accessLoading||v.c.status!=='active'||(!custom&&v.draft.size))return;
    if(!v.accessPreview){if(custom&&v.accessError)v.ctx.navigate(route(v.id,'tools'));return;}
    v.accessSaving=true;v.accessError='';v.accessMessage='';paint(v);
    try{
      const result=await v.ctx.request('connection-access-apply',{workspace:v.ctx.workspace.id,connectionId:v.id,mode,previewId:v.accessPreview.previewId});
      if(!live(v))return;
      v.accessPreview=null;
      v.accessMessage=`${accessModes[mode].name} saved. ${count(result.allowed,'tool')} allowed.`;
      try{await v.ctx.refresh();}catch{
        if(!live(v))return;
        if(custom){v.ctx.navigate(route(v.id,'tools'));return;}
        v.accessError='Could not refresh the account details. Reload the preview to review the current selection.';
        return;
      }
      if(!live(v))return;
      v.accessOpen=false;
      if(custom){v.ctx.navigate(route(v.id,'tools'));return;}
    }catch(e){
      if(!live(v))return;
      v.accessError=e.message||'Could not save agent access. Review a fresh preview and try again.';
      v.accessPreview=null;
    }finally{if(live(v)){v.accessSaving=false;paint(v);}}
  }
  function settings(v){
    const c=v.c,active=c.status==='active',pending=c.status==='pending',gone=!active&&!pending;
    if(c.pilot)return active?`<section class="cp-panel cp-access" data-pilot-access><div class="cp-access-head"><span class="cp-access-mark">${v.ctx.icon('policies',22)}</span><div><h3>Agent access</h3><p>Gmail pilot supports inbox counts only. Inbox counts are ${v.ctx.workspace.policy==='Allow'?'allowed':'blocked'} in ${esc(v.ctx.workspace.name)}.</p></div></div><div class="cp-access-actions"><a class="button minor" href="${route(v.id,'tools')}">Manage inbox counts</a></div></section>`:'';
    const status={active:'Connected',pending:'Awaiting sign-in',disabled:'Disconnected'}[c.status]||title(c.status);
    const next=gone?`<a class="button primary" href="#integrations?app=${encodeURIComponent(c.toolkit)}">Connect another account</a>`:action('check',v.checking?'Checking…':pending?'Check sign-in':'Check connection','minor',v.checking);
    return `${active?accessSection(v):''}<section class="cp-panel setting-panel"><div class="cp-section-head"><h3>Account settings</h3></div><div class="cp-settings-form">
      <div class="cp-field"><span>Account label</span><strong class="cp-label-value">${esc(c.label)}</strong></div>
      <dl class="cp-facts"><div><dt>Workspace</dt><dd>${esc(v.ctx.workspace.name)}</dd></div><div><dt>Connection type</dt><dd>Composio · ${esc(appName(c))}</dd></div><div><dt>Status</dt><dd>${esc(status)}</dd></div></dl>
      ${pending?'<p class="cp-hint">Finish signing in with the provider. Airport will verify the connection and show your agent access options here.</p>':''}${next}${gone?'<p class="cp-hint">A new sign-in creates a separate connection with its own tool permissions.</p>':''}</div></section>
      ${!gone?`<section class="cp-panel cp-danger disconnect-row"><div><h3>${pending?'Cancel connection':'Disconnect account'}</h3><p>${pending?'Cancel this pending sign-in.':'Remove this account and its permissions from '+esc(v.ctx.workspace.name)+'. Its request history remains available.'}</p></div>${action('disconnect',pending?'Cancel sign-in':'Disconnect','minor')}</section>`:''}`;
  }
  function activity(v){
    const c=v.c,allowedNames=new Set((c.tools||[]).map(t=>t.mcpName));
    const entries=(v.ctx.state.logs||[]).filter(l=>l.workspace===v.ctx.workspace.id && (c.pilot?
      ['gmail_inbox_counts','gmail_send_email'].includes(l.tool):l.exchange?.request?.connection?.id===c.id||allowedNames.has(l.tool)));
    if(!entries.length)return '<section class="cp-panel cp-empty"><h3>No requests yet</h3><p>Requests for this account will appear here.</p></section>';
    const outcomes=[...new Set(entries.map(l=>l.outcome))].sort();
    const q=v.logSearch.trim().toLowerCase(),shown=entries.filter(l=>(!v.decision||l.outcome===v.decision)&&
      [l.actor,l.tool,l.exchange?.request?.operation?.slug,l.outcome,appName(c),c.label].filter(Boolean).join(' ').toLowerCase().includes(q));
    return `<div class="cp-logfilters request-filters"><label class="cp-field"><span>Search requests</span><input data-cp-logsearch type="search" value="${esc(v.logSearch)}" placeholder="Agent, service or tool"></label>
      <label class="cp-field"><span>Decision</span><select data-cp-decision><option value="">All decisions</option>${outcomes.map(x=>`<option ${x===v.decision?'selected':''} value="${esc(x)}">${esc(x)}</option>`).join('')}</select></label></div>
      <section class="cp-panel"><div class="cp-section-head"><h3>Requests</h3><span>${shown.length}</span></div><div class="cp-feed">${shown.map(l=>{
        const slug=l.exchange?.request?.operation?.slug||l.tool,op=(c.tools||[]).find(t=>t.slug===slug||t.mcpName===slug);
        const name=op?.name||slug.replace(/^gmail_/i,'').replace(/_/g,' ').toLowerCase();
        return `<a class="cp-request request-row" href="#activity/${encodeURIComponent(l.id)}"><span><strong>${esc(title(name))}</strong><small>${esc(l.actor)} → ${esc(appName(c))}</small></span><span class="cp-outcome" data-tone="${l.outcome==='Allowed'?'allow':l.outcome==='Blocked'?'block':'neutral'}">${esc(l.outcome)}</span><time>${esc(stamp(l.at))}</time>${v.ctx.icon('chevron-right',15)}</a>`;
      }).join('')||'<p class="cp-empty">No matching requests. Try another search or decision.</p>'}</div></section>`;
  }
  function pilotRows(v){
    return [{slug:'gmail_inbox_counts',name:'Get inbox counts',description:'Read total and unread message counts from the connected inbox.',pilot:true,version:'',allowed:v.ctx.workspace.policy==='Allow',tags:['readOnlyHint']},
      {slug:'gmail_send_email',name:'Send email',description:'Sending is disabled on the Gmail pilot connection.',pilot:true,version:'',allowed:false,unsupportedReason:'Always blocked on this connection.',tags:['writeHint']}];
  }
  function listed(v){
    const pinned=pins(v),text=v.search.toLowerCase(),incoming=new Map(v.items.map(t=>[t.slug,t]));
    let rows;
    if(v.c.pilot)rows=pilotRows(v);
    else if(v.filter==='allowed' || v.error){
      rows=[...pinned.values()].map(p=>incoming.get(p.slug)||{...p,local:true,approvedVersion:p.version});
    }else rows=v.items;
    return rows.map(t=>{
      const pin=pinned.get(t.slug), current=v.c.pilot?t.allowed:!!pin, latest=t.local?pin?.version:t.version;
      const staged=v.draft.get(t.slug),value=staged?staged.allow:current;
      return {...t,current,latest,pinned:pin?.version,staged,value};
    }).filter(t=>{
      if((v.c.pilot||v.filter==='allowed'||v.error)&&text && !(t.slug+' '+t.name+' '+(t.description||'')).toLowerCase().includes(text))return false;
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
    const pending=v.draft.size,rows=listed(v),active=v.c.status==='active',canFetch=!v.c.pilot && active && v.filter!=='allowed';
    return `${v.group?'':saveBar(pending,v.saveLock)}<section class="cp-panel cp-editor perm-group"><div class="cp-section-head">${v.group?
      `<div class="cp-bare">${v.ctx.logo(v.c.toolkit,26)}<div><h3>${esc(appName(v.c))}</h3><p>${esc(v.c.label)}</p></div></div><a class="cp-text-link" href="${route(v.c.id,'tools')}">Account tools ${v.ctx.icon('chevron-right',14)}</a>`:
      `<h3>Tool permissions</h3><span>${count(v.c.pilot?(v.ctx.workspace.policy==='Allow'?1:0):pins(v).size,'allowed tool')}</span>`}</div>
      ${active&&!v.c.pilot?`<div class="cp-editor-guide"><span>Choose individual tools or apply an access preset.</span><a class="cp-text-link" href="${route(v.id,'settings')}">Access presets ${v.ctx.icon('chevron-right',14)}</a></div>`:''}
      <div class="cp-toolbar"><form data-cp-search role="search"><span>${v.ctx.icon('search',17)}</span><input data-cp-query aria-label="Search tools" name="search" type="search" placeholder="Search tools" value="${esc(v.input??v.search)}" maxlength="200"><button class="cp-sr" type="submit">Search</button></form>
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
    if(!v.c){v.el.innerHTML=`<div class="cp-panel cp-empty"><h3>${v.ctx.route.id?'Connection unavailable':'Choose an app to manage its tools'}</h3><p>${v.ctx.route.id?'This connection is unavailable in the current workspace.':'Connect an account to set its tool permissions.'}</p><a class="button" href="${v.ctx.route.id?'#connections':'#integrations'}">${v.ctx.route.id?'View connections':'Browse apps'}</a></div>`;return;}
    v.el.innerHTML=(v.group?'':identity(v))+(v.tab==='settings'?settings(v):v.tab==='activity'?activity(v):editor(v))+
      `<div class="cp-feedback ${v.feedbackError?'cp-error':''}" ${v.notice?'':'hidden'} role="${v.feedbackError?'alert':'status'}">${esc(v.notice)}</div>`;
    v.group?.sync();
    if(token){const node=[...v.el.querySelectorAll('['+token.name+']')].find(n=>n.getAttribute(token.name)===token.value);if(node&&!node.disabled){node.focus({preventScroll:true});if(cursor)try{node.setSelectionRange(...cursor);}catch{}}}
  }
  function setSearch(v,text){
    if(v.search===text)return;
    v.search=text;v.input=text;v.index=0;v.cursors=[''];v.next=null;v.error='';
    if(!v.c.pilot && v.filter!=='allowed' && v.c.status==='active')load(v);else paint(v);
  }
  async function load(v){
    const seq=++v.seq,workspace=v.ctx.workspace.id,connectionId=v.c.id;
    v.loading=true;v.fetched=true;v.error='';v.items=[];paint(v);
    try{
      const result=await v.ctx.request('connection-tools',{workspace,connectionId,search:v.search||undefined,cursor:v.cursors[v.index]||undefined});
      if(!live(v)||seq!==v.seq||v.id!==connectionId)return;
      v.items=Array.isArray(result.items)?result.items:[];v.next=result.nextCursor||null;
    }catch(e){if(!live(v)||seq!==v.seq)return;v.error=e.message||'Could not load the tool catalog.';v.next=null;}
    finally{if(live(v)&&seq===v.seq){v.loading=false;paint(v);}}
  }
  function stage(v,slug,upgrade=false){
    if(v.saveLock||v.group?.saving)return;
    const row=listed(v).find(t=>t.slug===slug);if(!row)return;
    const allow=upgrade||!row.value;
    if(row.staged && !upgrade && allow===row.current){v.draft.delete(slug);v.notice='';paint(v);return;}
    if(allow && (row.unsupportedReason || v.c.status!=='active'))return;
    if(allow===row.current && (!upgrade || !allow || row.latest===row.pinned || v.c.pilot))v.draft.delete(slug);
    else v.draft.set(slug,{allow,version:allow?row.latest:row.pinned,name:row.name||slug});
    v.notice='';paint(v);
  }
  async function apply(v){
    const workspace=v.ctx.workspace.id,connectionId=v.id,draft=v.draft;
    let done=0,failed=0,error='';
    for(const [slug,change] of [...draft]){
      if(!live(v)||v.id!==connectionId)break;
      try{
        if(v.c.pilot)await v.ctx.request('policy',{workspace,policy:change.allow?'Allow':'Block'});
        else await v.ctx.request('tool-access',{workspace,connectionId,slug,version:change.version,allow:change.allow});
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
      if(v.filter==='allowed'||v.c.pilot||v.c.status!=='active')paint(v);else load(v);
    }
  }
  async function click(v,e){
    if(!live(v))return;
    const button=e.target.closest('button');if(!button||!v.el.contains(button)||button.disabled)return;

    if(button.dataset.cpUpgrade)return stage(v,button.dataset.cpUpgrade,true);
    if(button.dataset.cpLog)return v.ctx.openLog(button.dataset.cpLog);
    if(button.hasAttribute('data-access-apply'))return saveAccess(v);
    switch(button.dataset.cp){
      case 'edit-access':
        v.accessOpen=true;v.accessChoice=currentMode(v)||'read-only';v.accessMessage='';
        return loadAccess(v);
      case 'cancel-access':v.accessOpen=false;v.accessMessage='';paint(v);break;
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
  function workspacePolicies(el,ctx){
    const key=JSON.stringify([ctx.workspace.id,ctx.route.id]),accounts=listAccounts({ctx}).filter(c=>c.status!=='disabled'||c.id===ctx.route.id);
    const selected=ctx.route.id?accounts.filter(c=>c.id===ctx.route.id):accounts;
    if(!selected.length){
      groups.delete(el);
      el.innerHTML=`<section class="cp-panel cp-empty"><h3>${ctx.route.id?'Connection unavailable':'No connected accounts'}</h3><p>${ctx.route.id?'This account is unavailable in this workspace.':'Connect an account to choose which tools agents can use.'}</p><a class="button" href="${ctx.route.id?'#policies':'#integrations'}">${ctx.route.id?'View policies':'Browse integrations'}</a></section>`;
      el.classList.add('cp-page');return;
    }
    let g=groups.get(el);
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
        const picker=g.accounts.length>1||g.ctx.route.id?`<label class="cp-field"><span>Account</span><select data-cp-account aria-label="Account" ${g.saving?'disabled':''}><option value="">All accounts</option>${g.accounts.map(c=>`<option value="${esc(c.id)}" ${c.id===g.ctx.route.id?'selected':''}>${esc(appName(c))} · ${esc(c.label)}</option>`).join('')}</select></label>`:'';
        const html=picker+saveBar(pending,g.saving);
        if(g.stamp!==html){g.stamp=html;bar.innerHTML=html;}
        notice.textContent=g.notice;notice.hidden=!g.notice;notice.classList.toggle('cp-error',g.error);
      };
      bar.onchange=e=>{if(e.target.matches('[data-cp-account]')&&!g.saving)g.ctx.navigate('#policies'+(e.target.value?'/'+encodeURIComponent(e.target.value):''));};
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
          g.visible.add(v.id);if(v.c.status==='active'&&!v.c.pilot&&!v.fetched&&v.filter!=='allowed')load(v);
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
