(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const art = window.Art || {icon:()=>'', logo:()=>'', brand:()=>''};
  const icon = (name,size=16) => art.icon(name,size);
  const agentIcons = window.AirportAgentIcons;
  const agentLogo = (name,size,clientType) => agentIcons?.render(name,{size,clientType}) || '';
  const ownerRequest = entry => entry.exchange?.channel==='owner' || entry.actor==='Owner console';
  const requestLogo = (entry,size) => ownerRequest(entry) ? icon('personal',size) :
    entry.actor ? agentLogo(entry.actor,size,entry.clientType) : icon('agents',size);
  const invitationLogo = (invite,size) => invite.name || (invite.clientType && invite.clientType!=='custom') ?
    agentLogo(invite.name,size,invite.clientType) : icon('agents',size);
  const btn = (action,label,kind='',disabled=false) => `<button type="button" data-action="${action}" class="button ${kind}" ${disabled?'disabled':''}>${esc(label)}</button>`;
  const badge = (label,kind='') => `<span class="badge ${kind}">${esc(label)}</span>`;
  const heading = (title,mark,aside='') => `<div class="panel-head"><div>${mark}<h2>${esc(title)}</h2></div>${aside}</div>`;
  const formField = (label,input) => `<label class="field"><span>${esc(label)}</span>${input}</label>`;
  const when = (value,seconds=false) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], {month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',second:seconds?'2-digit':undefined});
  };
  const lifetimeLabels={'12h':'12 hours','7d':'7 days','30d':'30 days',forever:'Never expires'};
  function describeGrant(expiresAt) {
    if(expiresAt===null)return 'This credential never expires. The workspace owner can revoke it in Agents.';
    const expiry=typeof expiresAt==='string'&&when(expiresAt);
    return expiry?'This credential expires '+expiry+'.':'The gateway did not record a credential expiry.';
  }
  function describeEnrollment(lifetime) {
    if(lifetime==='forever')return 'After registration, the credential never expires. The workspace owner can revoke it in Agents.';
    return Object.hasOwn(lifetimeLabels,lifetime)?'After registration, the credential is valid for '+lifetimeLabels[lifetime]+'.':'';
  }
  const numbers = counts => ['total','unread'].filter(k => Number.isSafeInteger(counts?.[k]) && counts[k] >= 0).map(k => `${counts[k].toLocaleString()} ${k}`).join(' · ');
  let state, workspaceId='', busy=false, version=0, terminal=false, stateInflight=false, queuedMessage=null;
  let lastCheck=new Map(), pendingSince=new Map(), testResult=null;
  const pendingAppChecks=new Map();
  let returningToConsole=false;
  const regions=new Map();
  const issuedInvites=new Map();
  const current = () => state?.workspaces?.find(w => w.id === workspaceId);
  const dialog = $('#dialog');

  document.querySelectorAll('[data-brand]').forEach(el => el.innerHTML=art.brand(34));
  document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML=icon(el.dataset.icon,el.closest('.nav-item')?18:16));
  function region(id,key,html) {
    const token=JSON.stringify(key);
    if(regions.get(id) === token) return;
    const el=$('#'+id);
    el.innerHTML=html;
    regions.set(id,token);
  }
  function message(text,error=false) {
    if(busy){queuedMessage={text,error};return;}
    const el=$('#message');
    el.className=error?'feedback error':'feedback';
    el.textContent=text;
    el.hidden=!text;
  }
  function network(text) {
    const el=$('#network'); el.textContent=text; el.hidden=!text;
  }
  function showDialog(title,html) {
    $('#dialog-title').textContent=title; delete $('#dialog-content').dataset.connection; $('#dialog-content').innerHTML=html;
    if(!dialog.open) dialog.showModal();
  }
  function closeDialog() {
    if(dialog.open){forgetConnectorToken();dialog.close();$('#dialog-content').replaceChildren();}
  }
  function forgetConnectorToken() {
    const field=$('#connector-token');
    if(field) field.value='';
    const enrollment=$('#enrollment-prompt');if(enrollment)enrollment.value='';
  }
  dialog.addEventListener('close',()=>{ if(!dialog.open){forgetConnectorToken();$('#dialog-content').replaceChildren();} });
  window.addEventListener('pagehide',()=>{if($('#connector-token,#enrollment-prompt')){forgetConnectorToken();closeDialog();}});
  function originURL(value) {
    try { const url=new URL(value); if(url.protocol==='https:') return url.href; } catch {}
    return '';
  }

  function renderMail(w) {
    const route=parseRoute();const show=route.page==='connections'&&route.id==='pilot-gmail'&&route.tab==='settings';
    $('#mail').hidden=!show;
    if(!show){region('mail','closed','');return;}
    const status=w.status || 'disconnected';
    const label={disconnected:'Disconnected',pending:'Awaiting Google',active:'Connected',mismatch:'Address mismatch'}[status] || 'Disconnected';
    let content='';
    if(status==='active') content=`<div><p class="muted">Verified Gmail account</p><p class="account">${esc(w.email || w.expectedEmail || 'Account connected')}</p></div>
      <div class="actions">${btn('disconnect','Disconnect','minor')}</div>`;
    else if(status==='pending') content=`<div><p class="muted">Waiting for Google consent</p><p class="account">${esc(w.expectedEmail || 'Gmail account')}</p></div><p>Complete the Google sign-in, then check the connection here.</p>
      <div class="actions">${btn('check','Check connection')}${btn('disconnect','Cancel connection','minor')}</div>`;
    else content=`${status==='mismatch'?'<p>Google returned a different account. Start again and select the Gmail address entered here.</p>':''}<form class="fields" id="connect-form">${formField('Gmail address for this workspace','<input type="email" required name="expectedEmail" placeholder="you@example.com" autocomplete="off" spellcheck="false">')}
      <p class="hint">Choose this account when Google asks you to sign in.</p><div class="actions"><button class="button primary" type="submit" ${state.ready?'':'disabled'}>Connect Gmail</button></div></form>`;
    region('mail',[w.id,status,w.email,w.expectedEmail,state.ready],heading('Gmail connection',art.logo('gmail',28),badge(label,status==='active'?'good':status==='pending'?'ask':''))+`<div class="body">${content}</div>`);
  }

  function renderMuse(w) {
    const route=parseRoute();const show=route.page==='agents'&&route.id==='muse';
    $('#muse').hidden=!show;
    if(!show){region('muse','closed','');return;}
    const invites=(state.invites||[]).filter(x => x.workspace===w.id);
    const pending=invites[0];
    const active=Boolean(w.grant);
    if(active || !verifiedWorkspace(w)) issuedInvites.delete(w.id);
    const available=Boolean(state.publicURL) && verifiedWorkspace(w);
    const known=Object.hasOwn(w,'invitation');
    const local=issuedInvites.get(w.id);
    const legacy=local && (!local.expiresAt || Date.parse(local.expiresAt)>Date.now()) ? local : null;
    const inv=known?w.invitation:legacy;
    const stage=pending?'waiting':inv?.stage;
    const labels={new:'Invitation issued',waiting:'Approval needed',approved:'Awaiting Muse'};
    const replace=Boolean(stage) || !known;
    const invitationButton=btn(replace?'replace-invite':'invite',stage?'Replace invitation':known?'Create invitation':'Create or replace invitation','minor',!available);
    let instruction='Create an invitation and paste it into Muse.';
    if(stage==='approved') instruction='You approved this pairing. Return to Muse and ask it to finish collecting its credential.';
    else if(stage==='new') instruction='An invitation is already open. Ask Muse to use the invitation you sent.';
    else if(stage==='waiting') instruction='Enter the six digits from Muse to approve this request.';
    else if(active) instruction='Muse can request tools in this workspace.';
    else if(!verifiedWorkspace(w)) instruction='Verify a connection in this workspace to invite Muse.';
    else if(!state.publicURL) instruction='Start the remote gateway to pair Muse. Local MCP clients can use workspace agent credentials.';
    else if(!known) instruction='If you already sent an invitation, ask Muse to use it. This gateway reports the request here when Muse starts pairing.';
    const form=stage!=='approved' && (pending || (verifiedWorkspace(w)&&(!active||stage))) ? `<form class="pending" data-code-workspace="${esc(w.id)}" data-pair="${esc(pending?.id || '')}"><h3>Enter your pairing code</h3>
      <p>${pending?`Muse requested access to ${esc(w.name)} · ${esc(when(pending.at))}`:`Waiting for Muse to request pairing in ${esc(w.name)}. Approval becomes available when its request arrives.`}</p>
      ${formField('6-digit code shown by Muse','<input name="code" type="text" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="• • • • • •" title="Enter the six digits shown in Muse." spellcheck="false">')}
      <button type="submit" class="button primary" ${pending?'':'disabled'}>Approve Muse</button></form>`:'';
    const expiry=inv?.expiresAt?`<p class="hint">Invitation expires ${esc(when(inv.expiresAt))}.</p>`:'';
    const actions=`${pending?'':`<p>${esc(instruction)}</p>`}${expiry}<div class="actions">${active?btn('revoke','Revoke access','minor'):''}${stage||!active?invitationButton:''}</div>`;
    let savedConnector='';
    if(verifiedWorkspace(w) && known) {
      const tokenAction=btn('connector-token','Connect with a token');
      savedConnector=`<div class="connector-option"><h3>Saved Muse connector</h3><p>${esc(w.name)} · 12-hour token · ${w.status==='active'?'inbox counts '+(w.policy==='Allow'?'allowed':'blocked'):'enabled workspace tools'}</p><p>Issuing a token replaces this workspace’s existing token and any unfinished invitation.</p><div class="actions">${tokenAction}</div></div>`;
    }
    const body=savedConnector+form+actions;
    const old=$('#muse [name=code]');
    const preserve=old && old.form.dataset.codeWorkspace===w.id && (!old.form.dataset.pair || old.form.dataset.pair===pending?.id);
    const restoreFocus=preserve && document.activeElement===old;
    region('muse',[w.id,active,available,w.status,w.policy,known,stage,inv?.expiresAt,invites.map(i=>[i.id,i.at])],heading('Muse access',agentLogo('Muse',28,'muse'),badge(labels[stage] || (active?'Paired':'Unpaired'),stage==='waiting'?'ask':active?'good':''))+
      `<div class="body">${body}</div>`);
    const next=$('#muse [name=code]');
    if(preserve && next && next!==old){next.value=old.value;if(restoreFocus){next.focus({preventScroll:true});next.setSelectionRange(old.selectionStart,old.selectionEnd);}}
  }

  function pinControl(connection,tool,label,action='revoke-pin') {
    return `<button type="button" class="button" data-manage="${action}" data-id="${esc(connection.id)}" data-slug="${esc(tool.slug)}" data-version="${esc(tool.version||'')}" aria-label="${esc(label+' '+(tool.name||tool.slug)+' in '+(connection.label||toolkitName(connection.toolkit)))}">${esc(label)}</button>`;
  }

  function permissionGroup(connection) {
    const active=connection.status==='active';
    const pins=(connection.tools||[]).filter(tool=>tool.allowed);
    const rows=pins.map(tool=>`<div class="policy-operation"><div><strong>${esc(tool.name||tool.slug)}</strong><code>${esc(tool.slug)}</code><small>Approved version · ${esc(tool.version||'Not recorded')}</small></div>${pinControl(connection,tool,'Block','block-policy')}</div>`).join('');
    const subtitle=active?toolkitName(connection.toolkit)+' · '+countText(pins.length,'allowed tool'):toolkitName(connection.toolkit)+' · Awaiting sign-in';
    return `<section class="policy-group" aria-label="${esc((connection.label||toolkitName(connection.toolkit))+' tool policies')}">
      <div class="policy-group-head"><span>${mark(connection.toolkit)}</span><div><h3>${esc(connection.label||toolkitName(connection.toolkit))}</h3><p>${esc(subtitle)}</p></div>
      ${manageBtn(active?'tools':'app-info',active?'Access presets':'Review connection',connection.id)}</div>${rows}</section>`;
  }

  function renderPolicies(w) {
    const result=testResult?.workspace===w.id?testResult:null;
    const summary=result ? [result.outcome, numbers(result.counts)].filter(Boolean).join(' · ') : '';
    const expanded=supportsCatalog();
    const pilot=!expanded || pilotConnected(w);
    const apps=workspaceApps(w);
    const pilotSettings=pilot?`<section class="policy-group" aria-label="Gmail inbox tool policies">
      ${expanded?`<div class="policy-group-head"><span>${mark('gmail')}</span><div><h3>Gmail inbox</h3><p>${esc(w.email||w.expectedEmail||'Inbox counts connection')}</p></div>${manageBtn('mail','Manage Gmail')}</div>`:''}
      <div class="row rule"><div><span class="tool">gmail_inbox_counts</span><p>Read total and unread message counts.</p></div>
      <div><select id="policy" aria-label="Inbox counts policy"><option ${w.policy==='Allow'?'selected':''}>Allow</option><option ${w.policy==='Block'?'selected':''}>Block</option></select>${btn('counts','Test as owner','minor',w.status!=='active')}</div></div>
      <div class="row rule"><div><span class="tool">gmail_send_email</span><p>Sending email from this inbox is blocked.</p></div><div>${badge('Always blocked','stop')}${btn('send','Test as owner','minor')}</div></div>
      ${result?`<div class="body"><div class="results" role="status">Owner test · ${esc(result.tool)}
${esc(summary || 'Request completed')}</div></div>`:''}</section>`:'';
    const overview=expanded?`<p class="policy-summary">${apps.length||pilot?'Workspace agents can use the explicitly allowed tools below. All other tools are blocked by default.':'All tools are blocked by default. Connect an app to choose which tools agents can use.'}</p>`:'';
    region('permissions',[w.id,w.status,w.email,w.expectedEmail,w.policy,state.ready,expanded,apps,summary,result?.tool],
      heading('Tool policies',icon('shield',19))+overview+apps.map(permissionGroup).join('')+pilotSettings);
  }

  const privateAuditKeys=new Set(['token','authtoken','accesstoken','refreshtoken','bearer','bearertoken','authorization','cookie','setcookie','secret','clientsecret','password','credential','apikey','receipt','invite','paircode','pairingcode']);
  function auditPayload(value) {
    // The gateway supplies sanitized business fields. Also mask credential keys
    // at presentation time so a new response shape cannot expose a bearer token.
    const json=JSON.stringify(value,(key,item)=>privateAuditKeys.has(key.toLowerCase().replace(/[-_]/g,''))?'[redacted]':item,2);
    return '<pre>'+esc(json)+'</pre>';
  }

  function auditResponseNote(entry,exchange) {
    if(['issue_connector_grant','pair_connector_grant'].includes(entry.tool) && entry.outcome==='Issued')
      return 'Airport issued a connector credential. Its bearer value is withheld from the activity log.';
    if(entry.outcome==='Blocked' && entry.providerCalled===false)
      return ['gmail_inbox_counts','gmail_send_email'].includes(entry.tool)?'Airport stopped the request before contacting the provider. The caller received no mailbox data.':'Airport stopped the request before contacting the provider.';
    if(entry.outcome==='Blocked' && entry.providerCalled===true)
      return ['gmail_inbox_counts','gmail_send_email'].includes(entry.tool)?'Airport contacted the provider, then withheld mailbox data from the caller.':'Airport contacted the provider and withheld the result.';
    if(entry.outcome==='Running') return 'The request is still running. A final response has not been recorded.';
    if(entry.outcome==='Interrupted') return 'The gateway restarted before a final response was recorded.';
    if(entry.tool==='gmail_inbox_counts' && entry.outcome==='Allowed') {
      const result=exchange?.response;
      let counts=entry.counts || result?.counts || result?.structuredContent || result;
      if(result?.content && !result.structuredContent){
        try {counts=JSON.parse(result.content.find(item=>item.type==='text').text);} catch { /* The recorded payload remains visible below. */ }
      }
      if(Number.isSafeInteger(counts?.total) && counts.total>=0 && Number.isSafeInteger(counts?.unread) && counts.unread>=0)
        return `Airport returned ${counts.total.toLocaleString()} total messages and ${counts.unread.toLocaleString()} unread.`;
    }
    if(!exchange && entry.tool==='gmail_inbox_counts' && entry.outcome==='Allowed' && !numbers(entry.counts))
      return 'The counts were returned to the caller. Their values were not retained for this older entry.';
    if(!exchange && !numbers(entry.counts)) return 'The response body was not retained for this older entry.';
    if(exchange && exchange.response==null) return 'No final response was recorded.';
    return '';
  }

  function auditEntry(w,entry,opened) {
    const exchange=entry.exchange;
    const channel=({mcp:'MCP',http:'HTTP',owner:'Owner console'})[exchange?.channel] || 'Channel not recorded';
    const provider=typeof entry.providerCalled==='boolean' ? (entry.providerCalled?'Yes':'No') : 'Not recorded';
    const outcome=String(entry.outcome || 'Unknown');
    const tone=/allow|success|approved|complete|issued/i.test(outcome)?'good':/block|deni|fail|error/i.test(outcome)?'stop':'';
    const note=auditResponseNote(entry,exchange);
    const purpose=({gmail_inbox_counts:'Total and unread messages in the Gmail inbox.',gmail_send_email:'Send an email from this workspace’s Gmail account.',issue_connector_grant:'Issue a bearer credential for the saved Muse connector.',pair_connector_grant:'Collect the approved bearer credential for Muse.'})[entry.tool];
    const generic=Boolean(exchange?.request?.connection) || String(entry.tool).startsWith('c_');
    const providerName=exchange?.request?.connection?.toolkit ? toolkitName(exchange.request.connection.toolkit) : ['gmail_inbox_counts','gmail_send_email'].includes(entry.tool)?'Gmail':'';
    const providerPath=entry.providerCalled===true?'Airport called the provider'+(providerName?' for '+providerName:'')+'.':entry.providerCalled===false?'Handled within Airport. No provider call.':'The provider path was not recorded.';
    const request=(purpose?`<p>${esc(purpose)}</p>`:'')+(exchange?.request!=null?auditPayload(exchange.request):'<p>Request parameters were not retained for this older entry.</p>');
    const response=exchange?.response!=null?auditPayload(exchange.response):numbers(entry.counts)?auditPayload({total:entry.counts.total,unread:entry.counts.unread}):'';
    return `<details class="audit-entry" data-record="${esc(entry.id)}"${opened?' open':''}>
      <summary class="audit-line">
        <span class="audit-op"><span class="audit-chevron" aria-hidden="true">${icon('chevron-right',15)}</span><span class="tool"><span class="sr-only">Tool </span>${esc(entry.tool)}</span></span>
        <span class="audit-actor actor-with-icon">${requestLogo(entry,20)}<span><span class="sr-only">Actor </span>${esc(entry.actor)}</span></span>
        <span class="audit-status"><span class="sr-only">Outcome </span>${badge(outcome,tone)}</span>
        <span class="audit-provider"><span class="audit-key">Provider called </span>${esc(provider)}</span>
        <time class="audit-time stamp" datetime="${esc(entry.at)}">${esc(when(entry.at,true))}</time>
      </summary><div class="audit-full">
        <div class="audit-context"><span><strong>Requested by</strong> ${esc(entry.actor)}</span><span><strong>Workspace</strong> ${esc(w.name)}</span><span><strong>Channel</strong> ${esc(channel)}</span><span class="audit-id"><strong>Request ID</strong> ${esc(entry.id)}</span></div>
        <p class="audit-decision">${esc(providerPath)}</p>
        ${entry.detail?`<p class="audit-decision">${esc(entry.detail)}</p>`:''}
        <div class="audit-payloads"><section><h3>Request</h3>${request}</section><section><h3>${generic?'Response summary':'Response'}</h3>${note?`<p>${esc(note)}</p>`:''}${response}</section></div>
      </div></details>`;
  }

  function renderAudit(w) {
    const logs=(state.logs||[]).filter(entry=>entry.workspace===w.id);
    const detailVersion=state.activityDetailsVersion || 0;
    const revision=[w.id,detailVersion,logs];
    if(regions.get('audit')===JSON.stringify(revision)) return;
    const audit=$('#audit');
    const sameWorkspace=audit.dataset.workspace===w.id;
    const openIds=new Set(sameWorkspace?[...audit.querySelectorAll('details[open]')].map(el=>el.dataset.record):[]);
    const focused=sameWorkspace && audit.contains(document.activeElement) ? document.activeElement.closest('[data-record]')?.dataset.record : null;
    const visibleLogs=logs.map(entry=>auditEntry(w,entry,openIds.has(entry.id))).join('');
    const capability=detailVersion<1?'<p class="audit-capability">This gateway records decisions and provider calls. The upgraded gateway also records exact response values for new requests.</p>':'';
    region('audit',revision,heading('Requests',icon('activity',19),badge(String(logs.length)))+capability+
      (logs.length?`<div class="audit-list"><div class="audit-line audit-labels" aria-hidden="true"><span>Tool</span><span>Actor</span><span>Outcome</span><span>Provider called</span><span>Time</span></div>${visibleLogs}</div>`:
      `<p class="empty">Agent requests and owner tests in ${esc(w.name)} will appear here.</p>`));
    audit.dataset.workspace=w.id;
    if(focused && !audit.contains(document.activeElement)) {
      const match=[...audit.querySelectorAll('[data-record]')].find(el=>el.dataset.record===focused);
      match?.querySelector('summary')?.focus({preventScroll:true});
    }
  }

  const workspaceApps=w=>(state?.connections||[]).filter(c=>c.workspace===w.id&&['active','pending'].includes(c.status));
  const agentGrants=w=>(state?.agentGrants||[]).filter(a=>a.workspace===w.id);
  const agentInvites=w=>(state?.agentInvitations||[]).filter(a=>a.workspace===w.id);
  const verifiedWorkspace=w=>w.status==='active' || workspaceApps(w).some(c=>c.status==='active');
  const supportsCatalog=()=>state?.catalogVersion===1;
  const pilotConnected=w=>['active','pending','mismatch'].includes(w.status);
  const prettyName=s=>String(s||'').replace(/[_-]+/g,' ').replace(/\b\w/g,l=>l.toUpperCase());
  const countText=(n,noun)=>n+' '+noun+(n===1?'':'s');
  const toolkitNames={gmail:'Gmail',notion:'Notion',slack:'Slack',googledrive:'Google Drive',googlecalendar:'Google Calendar',instagram:'Instagram',github:'GitHub',linear:'Linear'};
  const toolkitName=slug=>toolkitNames[slug] || prettyName(slug);
  const toolCount=c=>(c.tools||[]).filter(t=>t.allowed===true).length;
  const manageBtn=(action,label,id='',primary=false)=>`<button class="button${primary?' primary':''}" type="button" data-manage="${action}" data-id="${esc(id)}">${esc(label)}</button>`;
  const mark=(key,size=25)=>{
    const aliases={googledrive:'drive',googlecalendar:'calendar'};
    const known=['gmail','calendar','slack','notion','drive','instagram','yahoo'];
    const code=String(key||'').toLowerCase();
    if(code==='gateway') return art.brand(size);
    if(known.includes(aliases[code]||code)) return art.logo(aliases[code]||code,size);
    return `<span class="app-monogram" aria-hidden="true">${esc((prettyName(code)||'A').slice(0,2))}</span>`;
  };
  let graphWorkspace='',traceId='',graphObserver,graphFrame=0;
  const connectionPath=(id,status)=>'#connections/'+encodeURIComponent(id)+'/'+(status==='active'?'tools':'settings');
  function gatewayObjects(w) {
    const agents=agentGrants(w).map(a=>({key:'agent:'+a.id,id:a.id,name:a.actor,clientType:a.clientType,kind:'Agent',active:true,status:'Connected',action:'agent-info',actionLabel:'Manage agent',info:describeGrant(a.expiresAt)}));
    const invite=state.invites?.some(i=>i.workspace===w.id) || w.invitation;
    if(w.grant || invite) agents.unshift({key:'muse',name:'Muse',mark:'muse',kind:'Agent',active:!!w.grant,status:w.grant?'Paired':invite?'Pairing':'Unpaired',action:'muse',actionLabel:w.grant?'Manage access':'Set up Muse',info:w.grant?'Muse is authorized to request enabled tools in this workspace.':invite?'A pairing invitation is in progress for this workspace.':'Connect Muse with a workspace token or pairing invitation.'});
    const apps=workspaceApps(w).map(c=>({key:'app:'+c.id,id:c.id,path:connectionPath(c.id,c.status),name:c.label || toolkitName(c.toolkit),mark:c.toolkit,kind:'App',active:state.ready&&c.status==='active'&&toolCount(c)>0,status:c.status==='active'?countText(toolCount(c),'enabled tool'):'Awaiting authorization',action:'app-info',actionLabel:'Manage connection',info:toolkitName(c.toolkit)+' · '+(c.status==='active'?'Verified connection':'Pending connection')}));
    if(pilotConnected(w)){
      const allowed=(w.gmailCatalog?toolCount(w.gmailCatalog):0)+(w.policy==='Allow'?1:0);
      apps.unshift({key:'gmail',path:connectionPath('pilot-gmail',w.status),name:'Gmail inbox',mark:'gmail',kind:'App',active:state.ready&&w.status==='active'&&allowed>0,status:w.status==='mismatch'?'Address mismatch':w.status==='pending'?'Awaiting Google':countText(allowed,'enabled tool'),action:'mail',actionLabel:'Manage Gmail',info:w.email||w.expectedEmail||'Gmail'});
    }
    const endpointStatus=state.publicURL?'Remote endpoint available':'Local gateway';
    const gateway={key:'gateway',mark:'gateway',name:'Airport',kind:'Gateway',active:true,status:endpointStatus,action:'permissions',actionLabel:'View tool policies',info:endpointStatus+' · '+countText(agents.filter(a=>a.active).length,'connected agent')+' · '+countText((w.status==='active'?1:0)+workspaceApps(w).filter(c=>c.status==='active').length,'verified connection')+(pilotConnected(w)||!supportsCatalog()?' · Counts '+(w.policy==='Allow'?'allowed':'blocked')+' by policy':'')};
    return {agents,apps,gateway};
  }
  function traceObjects(w,entry) {
    const binding=entry.exchange?.request?.connection;
    const gmail=['gmail_inbox_counts','gmail_send_email'].includes(entry.tool);
    const app=gmail?{name:'Gmail inbox',mark:'gmail',info:'Built-in Gmail inbox connection'}:
      binding?.id && binding.toolkit?{name:binding.label||toolkitName(binding.toolkit),mark:binding.toolkit,info:toolkitName(binding.toolkit)+' · '+binding.id}:null;
    const stopped=entry.outcome==='Blocked' && entry.providerCalled===false;
    const performed=entry.providerCalled===true;
    const direction=performed?'Provider contacted':stopped?'Stopped at Airport':entry.providerCalled===false?'Handled by Airport':'Provider path unrecorded';
    const owner=ownerRequest(entry);
    const actor=entry.actor?{key:'trace-actor',name:entry.actor,kind:owner?'Owner':'Agent',clientType:entry.clientType,active:true,status:owner?'Owner request':'Requester',info:'Requested '+entry.tool+'.',route:'trace-in'}:null;
    const outbound=app?{...app,key:'trace-app',kind:'App',active:performed,status:performed?'Provider contacted':entry.providerCalled===false?'Not contacted':'Call unrecorded',route:performed?'trace-out':stopped?'trace-stop':'none'}:null;
    return {agents:actor?[actor]:[],apps:outbound?[outbound]:[],gateway:{key:'gateway',name:'Airport',mark:'gateway',kind:'Gateway',active:true,status:entry.outcome||'Unknown',info:direction},direction};
  }
  function traceTool(entry) {
    return ({gmail_inbox_counts:'Gmail inbox counts',gmail_send_email:'Gmail send email'})[entry.tool] || entry.exchange?.request?.operation?.slug || entry.tool || 'Request';
  }
  function mapRouteLines(){
    const diagram=$('#gate-map .diagram'),hub=diagram?.querySelector('.gateway-node');
    if(!hub)return;
    const bounds=diagram.getBoundingClientRect(),center=hub.getBoundingClientRect();
    if(!bounds.width)return;
    const lines=[];
    for(const side of ['left','right']){
      const nodes=diagram.querySelectorAll('.'+side+' .map-node');
      nodes.forEach((node,index)=>{
        const target=node.getBoundingClientRect(),incoming=side==='left';
        const a=incoming?target:center,b=incoming?center:target;
        const x1=a.right-bounds.left,x2=b.left-bounds.left,y1=a.top+a.height/2-bounds.top,y2=b.top+b.height/2-bounds.top;
        const mid=(x1+x2)/2,half=(y1+y2)/2,mode=node.dataset.wireMode;
        if(mode==='none')return;
        const stop=mode==='trace-stop',d=stop?`M${x1},${y1} L${mid},${half}`:`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
        const tone=stop?'denied-wire':mode==='trace-in'||mode==='trace-out'?'selected-wire':node.dataset.ready==='no'?'idle-wire':'';
        lines.push(`<g data-wire="${esc(node.dataset.node)}" class="${tone}"><path d="${d}" class="route ${index===0?'key-route':''}"/><circle cx="${stop?mid:incoming?x1:x2}" cy="${stop?half:incoming?y1:y2}" r="${stop?3.2:2.5}" class="port ${stop?'trace-stop-marker':''}"/>${!stop&&(index===0||index===2)?`<circle cx="${mid}" cy="${half}" r="3" class="waypoint"/>`:''}</g>`);
      });
    }
    diagram.querySelector('.route-lines').innerHTML=lines.join('');
  }
  function scheduleMap(){cancelAnimationFrame(graphFrame);graphFrame=requestAnimationFrame(mapRouteLines);}
  function goLink(path,contents,classes='',extra=''){
    return `<a href="${esc(hrefFor(path))}" class="${classes}" ${extra}>${contents}</a>`;
  }
  function graph(w,objects){
    if(graphWorkspace!==w.id){graphWorkspace=w.id;traceId='';}
    const logs=workspaceRequests(w);
    const trace=logs.find(l=>l.id===traceId);if(!trace)traceId='';
    const recent=logs.slice(0,25);if(trace&&!recent.includes(trace))recent.push(trace);
    const historical=trace?traceObjects(w,trace):null;
    const agents=historical?historical.agents:objects.agents.filter(v=>v.active);
    const apps=historical?historical.apps:objects.apps;
    const choices=recent.map(l=>[l.id,l.at,l.actor,l.outcome,traceTool(l)]);
    const signature=[w.id,agents,apps,objects.gateway,traceId,choices];
    if(regions.get('gate-map')===JSON.stringify(signature))return;
    const focused=document.activeElement?.closest('[data-node]')?.dataset.node,selectFocused=document.activeElement?.id==='trace-select';
    const receipt=trace?'#activity/'+encodeURIComponent(trace.id):'';
    const group=(entries,side)=>{
      const left=side==='left';
      const items=entries.slice(0,4).map(n=>{
        const target=receipt||n.path||'#agents/'+encodeURIComponent(n.key==='muse'?'muse':n.id);
        const duplicate=!left&&apps.filter(x=>x.mark===n.mark).length>1;
        const display=left?n.name:n.key==='gmail'?'Gmail':historical?n.name:toolkitName(n.mark);
        const sub=duplicate?(n.key==='gmail'?w.email||w.expectedEmail:n.name):'';
        const caption=[n.name,n.status,n.info].filter(Boolean).join(' · ');
        const nodeLogo=n.kind==='Agent'?agentLogo(n.name,22,n.clientType):n.kind==='Owner'?icon('personal',22):mark(n.mark,21);
        return goLink(target,nodeLogo+'<span>'+esc(display)+(sub?'<small>'+esc(sub)+'</small>':'')+'</span>','map-node',`data-node="${esc(n.key)}" data-ready="${n.active?'yes':'no'}" data-wire-mode="${esc(n.route||'')}" title="${esc(caption)}" aria-label="${esc(caption)}"`);
      }).join('');
      const empty=trace?`<span class="map-empty">${left?'Requester not recorded':trace.providerCalled===false?'No app called':'App not recorded'}</span>`:left?(supportsCatalog()?`<button class="map-empty" data-manage="agent-add">${icon('plus',14)}Add agent</button>`:'<span class="map-empty">No active agents</span>'):`<button class="map-empty" data-manage="${supportsCatalog()?'catalog':'mail'}">${icon('plus',14)}Add connection</button>`;
      return `<div class="map-group ${side}"><div class="map-caption">${left?'Agents':'Connections'}</div><div class="node-stack">${items||empty}</div>${entries.length>4?goLink(left?'#agents':'#connections','+'+(entries.length-4)+' more','more-nodes'):''}</div>`;
    };
    const select=choices.length?`<label class="trace-control"><span>Trace request</span><select id="trace-select"><option value="">All workspace routes</option>${choices.map(([id,at,actor,outcome,tool])=>`<option value="${esc(id)}" ${id===traceId?'selected':''}>${esc([actor,tool,outcome,when(at,true)].filter(Boolean).join(' · '))}</option>`).join('')}</select></label>`:'';
    const info=trace?goLink(receipt,'<strong>'+esc(trace.outcome)+'</strong><code>'+esc(traceTool(trace))+'</code>'+icon('chevron-right',14),'trace-receipt',`data-outcome="${esc(trace.outcome)}" title="${esc(historical.direction)} · ${esc(when(trace.at,true))}" aria-label="${esc('View activity · '+trace.outcome+' · '+historical.direction)}"`):
      `<span class="trace-summary">${countText(agents.length,'active agent')} · ${countText((w.status==='active'?1:0)+workspaceApps(w).filter(c=>c.status==='active').length,'connected account')}</span>`;
    const gatewayHTML=goLink('#policies',art.brand(53)+'<strong>Airport</strong><small>Workspace gateway</small>','gateway-node',`data-node="gateway" title="${esc(objects.gateway.info)}" aria-label="View workspace policies"`);
    const frame={legendHTML:'<span></span>'+(trace?'Request trace':'Workspace route'),agentsHTML:group(agents,'left'),gatewayHTML,accountsHTML:group(apps,'right'),traceHTML:select+info};
    region('gate-map',signature,window.AirportOverview.mapFrame(frame,{icon}));
    $('.diagram')?.classList.toggle('tracing',Boolean(trace));
    graphObserver?.disconnect();graphObserver=new ResizeObserver(scheduleMap);graphObserver.observe($('#gate-map .diagram'));scheduleMap();
    if(selectFocused)$('#trace-select')?.focus({preventScroll:true});
    if(focused)[...document.querySelectorAll('[data-node]')].find(n=>n.dataset.node===focused)?.focus({preventScroll:true});
  }
  const sections={
    overview:{name:'Overview',title:'Workspace overview'},
    connections:{name:'Connections',title:'Connections'},
    integrations:{name:'Integrations',title:'Integrations'},
    agents:{name:'Agents',title:'Agents'},
    policies:{name:'Policies',title:'Policies'},
    activity:{name:'Activity',title:'Activity'},
    account:{name:'Account settings',title:'Account settings'},
    admin:{name:'Admin',title:'Platform admin'}
  };
  const globalPage=page=>page==='account'||page==='admin';
  window.AirportPages ||= {};
  let mountedKey='',mountedWorkspace='',mountedCatalog=null,mountedModule=null,componentSignature='',requestedAudit='';
  const panelIds=['gate-map','workspace-summary','overview-feed','connections','agents','module-page','mail','muse','permissions','audit'];

  function browserRoute(){
    // Older bookmarks put the entire console route, including its query, after /#.
    if(location.pathname==='/' && location.hash)return location.hash;
    return location.pathname+location.search;
  }
  function parseRoute(target=browserRoute()){
    const legacy=target.startsWith('#');
    const source=target.replace(/^[#/]/,'');
    const split=source.indexOf('?');
    const path=split<0?source:source.slice(0,split);
    const query=new URLSearchParams(split<0?'':source.slice(split+1));
    const segments=path.split('/').map(value=>{try{return decodeURIComponent(value);}catch{return '';}});
    let workspace='';
    if(!legacy && segments[0]==='w'){
      segments.shift();
      workspace=segments.shift()||'';
    }else if(legacy || !path)workspace=query.get('workspace')||'';
    query.delete('workspace');
    let [page,id='',tab='']=segments;
    const alias={main:'overview',catalog:'integrations',permissions:'policies',audit:'activity',mail:'connections',muse:'agents',connection:'connections'};
    if(page==='mail'){id='pilot-gmail';tab='settings';}
    if(page==='muse')id='muse';
    page=Object.hasOwn(alias,page)?alias[page]:page||'overview';
    if(page==='connections' && id&&!['settings','tools','activity'].includes(tab))tab='tools';
    const detail=page==='connections'&&id&&tab==='tools'&&segments[3]==='advanced'?'advanced':'';
    return {workspace,page,id,tab,detail,query};
  }
  function routePath(r,workspace){
    const segments=[r.page,r.id,r.tab,r.detail].filter(Boolean).map(encodeURIComponent);
    const path=globalPage(r.page)?'/'+r.page:'/w/'+encodeURIComponent(workspace)+'/'+segments.join('/');
    return path+(r.query.size?'?'+r.query:'');
  }
  function hrefFor(target,workspace){
    const r=parseRoute(target);
    return routePath(r,workspace||r.workspace||workspaceId);
  }
  function navigate(target,workspace){
    const href=hrefFor(target,workspace);
    if(href!==location.pathname+location.search+location.hash){
      // Remember where the owner entered a global page, including across reloads.
      const entry=globalPage(parseRoute(target).page)?{workspace:workspaceId}:null;
      history.pushState(entry,'',href);
    }
    if(state?.workspaces?.length)render();
  }
  function resetPage(){
    graphObserver?.disconnect();cancelAnimationFrame(graphFrame);closeDialog();
    window.AirportAccount?.unmount();
    mountedModule=null;componentSignature='';requestedAudit='';
    for(const id of panelIds){const el=$('#'+id);el.hidden=true;el.replaceChildren();regions.delete(id);}
    delete $('#audit').dataset.workspace;
  }
  const reveal=id=>{const element=$('#'+id);element.hidden=false;return element;};
  function workspaceRequests(w){
    const outcomes=['Allowed','Approved','Blocked','Denied','Failed','Error','Interrupted','Running'];
    return (state.logs||[]).filter(entry=>entry.workspace===w.id && outcomes.includes(entry.outcome));
  }
  function overviewModel(w){
    const all=workspaceRequests(w),cutoff=new Date();
    cutoff.setHours(0,0,0,0);cutoff.setDate(cutoff.getDate()-6);
    const rows=all.filter(entry=>new Date(entry.at)>=cutoff);
    const counts=outcomes=>rows.filter(entry=>outcomes.includes(entry.outcome)).length;
    const aggregate=state.weeklyUsage?.find(summary=>summary.workspace===w.id);
    const retained=state.logs||[];
    const limited=!aggregate&&retained.length>=100&&new Date(retained[retained.length-1].at)>=cutoff;
    const week=aggregate?{...aggregate,limited:false}:{
      requests:rows.length,allowed:counts(['Allowed','Approved']),blocked:counts(['Blocked','Denied']),
      failed:counts(['Failed','Error','Interrupted']),limited
    };
    week.other=Math.max(0,week.requests-week.allowed-week.blocked-week.failed);
    const recent=all.slice(0,4).map(entry=>{
      const target=traceObjects(w,entry).apps[0];
      return {id:entry.id,actor:entry.actor,clientType:entry.clientType,exchange:{channel:entry.exchange?.channel},service:target?.name||'',
        tool:entry.exchange?.request?.operation?.slug||entry.tool,outcome:entry.outcome,at:entry.at};
    });
    return {workspaceName:w.name,agents:agentGrants(w).length+(w.grant?1:0),
      accounts:workspaceApps(w).filter(c=>c.status==='active').length+(w.status==='active'?1:0),week,recent};
  }
  function workspaceSummary(w){
    const model=overviewModel(w),api=window.AirportOverview;
    const helpers={escape:esc,icon,logo:mark,requestLogo,time:v=>new Date(v).toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit'}),
      href:path=>hrefFor('#'+String(path).replace(/^#/,'')),activityURL:id=>hrefFor('#activity/'+encodeURIComponent(id))};
    if(api){
      region('workspace-summary',[w.id,model],api.stats(model,helpers));
      region('overview-feed',[w.id,model],api.lower(model,helpers));
    }
  }
  function registerRows(w,kind){
    const models=gatewayObjects(w);
    const row=(logo,name,sub,status,action,id,label='Manage',path)=>{
      const detail=path||{muse:'#agents/muse','agent-info':'#agents/'+encodeURIComponent(id||'')}[action];
      const content=`<span class="registry-mark">${logo}</span><span class="registry-name"><strong>${esc(name)}</strong><small>${esc(sub)}</small></span><span class="registry-tag">${esc(status)}</span><span class="row-link">${icon('chevron-right',17)}</span>`;
      if(detail)return `<a class="registry-row" href="${esc(hrefFor(detail))}" data-id="${esc(id||'')}" aria-label="${esc(label+' '+name)}">${content}</a>`;
      return `<button class="registry-row" type="button" data-manage="${esc(action)}" data-id="${esc(id||'')}" aria-label="${esc(label+' '+name)}">${content}</button>`;
    };
    if(kind==='connections'){
      const rows=models.apps.map(c=>row(mark(c.mark),c.name,c.info,c.status,c.action,c.id,c.actionLabel,c.path)).join('');
      const retired=(state.connections||[]).filter(c=>c.workspace===w.id&&c.status==='disabled');
      const archive=retired.length?`<details class="retired-accounts"><summary>${esc(countText(retired.length,'disconnected account'))}</summary>${retired.map(c=>row(mark(c.toolkit),c.label||toolkitName(c.toolkit),toolkitName(c.toolkit),'Disconnected','app-info',c.id,'Review',connectionPath(c.id,c.status))).join('')}</details>`:'';
      region('connections',[w.id,rows,archive],heading('Workspace accounts',icon('connections',18),badge(String(models.apps.length)))+(rows||'<p class="empty">Connect an app to make its tools available in this workspace.</p>')+archive);
      return;
    }
    const entries=models.agents.filter(a=>a.active||a.status==='Pairing');
    const pending=agentInvites(w);
    const accepted=entries.map(a=>row(agentLogo(a.name,28,a.clientType),a.name,a.key==='muse'?'Saved connector':a.info,a.status,a.action,a.id)).join('');
    const invites=pending.map(i=>row(invitationLogo(i,28),i.name?i.name+' invitation':'One-use invitation','Invitation expires '+when(i.expiresAt),'Pending','inspect-agent-invite',i.id)).join('');
    region('agents',[w.id,accepted,invites],heading('Workspace agents',icon('agents',18),badge(String(entries.length)))+(accepted+invites||'<p class="empty">Add an agent to issue its own workspace credential.</p>'));
  }
  function renderShell(w,r){
    document.body.dataset.page=r.page;
    const section=sections[r.page],connection=r.page==='connections'&&r.id?knownConnection(w,r.id):null;
    let title=section?.title||'Page unavailable';
    if(r.page==='connections'&&r.id)title=r.id==='pilot-gmail'?'Gmail':connection?(window.AirportDiscovery?.apps[connection.toolkit]?.name||toolkitName(connection.toolkit)):'Connection details';
    const selectedApp=r.page==='integrations'&&(r.query.get('app')||r.id);
    if(selectedApp)title=window.AirportDiscovery?.apps[selectedApp]?.name||toolkitName(selectedApp);
    if(r.page==='activity'&&r.id)title='Request details';
    if(r.page==='agents'&&r.id)title=r.id==='muse'?'Muse':scopedAgent(w,r.id)?.actor||'Agent details';
    const description={
      overview:'Agent access and request activity in '+w.name+'.',
      connections:r.id?'Account settings, tool access and requests in '+w.name+'.':'Accounts connected to '+w.name+'.',
      integrations:'Find an app to connect to '+w.name+'.',
      agents:r.id?'Access to the '+w.name+' workspace.':'Assistants with access to '+w.name+'.',
      policies:'Choose which tools agents can use in '+w.name+'.',
      activity:'Requests and decisions recorded in '+w.name+'.',
      account:'Your profile and sign-in details.',
      admin:'Accounts and usage across Airport.'
    };
    const account=r.page==='connections' && r.id==='pilot-gmail'?{toolkit:'gmail',status:w.status}:connection;
    const pageHeading=$('#page-title');
    pageHeading.textContent=title;
    if(account){
      const markBox=document.createElement('span');
      markBox.className='account-heading-mark';markBox.setAttribute('aria-hidden','true');
      markBox.innerHTML=mark(account.toolkit,28);pageHeading.prepend(markBox);
    }
    $('#subtitle').textContent=account
      ? (account.label||w.email||w.expectedEmail||'Gmail account')+' · '+w.name
      : selectedApp?'Integration details and connected accounts in '+w.name+'.':description[r.page]||'This page could not be found in your workspace.';
    document.title=title+' · '+w.name+' · Airport';
    $('#crumb').textContent=w.name;$('#crumb').title='Switch workspace';
    const connectionTab=r.detail==='advanced'?'Advanced tools':r.tab==='tools'?'Access presets':prettyName(r.tab);
    $('#crumb-section').innerHTML=section&&r.id?`<a href="${esc(hrefFor('#'+r.page))}">${esc(section.name)}</a><b>/</b><span>${esc(r.page==='connections'?connectionTab:r.page==='activity'?'Request':r.page==='agents'?title:r.page==='integrations'?'Integration details':'Workspace policy')}</span>`:esc(section?.name||'Page');
    if(globalPage(r.page)){
      $('#crumb').textContent='Airport';$('#crumb').title='Return to workspace overview';
      document.title=title+' · Airport';
    }
    const actions=[];
    if(account){
      const statuses={active:'Connected',pending:'Awaiting sign-in',disabled:'Disconnected',disconnected:'Disconnected',mismatch:'Address mismatch'};
      actions.push(badge(statuses[account.status]||'Unknown',account.status==='active'?'good':''));
    }
    if(!r.id && r.page==='agents'&&supportsCatalog())actions.push(`<button class="btn primary" type="button" data-manage="agent-add">${icon('plus',16)}Add agent</button>`);
    if(r.page==='integrations'&&!selectedApp)actions.push(goLink('#connections',icon('connections',15)+'Connected accounts','btn'));
    if(!r.id&&['policies','activity'].includes(r.page))actions.push(`<button class="btn ${r.page==='activity'?'primary':''}" type="button" data-manage="test-request">${icon('play',14)}Test a request</button>`);
    if(r.page==='overview' && supportsCatalog() && !pilotConnected(w) && !workspaceApps(w).length){
      $('#subtitle').textContent='Connect an app to choose which tools agents can use in '+w.name+'.';
      actions.push(goLink('#integrations',icon('plus',16)+'Connect an app','btn primary'));
    }else if(r.page==='overview'){
      actions.push(`<button type="button" class="btn" data-manage="test-request">${icon('play',14)}Test request</button>`);
      if(supportsCatalog())actions.push(`<button type="button" class="btn primary" data-manage="agent-add">${icon('plus',16)}Add agent</button>`);
    }
    if(!r.id && r.page==='connections'){
      if(supportsCatalog())actions.push(goLink('#integrations',icon('plus',15)+'Browse integrations','btn primary'));
      else if(r.page==='connections')actions.push(manageBtn('mail',pilotConnected(w)?'Manage Gmail':'Connect Gmail','',true));
    }
    region('page-actions',[w.id,actions],actions.join(''));
    for(const link of document.querySelectorAll('[data-nav]')){
      const active=link.dataset.nav===r.page;
      link.href=hrefFor('#'+link.dataset.nav);link.classList.toggle('selected',active);
      if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
    }
    const brand=$('.brand');brand.href=hrefFor('#overview');
  }

  function renderModule(w,r,module){
    const host=reveal('module-page');
    if(!mountedModule){
      const root=document.createElement('div');root.className='feature-page';
      host.replaceChildren(root);
      mountedModule={root};
    }
    const entry=mountedModule,identity=mountedKey;
    const isCurrent=()=>!terminal&&workspaceId===w.id&&mountedKey===identity&&rootAttached();
    const rootAttached=()=>entry.root.isConnected;
    const guarded=fn=>(...args)=>{if(isCurrent())return fn(...args);};
    const ctx={workspace:w,state,route:r,icon,logo:mark,mark,agentLogo,requestLogo,invitationLogo,escape:esc,isCurrent,agentEndpoint,describeGrant,
      href:target=>hrefFor(target,w.id),connectionPath:(id,status)=>hrefFor(connectionPath(id,status),w.id),
      auditEntry:entry=>entry.workspace===w.id?auditEntry(w,entry,true):'',
      navigate:guarded(navigate),toast:guarded(message),refresh:guarded(refresh),
      request:(path,data)=>isCurrent()?request(path,data):Promise.reject(new Error('This workspace view has closed.')),
      manage:guarded((action,id)=>appManagement(action,id)),connectToolkit:guarded(item=>openToolkit(item)),
      openLog:guarded(id=>navigate('#activity/'+encodeURIComponent(id))),
      onChange:guarded((id,tab)=>navigate(r.page==='policies'?'#policies/'+encodeURIComponent(id):'#connections/'+encodeURIComponent(id)+'/'+encodeURIComponent(tab||'tools'))),
      pilotAction:guarded(action=>{if(Object.hasOwn(handlers,action))return handlers[action]();})
    };
    const signature=JSON.stringify([state.ready,state.publicURL,w,state.connections?.filter(c=>c.workspace===w.id),state.agentGrants?.filter(a=>a.workspace===w.id),state.agentInvitations?.filter(i=>i.workspace===w.id),state.invites?.filter(i=>i.workspace===w.id),state.activityDetailsVersion,state.logs?.filter(l=>l.workspace===w.id)]);
    if(componentSignature===signature)return;
    componentSignature=signature;
    try{
      const response=module.render(entry.root,ctx);
      if(response?.then)response.catch(error=>{if(isCurrent()){componentSignature='';message(error.message||'Could not load this page.',true);}});
    }catch(error){componentSignature='';message(error.message||'Could not load this page.',true);}
  }
  function renderFallback(w,r){
    const el=reveal('module-page');
    if(r.page==='integrations'){
      const button=supportsCatalog()?manageBtn('directory-fallback','Browse app catalog','',true):'';
      el.innerHTML=`<div class="panel feature-empty"><h2>App catalog</h2><p>${supportsCatalog()?'Browse available apps and choose an account to connect.':'This gateway version does not include the integration catalog.'}</p>${button}</div>`;
    }else if(r.page==='connections' && scopedApp(w,r.id)){
      const c=scopedApp(w,r.id);
      el.innerHTML=`<section class="panel feature-empty"><h2>${esc(toolkitName(c.toolkit))}</h2><p>${esc(c.status==='active'?'Verified account':'Authorization pending')}</p>${manageBtn(r.tab==='tools'?'tools-fallback':'app-fallback',r.tab==='tools'?'Browse tools':'Manage connection',c.id,true)}</section>`;
    }else if(r.page==='agents'&&scopedAgent(w,r.id)){
      const a=scopedAgent(w,r.id);
      el.innerHTML=`<section class="panel agent-profile">${agentLogo(a.actor,38,a.clientType)}<div><h2>${esc(a.actor)}</h2><p>${esc(describeGrant(a.expiresAt))}</p></div>${manageBtn('remove-agent','Revoke access',a.id)}</section>`;
    }else{
      el.innerHTML='<div class="panel feature-empty"><h2>Unavailable in this workspace</h2><p>Select another item from the workspace navigation.</p></div>';
    }
  }
  let adminAssets;
  function fetchAdminModule(){
    if(!adminAssets){
      const style=document.createElement('link'),script=document.createElement('script');
      style.rel='stylesheet';style.href='/platform-admin.css';script.src='/platform-admin.js';
      const loaded=asset=>new Promise((resolve,reject)=>{
        asset.onload=resolve;
        asset.onerror=()=>reject(new Error('Could not load the admin dashboard.'));
      });
      adminAssets=Promise.all([loaded(style),loaded(script)]).then(()=>{
        if(typeof window.AirportPlatformAdmin?.render!=='function')throw new Error('The admin dashboard is unavailable.');
        return window.AirportPlatformAdmin;
      }).catch(error=>{
        style.remove();script.remove();adminAssets=null;
        throw error;
      });
      document.head.append(style,script);
    }
    return adminAssets;
  }
  const adminPage={async render(el,ctx){
    if(!ctx.isCurrent()||!window.AirportAccount?.isPlatformAdmin())return;
    if(!adminAssets)el.innerHTML='<p class="empty" role="status">Loading admin dashboard…</p>';
    try{
      const module=await fetchAdminModule();
      if(ctx.isCurrent()&&window.AirportAccount?.isPlatformAdmin())return module.render(el,ctx);
    }catch{
      if(!ctx.isCurrent()||!window.AirportAccount?.isPlatformAdmin())return;
      el.innerHTML='<section class="panel feature-empty"><p role="alert">The admin dashboard could not be loaded.</p><button type="button" class="button minor">Retry</button></section>';
      el.querySelector('button').onclick=()=>adminPage.render(el,ctx);
    }
  }};
  function renderPage(w,r){
    if(r.page==='admin'&&!window.AirportAccount?.isPlatformAdmin()){
      // The server independently authorizes the page, its assets and every data request.
      if(mountedModule)resetPage();
      renderShell(w,{page:'unavailable'});
      return;
    }
    renderShell(w,r);
    if(r.page==='admin'){renderModule(w,r,adminPage);return;}
    if(r.page==='account'&&window.AirportAccount?.signedIn()){
      window.AirportAccount.settings(reveal('module-page'));
      return;
    }
    if(r.page==='overview'){reveal('workspace-summary');reveal('overview-feed');workspaceSummary(w);reveal('gate-map');graph(w,gatewayObjects(w));return;}
    const registry=window.AirportPages.registries;
    if(registry && (r.page==='connections'&&!r.id || r.page==='agents'&&r.id!=='muse' || r.page==='activity')){
      renderModule(w,r,registry);return;
    }
    if(r.page==='connections'&&!r.id||r.page==='agents'&&!r.id){reveal(r.page);registerRows(w,r.page);return;}
    if(r.page==='agents'&&r.id==='muse'){reveal('muse');renderMuse(w);return;}
    if(r.page==='activity'){
      if(r.id&&!(state.logs||[]).some(log=>log.workspace===w.id&&log.id===r.id)){renderFallback(w,r);return;}
      reveal('audit');renderAudit(w);
      if(r.id&&requestedAudit!==r.id){
        const record=[...document.querySelectorAll('#audit [data-record]')].find(row=>row.dataset.record===r.id);
        if(record){record.open=true;requestedAudit=r.id;requestAnimationFrame(()=>{record.scrollIntoView({block:'center'});record.querySelector('summary')?.focus({preventScroll:true});});}
      }
      return;
    }
    const provider=supportsCatalog()&&window.AirportPages[r.page];
    if(r.page==='connections'&&r.id==='pilot-gmail'){
      if(provider?.render)renderModule(w,r,provider);
      if(r.tab==='settings'){reveal('mail');renderMail(w);}
      else if(!provider?.render){reveal('permissions');renderPolicies(w);}
      return;
    }
    if(r.page==='connections'&&r.id&&!knownConnection(w,r.id)){renderFallback(w,r);return;}
    if(provider?.render && ['connections','policies','integrations'].includes(r.page)){renderModule(w,r,provider);return;}
    if(r.page==='policies'){reveal('permissions');renderPolicies(w);return;}
    renderFallback(w,r);
  }
  let workspaceMenu=false,drawer=false;
  const mobileRail=matchMedia('(max-width:780px)');
  function updateRail(focus=false){
    const sidebar=$('#sidebar');
    document.body.classList.toggle('mobile-nav',drawer);
    sidebar.inert=mobileRail.matches&&!drawer;
    $('.mobile-trigger').setAttribute('aria-expanded',String(drawer));
    $('.stage').inert=mobileRail.matches&&drawer;
    $('#workspace-menu').hidden=!workspaceMenu;
    $('#ws-button').setAttribute('aria-expanded',String(workspaceMenu));
    if(focus){
      if(workspaceMenu)$('#workspace-menu [aria-current=true]')?.focus();
      else if(drawer)$('.mobile-x').focus();
      else if(mobileRail.matches)$('.mobile-trigger').focus();
      else $('#ws-button').focus();
    }
  }
  function dismissRail(focus=false){drawer=false;workspaceMenu=false;updateRail(focus);}
  function selectWorkspace(id){
    if(!state?.workspaces?.some(w=>w.id===id))return;
    testResult=null;message('');closeDialog();dismissRail();
    const page=parseRoute().page;
    navigate('#'+(Object.hasOwn(sections,page)&&!globalPage(page)?page:'overview'),id);
  }
  function renderWorkspaceMenu(w){
    const key=[w.id,state.workspaces.map(s=>[s.id,s.name]),supportsCatalog()];
    const glyph=id=>['work','personal','consulting'].includes(id)?id:'layers';
    $('#workspace-name').textContent=w.name;$('#workspace-mark').innerHTML=icon(glyph(w.id),19);
    region('workspace-menu',key,'<div class="menu-label">Switch workspace</div>'+state.workspaces.map(item=>
      `<button type="button" data-workspace="${esc(item.id)}" aria-current="${item.id===w.id}">${icon(glyph(item.id),16)}<span>${esc(item.name)}</span>${item.id===w.id?icon('check',16):''}</button>`).join('')+
      (supportsCatalog()?`<button type="button" class="menu-add" data-manage="workspace">${icon('plus',16)}Create workspace</button>`:''));
    updateRail();
  }
  function shellAction(name){
    if(name==='crumb'&&globalPage(parseRoute().page)){navigate('#overview');return;}
    if(name==='dismiss'){dismissRail(true);return;}
    if(name==='mobile'){drawer=true;updateRail(true);return;}
    if(name==='crumb'&&mobileRail.matches)drawer=true;
    if(name==='workspace'||name==='crumb'){workspaceMenu=!workspaceMenu;updateRail(true);}
  }
  const workspacePicker=$('.ws-wrap');
  function closeWorkspaceMenu() {
    workspaceMenu=false;
    updateRail();
  }
  workspacePicker.addEventListener('keydown',e=>{
    if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    if(!workspaceMenu && e.target!==$('#ws-button')) return;
    e.preventDefault();
    if(!workspaceMenu) {
      workspaceMenu=true;
      updateRail(true);
      return;
    }
    const choices=[...$('#workspace-menu').querySelectorAll('button:not(:disabled)')];
    const index=choices.indexOf(document.activeElement);
    if(!choices.length) return;
    if(e.key==='Home') choices[0].focus();
    else if(e.key==='End') choices.at(-1).focus();
    else choices[(index+(e.key==='ArrowDown'?1:-1)+choices.length)%choices.length].focus();
  });
  document.addEventListener('pointerdown',e=>{
    if(workspaceMenu && !workspacePicker.contains(e.target) && !e.target.closest('[data-shell="crumb"]')) closeWorkspaceMenu();
  });
  document.addEventListener('focusin',e=>{
    if(workspaceMenu && !workspacePicker.contains(e.target) && !e.target.closest('[data-shell="crumb"]')) closeWorkspaceMenu();
  });
  mobileRail.addEventListener('change',()=>dismissRail());
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&(workspaceMenu||drawer)){
      e.preventDefault();
      if(workspaceMenu){workspaceMenu=false;updateRail();$('#ws-button').focus();}
      else dismissRail(true);
    }
    if(e.key==='Tab'&&drawer&&mobileRail.matches){
      const items=[...$('#sidebar').querySelectorAll('button,a')].filter(el=>!el.disabled&&el.checkVisibility());
      if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items.at(-1)?.focus();}
      if(!e.shiftKey&&document.activeElement===items.at(-1)){e.preventDefault();items[0]?.focus();}
    }
  });
  function render(){
    if(!state?.workspaces?.length){network('The gateway has no available workspaces.');return;}
    const r=parseRoute();
    const wanted=r.workspace,remembered=globalPage(r.page)?history.state?.workspace:'';
    const requested=state.workspaces.find(w=>w.id===(wanted||remembered));
    if(requested)workspaceId=requested.id;
    if(!current())workspaceId=state.workspaces[0].id;
    const w=current(),missing=Boolean(wanted&&!requested);
    const autoAdd=!missing&&supportsCatalog()&&r.page==='agents'&&!r.id&&r.query.get('add')==='1';
    if(autoAdd)r.query.delete('add');
    const url=location.pathname+location.search+location.hash;
    // Only migrate recognized dashboard routes. An unrelated fragment may be private,
    // and dot segments in a legacy bookmark would change meaning in a pathname.
    const routable=Object.hasOwn(sections,r.page)&&[r.id,r.tab].every(segment=>segment!=='.'&&segment!=='..');
    const key=missing||!routable?url:routePath(r,w.id);
    if(key!==url || (globalPage(r.page)&&!missing&&history.state?.workspace!==w.id)){
      history.replaceState(globalPage(r.page)?{workspace:w.id}:null,'',key);
    }
    const changed=key!==mountedKey||w.id!==mountedWorkspace||mountedCatalog!==state.catalogVersion;
    if(w.id!==mountedWorkspace)returningToConsole=true;
    if(key!==mountedKey && r.page==='connections' && r.tab==='settings'){
      const tracker=pendingAppChecks.get(r.id);
      if(tracker)tracker.until=Date.now()+300000;
    }
    if(changed){resetPage();mountedKey=key;mountedWorkspace=w.id;mountedCatalog=state.catalogVersion;message('');}
    const selector=$('#workspace');
    const opts=state.workspaces.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}${state.invites?.some(inv=>inv.workspace===s.id)?' · pairing requested':''}</option>`).join('');
    if(regions.get('workspace')!==opts){selector.innerHTML=opts;regions.set('workspace',opts);}
    selector.value=w.id;selector.disabled=false;renderWorkspaceMenu(w);
    const local=['127.0.0.1','localhost','[::1]'].includes(location.hostname);
    $('#console-scope').textContent=local?'On this Mac':'Hosted workspace';$('#console-foot').textContent=local?'Local console':'Hosted console';
    if(missing){
      renderShell(w,{page:'unavailable',id:'',tab:'',query:r.query});
      $('#page-title').textContent='Workspace unavailable';$('#subtitle').textContent='Choose an available workspace to continue.';
      selector.selectedIndex=-1;return;
    }
    renderPage(w,r);
    if(changed&&!r.id){$('#page-title').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
    else if(changed&&r.page!=='activity'){$('#page-title').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
    if(autoAdd)addAgent(w);
  }

  async function request(path,data) {
    const config=data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Airport-Console':'1'},body:JSON.stringify(data)};
    const response=await fetch('/api/'+path,{...config,cache:'no-store',credentials:'same-origin',redirect:'error'});
    const body=await response.json().catch(()=>({}));
    if(response.status===401) {
      terminal=true;state=null;regions.clear();closeDialog();
      resetPage();$('#page-actions').replaceChildren();
      $('#workspace').disabled=true;
      $('#ws-button').disabled=true;dismissRail();$('#workspace-menu').replaceChildren();
      $('#subtitle').textContent='Sign in to open your owner console.';
      throw new Error(['localhost','127.0.0.1','[::1]'].includes(location.hostname)?'Open Airport from its local launcher on this Mac.':'Open your Airport owner console and sign in again.');
    }
    if(!response.ok || body.ok===false) {
      const error=typeof body.error==='string'?body.error:`Gateway request failed (${response.status}).`;
      if(['connect','connection-add'].includes(path)&&/auth(?:entication)?[ _-]*config|configur(?:e|ation)|api key|provider settings|ac_/i.test(error))throw new Error('Airport hasn’t enabled sign-in for this app yet.');
      throw new Error(error);
    }
    return body;
  }
  async function refresh() {
    const order=++version;
    const result=await request('state');
    if(order!==version || terminal) return;
    // Older gateways serialize an open-ended grant as the latest JavaScript date.
    for(const grant of result.agentGrants || []) {
      if(grant.expiresAt==='+275760-09-13T00:00:00.000Z') grant.expiresAt=null;
    }
    // If verification finishes after the callback, a tab still watching sign-in
    // should open access setup. Leave visits to other pages or dialogs alone.
    const route=parseRoute(),w=current();
    const watching=w&&route.page==='connections'&&route.tab==='settings'&&!dialog.open&&
      (!route.workspace||route.workspace===w.id)&&
      (route.id==='pilot-gmail'?w:knownConnection(w,route.id))?.status==='pending';
    state=result;network('');
    if(watching&&supportsCatalog()&&current()){
      const connection=route.id==='pilot-gmail'?current():knownConnection(current(),route.id);
      if(connection?.status==='active'){
        navigate(connectionPath(route.id,'active'),w.id);
        message('Connection verified. Choose an access preset.');
        return;
      }
    }
    render();
    finishAuthorizationDialog();
  }
  async function action(task) {
    if(busy || !current() || terminal) return;
    message(''); busy=true; queuedMessage=null;
    const controls=[...document.querySelectorAll('button[data-action],button[type="submit"],#workspace,#policy')].filter(el=>!el.disabled);
    controls.forEach(el=>el.disabled=true);
    $('#main').setAttribute('aria-busy','true');
    try { await task(current()); await refresh(); }
    catch(e){ message(e.message || 'Could not complete this action.',true); try {if(!terminal) await refresh();} catch {} }
    finally{
      busy=false; $('#main').removeAttribute('aria-busy');
      if(!terminal) controls.forEach(el=>{if(el.isConnected)el.disabled=false;});
      if(queuedMessage) message(queuedMessage.text,queuedMessage.error);
      queuedMessage=null;
    }
  }

  function authorizeMail(url,w) {
    const destination=originURL(url);
    if(!destination) throw new Error('The gateway did not return a secure connection link.');
    showDialog('Authorize Gmail',`<p data-authorizing-id="pilot-gmail" data-authorizing-workspace="${esc(w.id)}">Continue to the provider and sign in to the Gmail account you chose for this workspace.</p>
      <div class="actions"><a class="action-link primary" href="${esc(destination)}" target="_blank" rel="noopener noreferrer">Open sign-in ↗</a>${btn('close','Done','minor')}</div>`);
  }
  function confirmation(kind,w) {
    const revoke=kind==='revoke';
    showDialog(revoke?'Revoke Muse access?':'Disconnect Gmail?',`<p>${esc(revoke?`Muse will lose gateway access to ${w.name}.`:`Airport will disconnect the Gmail account for ${w.name}.`)}</p>
      <div class="actions">${btn('close','Cancel')}${btn('confirm-'+kind,revoke?'Revoke Muse access':'Disconnect Gmail','danger')}</div>`);
  }
  async function copyPrompt() {
    const input=$('#prompt'); if(!input) return;
    try { await navigator.clipboard.writeText(input.value); }
    catch { input.select(); if(!document.execCommand('copy')){ $('#copy-status').textContent='Select and copy the invitation.';return;} }
    $('#copy-status').textContent='Invitation copied';
  }
  function reviewConnectorToken() {
    const w=current();
    if(!w || !verifiedWorkspace(w) || !Object.hasOwn(w,'invitation')) return;
    const effects=[];
    if(w.grant) effects.push('The current Muse token will stop working immediately.');
    if(w.invitation) effects.push('The outstanding invitation and any uncollected approval will expire immediately.');
    showDialog('Connect with a token',`<p>Issue a bearer token for Muse’s secure connector credential field.</p>
      <dl class="token-facts"><div><dt>Workspace</dt><dd>${esc(w.name)}</dd></div><div><dt>Valid for</dt><dd>12 hours</dd></div>
      ${w.status==='active'?`<div><dt>Inbox counts</dt><dd>${w.policy==='Allow'?'Allowed':'Blocked'} by workspace policy</dd></div><div><dt>Gmail pilot · send email</dt><dd>Always blocked</dd></div>`:''}
      ${workspaceApps(w).length?`<div><dt>Catalog tools</dt><dd>${esc(countText(workspaceApps(w).filter(c=>c.status==='active').reduce((sum,c)=>sum+toolCount(c),0),'enabled tool'))}</dd></div>`:''}</dl>
      <p>${esc(effects.join(' ') || 'Any existing token or unfinished invitation in this workspace is replaced when you issue this token.')}</p>
      <div class="actions">${btn('close','Cancel','minor')}${btn('issue-connector-token','Issue connector token','primary')}</div>`);
  }
  function connectorSetupHelp(w) {
    const address=originURL(state?.publicURL);
    if(!address) return '';
    const url=new URL(address);
    if(url.username || url.password || url.search || url.hash) return '';
    const origin=url.origin+url.pathname.replace(/\/+$/,'');
    const prompt=`Set up an Airport connector for my ${w.name} workspace at ${origin}. Use bearer authentication and open Muse’s secure credential field for the token. ${w.status==='active'?'Then GET '+origin+'/api/gmail/inbox-counts and report total and unread counts.':'Connect to '+origin+'/mcp and call tools/list to discover the tools allowed in this workspace.'}`;
    return `<details><summary>Set up the connector in Muse</summary><p>Paste these instructions into Muse if you need to create the connector.</p>${formField('Setup prompt',`<textarea rows="4" readonly>${esc(prompt)}</textarea>`)}</details>`;
  }
  function issueConnectorToken() {
    const trigger=$('#dialog [data-action=issue-connector-token]');
    if(!trigger || !dialog.open) return;
    return action(async w=>{
      if(!verifiedWorkspace(w) || !Object.hasOwn(w,'invitation')) {closeDialog();throw new Error('Verify a connection in this workspace first.');}
      let response;
      try { response=await request('connector-grant',{workspace:w.id}); }
      catch(error){closeDialog();throw error;}
      if(typeof response.token!=='string' || !response.token || !response.expiresAt){closeDialog();throw new Error('The gateway did not return a usable connector token. Check the workspace grant before issuing another.');}
      showDialog('Connector token issued',`<p>Copy the token into the bearer credential field of Muse’s saved Airport connector.</p>
        ${formField('Bearer token for '+w.name,'<input type="password" id="connector-token" readonly autocomplete="off" spellcheck="false">')}
        <p class="hint">Expires ${esc(when(response.expiresAt))}. Closing this dialog removes the displayed token.</p>
        <div class="actions">${btn('copy-connector-token','Copy connector token','primary')}${btn('close','Done','minor')}<span id="token-copy-status" role="status"></span></div>${connectorSetupHelp(w)}`);
      $('#connector-token').value=response.token;
      response.token=null;
    });
  }
  async function copyConnectorToken() {
    const input=$('#connector-token'),status=$('#token-copy-status');
    if(!input?.value || !status) return;
    try { await navigator.clipboard.writeText(input.value);status.textContent=input.dataset.kind==='invitation'?'Invitation copied':'Token copied'; }
    catch {status.textContent='Select the credential and copy it, or allow clipboard access in this browser.';}
  }
  let directory=null,managementBusy=false;
  const manageField=(label,input)=>formField(label,input);
  const actionRow=(content)=>`<div class="actions">${content}</div>`;
  const knownConnection=(w,id)=>(state?.connections||[]).find(c=>c.workspace===w.id&&String(c.id)===String(id));
  function authorizationDialog() {
    return dialog.open ? dialog.querySelector('[data-authorizing-id]') : null;
  }
  function finishAuthorizationDialog() {
    const notice=authorizationDialog();
    if(!notice || notice.dataset.authorizingWorkspace!==workspaceId)return;
    const w=current(),id=notice.dataset.authorizingId,pilot=id==='pilot-gmail';
    const c=pilot?w:knownConnection(w,id);
    if(!c || !['active','disabled','disconnected','mismatch'].includes(c.status))return;
    if(notice.hasAttribute('data-airport-connect')){
      showConnectResult(w,c,notice.dataset.appName);
      return;
    }
    closeDialog();
    navigate(connectionPath(id,c.status),w.id);
    const label=pilot?'Gmail':c.label||toolkitName(c.toolkit);
    message(c.status==='active'?label+' connected to '+w.name+'. Choose an access preset.':'Sign-in did not complete. Connect the app again to retry.',c.status!=='active');
  }
  const scopedApp=(w,id)=>workspaceApps(w).find(c=>String(c.id)===String(id));
  const scopedAgent=(w,id)=>agentGrants(w).find(a=>String(a.id)===String(id));
  const closeButton=btn('close','Cancel','minor');
  function jumpTo(section){closeDialog();navigate('#'+section);}
  function showManageError(text){
    if(!dialog.open){message(text,true);return;}
    let el=$('#management-error');
    if(!el){el=document.createElement('p');el.id='management-error';el.className='error';el.setAttribute('role','alert');$('#dialog-content').append(el);}
    el.textContent=text;
  }
  async function mutateManagement(operation){
    if(managementBusy||terminal||!current())return;
    managementBusy=true;$('#management-error')?.remove(); const affected=[...dialog.querySelectorAll('button,select,input')].filter(v=>!v.disabled);affected.forEach(v=>v.disabled=true);
    try{await operation(current());await refresh();}
    catch(e){showManageError(e.message||'The request could not be completed.');}
    finally{managementBusy=false;affected.forEach(v=>{if(v.isConnected)v.disabled=false;});}
  }
  function openDirectory(type,connectionId='',initialSearch=''){
    const w=current(),c=scopedApp(w,connectionId);
    if(!supportsCatalog() || (type==='tools' && !c))return;
    directory={type,connectionId,workspace:w.id,search:initialSearch,cursors:[''],index:0,next:'',items:[],seq:0};
    const isTools=type==='tools';
    showDialog(isTools?'Tools for '+(c.label||toolkitName(c.toolkit)):'App catalog',
      `<div class="directory"><form id="directory-search" class="directory-search"><label class="sr-only" for="catalog-query">${isTools?'Search tools':'Search apps'}</label><span>${icon('search',17)}</span>
      <input type="search" id="catalog-query" name="q" placeholder="${isTools?'Search this toolkit’s tools':'Search apps'}" autocomplete="off" maxlength="240"><button class="button" type="submit">Search</button></form>
      <div id="directory-results" aria-live="polite">Loading…</div><div class="pager" id="directory-pager"></div></div>`);
    $('#catalog-query').value=initialSearch;loadDirectory();$('#catalog-query').focus();
  }
  async function loadDirectory(){
    const v=directory;if(!v || !$('#directory-results'))return;
    const seq=++v.seq;
    $('#directory-results').innerHTML='<p class="directory-empty">Loading…</p>';$('#directory-pager').replaceChildren();
    try{
      const payload={workspace:v.workspace,search:v.search,cursor:v.cursors[v.index]||undefined};
      if(v.type==='tools')payload.connectionId=v.connectionId;
      const r=await request(v.type==='tools'?'connection-tools':'catalog',payload);
      if(v!==directory||seq!==v.seq||v.workspace!==workspaceId||!$('#directory-results'))return;
      v.items=Array.isArray(r.items)?r.items:[];v.next=r.nextCursor||'';v.source=r.source;
      paintDirectory(v);
    }catch(e){
      if(v===directory&&seq===v.seq&&$('#directory-results')){$('#directory-results').innerHTML=`<div class="directory-empty"><p class="error">${esc(e.message)}</p>${manageBtn('list-retry','Retry')}</div>`;}
    }
  }
  function paintDirectory(v){
    const tools=v.type==='tools';
    const items=v.items.map((item,index)=>{
      if(!tools) return `<button class="directory-app" type="button" data-manage="pick-toolkit" data-id="${index}">${mark(item.slug)}<span><strong>${esc(item.name || toolkitName(item.slug))}</strong><small>${esc(item.description || item.slug)}</small></span>${icon('chevron-right',15)}</button>`;
      const unsupported=item.unsupportedReason;
      const otherPin=item.approvedVersion && item.approvedVersion!==item.version;
      const pinInfo=otherPin?`<small>Approved version · ${esc(item.approvedVersion)}</small>`:'';
      const revoke=otherPin || (unsupported && item.allowed);
      return `<div class="directory-tool"><div><strong>${esc(item.name || item.slug)}</strong><code>${esc(item.slug)}</code>${item.version?`<small>Current version · ${esc(item.version)}</small>`:''}${pinInfo}${item.description?`<p>${esc(item.description)}</p>`:''}${unsupported?`<small>${esc(unsupported)}</small>`:''}</div>
        <div class="tool-actions"><label><span class="sr-only">${esc(item.name || item.slug)} current-version permission</span><select data-tool-access="${index}" ${unsupported?'disabled':''}><option value="block" ${!item.allowed?'selected':''}>Block</option><option value="allow" ${item.allowed?'selected':''}>Allow</option></select></label>${revoke?manageBtn('block-listed','Revoke approved version',index):''}</div></div>`;
    }).join('');
    $('#directory-results').innerHTML=items || `<p class="directory-empty">${v.search?'No matches for “'+esc(v.search)+'”.':tools?'No tools are available for this connection.':'The provider returned no apps.'}</p>`;
    const label=v.source==='directory'?'Published directory':tools?'Connection tools':'App catalog';
    $('#directory-pager').innerHTML=`<small>${esc(label)} · Page ${v.index+1}</small><div><button type="button" class="button" data-manage="list-prev" ${v.index?'':'disabled'}>Previous</button><button type="button" class="button" data-manage="list-next" ${v.next?'':'disabled'}>Next</button></div>`;
  }
  function chooseToolkit(index){
    const item=directory?.items[index];if(!item || directory.type!=='catalog')return;
    openToolkit(item);
  }
  function openToolkit(item,label,problem=''){
    if(!item||typeof item.slug!=='string'||!/^[_a-z0-9-]{1,120}$/i.test(item.slug)||!supportsCatalog())return;
    const w=current(),name=item.name||toolkitName(item.slug);
    const options=state.workspaces.map(ws=>`<option value="${esc(ws.id)}"${ws.id===w.id?' selected':''}>${esc(ws.name)}</option>`).join('');
    const needsSignIn=item.requiresAuth!==false;
    showDialog('Connect '+name,`<form id="toolkit-add" class="fields" data-toolkit="${esc(item.slug)}" data-name="${esc(name)}" data-sign-in="${needsSignIn}">
      ${problem?'<p class="feedback error" role="alert">'+esc(problem)+'</p>':''}
      ${manageField('Workspace','<select name="destination" aria-label="Workspace" required>'+options+'</select>')}
      ${manageField('Connection label','<input name="label" maxlength="80" required autocomplete="off" value="'+esc(label||name)+'">')}
      <p class="hint">${needsSignIn?'Sign-in opens in a separate window. Return here to choose which tools agents can use.':'After connecting, choose which tools agents can use.'}</p>
      ${!state.ready?'<p class="hint">Airport hasn’t enabled this connection yet.</p>':''}
      ${actionRow(closeButton+(state.ready?'<button type="submit" class="button primary">'+(needsSignIn?'Continue to sign-in':'Connect app')+'</button>':''))}</form>`);
  }
  function showConnectResult(w,connection,name){
    const active=connection.status==='active';
    const tools=hrefFor(connectionPath(connection.id,'active'),w.id);
    const body=active?'Choose the tools agents can use on this account.':'This sign-in has ended. Start a new sign-in to connect this account.';
    const next=active
      ? `<a class="action-link primary" href="${esc(tools)}">Choose tool access</a>`
      : `<button class="button primary" type="button" data-manage="retry-connect" data-id="${esc(connection.id)}" data-name="${esc(name)}">Try again</button>`;
    showDialog(active?'Connection verified':'Sign-in incomplete',`<div class="connect-status" role="status">
      <div class="connect-identity">${mark(connection.toolkit,32)}<div><strong>${esc(connection.label)}</strong><small>${esc(name)} · ${esc(w.name)} workspace</small></div></div>
      <p>${body}</p></div>${actionRow(btn('close','Done','minor')+next)}`);
  }
  async function startToolkit(form){
    if(managementBusy || terminal)return;
    const w=state?.workspaces.find(ws=>ws.id===form.elements.destination.value);
    const label=form.elements.label.value.trim();
    if(!w||!label)return;
    const item={slug:form.dataset.toolkit,name:form.dataset.name,requiresAuth:form.dataset.signIn==='true'};
    if(w.id!==workspaceId)navigate('#integrations/'+encodeURIComponent(item.slug),w.id);
    showDialog('Connecting '+item.name,`<p role="status" data-connect-starting>Preparing ${esc(label)} in the ${esc(w.name)} workspace…</p>`);
    const waiting=dialog.querySelector('[data-connect-starting]');
    // Reserve the window during the submit gesture. A blocked or closed window falls back to a regular link.
    let popup=null;
    if(item.requiresAuth){
      try{
        popup=window.open('about:blank','_blank','popup,width=620,height=760');
        if(popup){
          popup.opener=null;
          popup.document.title='Airport · Connecting';
          popup.document.body.textContent='Airport is opening sign-in for '+item.name+'…';
        }
      }catch{popup?.close();popup=null;}
    }
    await mutateManagement(async()=>{
      try{
        const result=await request('connection-add',{workspace:w.id,toolkit:item.slug,label});
        if(!waiting.isConnected || !dialog.open || workspaceId!==w.id){popup?.close();return;}
        if(result.status==='active'){
          popup?.close();
          showConnectResult(w,{id:result.connectionId,toolkit:item.slug,label,status:'active'},item.name);
          return;
        }
        const dest=originURL(result.url);
        if(!dest || !result.connectionId)throw new Error('Airport could not open this sign-in. Please try again.');
        let launched=false;
        if(popup && !popup.closed){
          try{popup.location.replace(dest);launched=true;}catch{popup.close();}
        }
        showDialog('Connect '+item.name,`<div class="connect-status" data-airport-connect data-app-name="${esc(item.name)}" data-authorizing-id="${esc(result.connectionId)}" data-authorizing-workspace="${esc(w.id)}">
          <div class="connect-identity">${mark(item.slug,32)}<div><strong>${esc(label)}</strong><small>${esc(item.name)} · ${esc(w.name)} workspace</small></div></div>
          <p role="status" data-authorization-status>${launched?'Finish authorization in the sign-in window.':'Open the sign-in page to authorize this account.'} Airport will verify the connection automatically.</p>
          ${actionRow('<a class="action-link primary" href="'+esc(dest)+'" target="_blank" rel="noopener noreferrer">'+(launched?'Reopen sign-in':'Open sign-in')+' ↗</a>'+manageBtn('check-app','Check status',result.connectionId))}</div>`);
      }catch(error){
        popup?.close();
        if(waiting.isConnected && dialog.open && workspaceId===w.id)openToolkit(item,label,error.message||'Sign-in could not start. Please try again.');
      }
    });
  }
  function connectionInfo(id){
    const w=current(),c=scopedApp(w,id);if(!c)return;
    const active=c.status==='active';
    const pins=(c.tools||[]).filter(t=>t.allowed);
    const approved=pins.length?`<div class="approved-tools"><h3>Approved tools</h3>${pins.map(tool=>`<div><span><strong>${esc(tool.name||tool.slug)}</strong><small>${esc(tool.version||'Version not recorded')}</small></span>${pinControl(c,tool,'Revoke')}</div>`).join('')}</div>`:'';
    showDialog(c.label||toolkitName(c.toolkit),`<div class="identity-line">${mark(c.toolkit,30)}<div><h3>${esc(toolkitName(c.toolkit))}</h3><p>${esc(w.name)} · ${active?'Verified':'Awaiting authorization'}</p></div></div>
      <p${active?'':' data-authorizing-id="'+esc(c.id)+'" data-authorizing-workspace="'+esc(w.id)+'"'}>${active?esc(countText(toolCount(c),'tool'))+' enabled for workspace agents.':'Finish signing in with the provider. Airport checks the connection automatically when you return.'}</p>
      ${actionRow((active?manageBtn('tools','Access presets',c.id,true):manageBtn('check-app','Check connection',c.id,true))+manageBtn('remove-app','Disconnect',c.id))}${active?'':'<p class="hint" role="status" data-authorization-status></p>'}${approved}`);
    $('#dialog-content').dataset.connection=c.id;
  }
  function agentInfo(id){
    const w=current(),a=scopedAgent(w,id);if(!a)return;
    showDialog(a.actor,`<div class="identity-line">${agentLogo(a.actor,30,a.clientType)}<div><h3>${esc(a.actor)}</h3><p>${esc(w.name)} workspace agent</p></div></div>
      <p>${esc(describeGrant(a.expiresAt))} Tool access follows this workspace’s policies.</p>${actionRow(manageBtn('remove-agent','Revoke agent',a.id))}`);
  }
  function agentEndpoint(){
    const remote=originURL(state?.publicURL);
    if(remote){const u=new URL(remote);if(!u.username&&!u.password&&!u.search&&!u.hash)return u.origin+u.pathname.replace(/\/+$/,'')+'/mcp';}
    try{const u=new URL(state?.localMcpURL);if(['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash)return u.href;}catch{}
    return '';
  }
  function discoveryInstructions(endpoint){
    if(!endpoint)return '';
    const base=endpoint.replace(/\/mcp$/,'');
    const https=endpoint.startsWith('https://')?` For an HTTPS connector, GET ${base}/api/connections with the same bearer token.`:'';
    return `For MCP, connect to ${endpoint} with bearer authentication and call tools/list. To list connected apps and their allowed tool counts, call airport_list_connections.${https}`;
  }
  function newAgentSecret(w,r){
    if(!r.token||typeof r.token!=='string')throw new Error('The server did not return a credential. Review the agent before trying again.');
    const endpoint=agentEndpoint();
    const setup=[`Connect to Airport for my ${w.name} workspace using bearer authentication. Ask me to enter the credential in your secure token field.`,describeGrant(r.expiresAt),
      discoveryInstructions(endpoint),
      'If your app cannot use these connection methods, tell me which methods it supports.'].filter(Boolean).join(' ');
    showDialog('Agent credential issued',`<p class="actor-with-icon">${agentLogo(r.actor,24,r.clientType)}<span>${esc(r.actor)} · ${esc(w.name)}. ${esc(describeGrant(r.expiresAt))}</span></p>
      ${endpoint?formField('MCP endpoint','<input type="text" readonly value="'+esc(endpoint)+'">'):''}
      ${formField('Bearer token','<input id="connector-token" type="password" readonly autocomplete="off">')}
      ${actionRow(btn('copy-connector-token','Copy token','primary')+'<span role="status" id="token-copy-status"></span>')}
      ${formField('Setup instructions','<textarea rows="4" id="agent-setup" readonly>'+esc(setup)+'</textarea>')}
      ${actionRow(manageBtn('copy-setup','Copy instructions')+btn('close','Done','minor'))}`);
    $('#connector-token').value=r.token;r.token=null;
  }
  function addAgent(w) {
    const canEnroll=Array.isArray(state.agentInvitations)&&Boolean(agentEndpoint());
    const nameInput=required=>formField(required?'Agent name':'Agent name (optional)',`<input name="name" ${required?'required':''} maxlength="64" autocomplete="off" placeholder="${required?'e.g. Research assistant':'Leave blank for the agent to choose'}">`);
    const clients=(agentIcons?.catalog||[]).map(c=>`<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('');
    const clientPicker=formField('Agent icon',`<span class="agent-client-picker"><span class="agent-client-preview" aria-hidden="true">${icon('agents',24)}</span><select name="clientType"><option value="">Match agent name</option>${clients}<option value="custom">Custom · use a letter</option></select></span>`);
    const supported=Array.isArray(state.agentAccessLifetimes)?state.agentAccessLifetimes:['12h','7d','30d'];
    const options=Object.entries(lifetimeLabels).filter(([value])=>supported.includes(value)).map(([value,label])=>
      `<option value="${value}" ${value==='30d'?'selected':''}>${esc(label)}</option>`).join('');
    const lifetime=formField('Agent access duration','<select name="lifetime">'+options+'</select>');
    const direct=`<form id="named-agent" class="fields"><p>For agents with a bearer credential field, issue a workspace token and paste it into the saved connector.</p>${nameInput(true)}${clientPicker}${lifetime}${actionRow('<button type="submit" class="button'+(canEnroll?'':' primary')+'">Issue agent credential</button>')}</form>`;
    const enroll=`<form id="create-agent-invitation" class="fields"><p>Create a one-use setup prompt to connect an agent to ${esc(w.name)}. It can register under a name you choose or supply its own.${verifiedWorkspace(w)?'':' Connect an app and allow a tool when you’re ready to give it access.'}</p>${nameInput(false)}${clientPicker}${lifetime}${actionRow('<button type="submit" class="button primary">Create setup prompt</button>')}</form>`;
    showDialog('Add agent',canEnroll?enroll+'<details class="agent-invite-choice"><summary>Connect with a bearer token instead</summary>'+direct+'</details>':direct);
  }
  function newAgentInvite(w,result,selectedLifetime) {
    if(typeof result.invitation!=='string'||!result.invitation)throw new Error('The gateway could not return the invitation. Review the outstanding invitations in Agents.');
    const endpoint=agentEndpoint(),base=endpoint.replace(/\/mcp$/,'');
    const access=describeEnrollment(result.lifetime||selectedLifetime);
    const setup=`Register as an agent for my ${w.name} workspace in Airport. `+
      (result.name?`I chose the name ${JSON.stringify(result.name)}. `:'Choose your own agent name. ')+
      `POST JSON to ${base}/agents/register with this body: ${JSON.stringify(result.name?{invitation:result.invitation,name:result.name}:{invitation:result.invitation,name:'<your chosen name>'})}. Redeem the one-use invitation by ${result.expiresAt}. ${access} Save the returned bearer token in your private credential store and keep it out of chat. ${discoveryInstructions(endpoint)}`;
    showDialog('Agent setup prompt',`<p class="actor-with-icon">${invitationLogo(result,24)}<span>Paste this prompt into ${result.name?esc(result.name):'the agent you want to connect'}. It contains a one-use invitation valid for 10 minutes.</span></p>
      ${formField('Setup prompt for '+(result.name||'your agent'),'<textarea id="enrollment-prompt" readonly rows="7" spellcheck="false"></textarea>')}
      <p class="hint">Invitation expires ${esc(when(result.expiresAt))}. ${esc(access)}</p>
      ${actionRow(manageBtn('copy-setup','Copy setup prompt','',true)+btn('close','Done','minor')+'<span role="status" id="token-copy-status"></span>')}`);
    $('#enrollment-prompt').value=setup;result.invitation=null;
  }
  async function copySetup(){
    const box=$('#enrollment-prompt,#agent-setup'),status=$('#token-copy-status');if(!box||!status)return;
    try{await navigator.clipboard.writeText(box.value);status.textContent='Instructions copied';}
    catch{box.select();status.textContent=document.execCommand('copy')?'Instructions copied':'Select and copy the instructions.';}
  }
  function appManagement(action,id,control){
    const w=current();if(!w)return;
    if(action==='trace-activity' && id===traceId){navigate('#activity/'+encodeURIComponent(id));return;}
    if(['muse','mail','permissions'].includes(action)){jumpTo(action);return;}
    if(action==='catalog'){closeDialog();navigate('#integrations');return;}
    if(action==='app-info'||action==='tools'){
      if(knownConnection(w,id))navigate('#connections/'+encodeURIComponent(id)+'/'+(action==='tools'?'tools':'settings'));
      return;
    }
    if(action==='agent-info'){if(scopedAgent(w,id))navigate('#agents/'+encodeURIComponent(id));return;}
    if(action==='test-request'){
      showDialog('Test request',`<form id="overview-test" class="fields"><p>This test runs as Owner console in ${esc(w.name)}. Airport records the policy decision in Activity.</p>
        ${formField('Request','<select name="tool">'+(w.status==='active'?'<option value="gmail_inbox_counts">Gmail · Read inbox counts</option>':'')+'<option value="gmail_send_email">Gmail · Check blocked send policy</option></select>')}
        <p class="hint">The send policy check stops at Airport. No message is sent.</p>
        ${actionRow(closeButton+'<button type="submit" class="button primary">Run test</button>')}</form>`);return;
    }
    if(!supportsCatalog())return;
    switch(action){
      case 'workspace':showDialog('Create workspace',`<form id="workspace-create" class="fields">${formField('Workspace name','<input required name="name" maxlength="64" autocomplete="off" placeholder="e.g. Studio">')}${actionRow(closeButton+'<button type="submit" class="button primary">Create workspace</button>')}</form>`);break;
      case 'agent-add':addAgent(w);break;
      case 'inspect-agent-invite':{
        const invitation=agentInvites(w).find(v=>v.id===id);if(!invitation)break;
        showDialog('Pending agent invitation',`<div class="identity-line">${invitationLogo(invitation,34)}<strong>${esc(invitation.name||'Agent chooses name')}</strong></div><p>This invitation can register one agent in ${esc(w.name)} until ${esc(when(invitation.expiresAt))}. ${esc(describeEnrollment(invitation.lifetime))} Revoking the invitation prevents registration.</p>${actionRow(closeButton+manageBtn('remove-agent-invite','Revoke invitation',id))}`);break;
      }
      case 'remove-agent-invite':if(agentInvites(w).some(v=>v.id===id))mutateManagement(async()=>{
        await request('agent-invite-remove',{workspace:w.id,id});closeDialog();message('Agent invitation revoked.');
      });break;
      case 'directory-fallback':openDirectory('catalog','',parseRoute().query.get('app')||'');break;
      case 'tools-fallback':openDirectory('tools',id);break;
      case 'app-fallback':connectionInfo(id);break;
      case 'revoke-pin':
      case 'block-policy':{
        const connection=scopedApp(w,id);
        const pin=connection?.tools?.find(t=>t.allowed && t.slug===control.dataset.slug && (t.version||'')===control.dataset.version);
        if(connection && pin)mutateManagement(async()=>{
          await request('tool-access',{workspace:w.id,connectionId:connection.id,slug:pin.slug,version:pin.version,allow:false});
          await refresh();
          if(action==='revoke-pin' && workspaceId===w.id && dialog.open)connectionInfo(connection.id);
          message('Tool access revoked.');
        });break;
      }
      case 'block-listed':{
        const v=directory,item=v?.items[Number(id)];
        if(v?.workspace===w.id&&v.type==='tools'&&item&&(item.allowed||item.approvedVersion))mutateManagement(async()=>{
          await request('tool-access',{workspace:w.id,connectionId:v.connectionId,slug:item.slug,version:item.approvedVersion||item.version,allow:false});
          item.allowed=false;item.approvedVersion=null;if(directory===v&&$('#directory-results'))paintDirectory(v);message('Tool access revoked.');
        });break;
      }
      case 'list-next':if(directory?.next){directory.cursors.splice(directory.index+1,Infinity,directory.next);directory.index++;loadDirectory();}break;
      case 'list-prev':if(directory?.index){directory.index--;loadDirectory();}break;
      case 'list-retry':loadDirectory();break;
      case 'pick-toolkit':chooseToolkit(Number(id));break;
      case 'copy-setup':copySetup();break;
      case 'retry-connect':{
        const c=knownConnection(w,id);
        if(c?.status==='disabled')openToolkit({slug:c.toolkit,name:control.dataset.name},c.label);
        break;
      }
      case 'check-app':if(scopedApp(w,id))mutateManagement(async()=>{
        try {await request('connection-check',{workspace:w.id,connectionId:id,pendingOnly:true});}
        catch(error){if(dialog.open && control?.isConnected && workspaceId===w.id)throw error;return;}
        await refresh();
        if(dialog.open && control?.isConnected && workspaceId===w.id){
          const status=dialog.querySelector('[data-authorization-status]');
          if(status)status.textContent='Still waiting for the provider to finish sign-in.';
        }
      });break;
      case 'remove-app':case 'remove-agent':{
        const isAgent=action==='remove-agent',v=isAgent?scopedAgent(w,id):scopedApp(w,id);if(!v)break;
        const name=isAgent?v.actor:v.label;
        showDialog(isAgent?'Revoke agent?':'Disconnect app?',`<p>${esc(name)} will lose ${isAgent?'access to this workspace':'its connection to '+w.name}.</p>${actionRow(closeButton+manageBtn(isAgent?'confirm-agent':'confirm-app',isAgent?'Revoke agent':'Disconnect app',id))}`);
        break;
      }
      case 'confirm-agent':case 'confirm-app':{
        const isAgent=action==='confirm-agent';if(!(isAgent?scopedAgent(w,id):scopedApp(w,id)))break;
        mutateManagement(async()=>{await request(isAgent?'agent-remove':'connection-remove',isAgent?{workspace:w.id,id}:{workspace:w.id,connectionId:id});closeDialog();navigate(isAgent?'#agents':'#connections');message(isAgent?'Agent revoked.':'App disconnected.');});break;
      }
    }
  }

  const handlers={
    close:closeDialog,
    'connector-token':reviewConnectorToken,
    'issue-connector-token':issueConnectorToken,
    'copy-connector-token':copyConnectorToken,
    'pair-panel'(){jumpTo('muse');($('#muse [name=code]') || $('#muse')).focus();},
    'replace-invite'(){
      const w=current();
      showDialog('Create a replacement invitation?',`<p>Creating an invitation for ${esc(w.name)} will immediately expire any outstanding invitation, code, or uncollected approval for this workspace.</p><div class="actions">${btn('close','Cancel')}<button type="button" class="button primary" data-action="confirm-invite" data-stage="${esc(w.invitation?.stage)}" data-expiry="${esc(w.invitation?.expiresAt)}">Continue</button></div>`);
    },
    'confirm-invite'(){const el=$('[data-action=confirm-invite]');const replace=el.dataset.stage?{stage:el.dataset.stage,expiresAt:el.dataset.expiry}:null;closeDialog();return handlers.invite(replace);},
    copy:copyPrompt,
    check:()=>action(async w=>{await request('check',{workspace:w.id});message('Connection status checked.');}),
    disconnect:()=>confirmation('disconnect',current()),
    revoke:()=>confirmation('revoke',current()),
    'confirm-disconnect':()=>action(async w=>{await request('disconnect',{workspace:w.id});closeDialog();message('Gmail disconnected.');}),
    'confirm-revoke':()=>action(async w=>{await request('revoke',{workspace:w.id});closeDialog();message('Muse access revoked.');}),
    invite:replace=>action(async w=>{
      const result=await request('invite',{workspace:w.id,...(replace?{replace}:{})});
      issuedInvites.set(w.id,{stage:'new',expiresAt:result.expiresAt});
      showDialog('Invite Muse',`<p>Paste this prompt into Muse. When Muse shows a six-digit code, open <strong>Agents</strong> in the <strong>${esc(w.name)}</strong> workspace, select Muse and enter it there.</p>
      ${formField('Invitation for '+w.name,`<textarea id="prompt" rows="7" readonly>${esc(result.prompt)}</textarea>`)}
      <p class="hint">Expires ${esc(when(result.expiresAt))}.</p><div class="actions">${btn('copy','Copy invitation','primary')}${btn('pair-panel','Go to Muse access','minor')}<span id="copy-status" role="status"></span></div>`);
    })
  };
  function test(tool) {
    return action(async w=>{
      const r=await request('test',{workspace:w.id,tool});
      testResult={workspace:w.id,tool,outcome:r.outcome,counts:r.counts};
      message('Owner test completed. The result is in the activity log.');
    });
  }
  handlers.counts=()=>test('gmail_inbox_counts'); handlers.send=()=>test('gmail_send_email');
  document.addEventListener('click',e=>{
    const shell=e.target.closest('[data-shell]');
    if(shell){shellAction(shell.dataset.shell);return;}
    const workspace=e.target.closest('[data-workspace]');
    if(workspace){selectWorkspace(workspace.dataset.workspace);return;}
    if(workspaceMenu&&!e.target.closest('.ws-wrap')){workspaceMenu=false;updateRail();}
    const skip=e.target.closest('.skip');
    if(skip){e.preventDefault();$('#main').focus();return;}
    const link=e.target.closest('a[href]');
    const plainClick=e.button===0&&!e.defaultPrevented&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey;
    if(link && plainClick && !link.hasAttribute('download') && (!link.target||link.target==='_self') &&
      link.origin===location.origin && !link.hash && (link.pathname.startsWith('/w/')||link.pathname==='/account'||link.pathname==='/admin')){
      e.preventDefault();dismissRail();navigate(link.pathname+link.search);return;
    }
    const control=e.target.closest('[data-manage]');
    if(control){if(control.dataset.manage==='workspace')dismissRail();appManagement(control.dataset.manage,control.dataset.id,control);return;}
    if(e.target.closest('[data-close]'))closeDialog();
    const btnEl=e.target.closest('[data-action]'); if(!btnEl || !Object.hasOwn(handlers,btnEl.dataset.action))return;
    handlers[btnEl.dataset.action]();
  });
  dialog.addEventListener('input',e=>{
    const f=e.target.form;
    if(!['named-agent','create-agent-invitation'].includes(f?.id))return;
    const {name,clientType}=f.elements;
    const w=current();
    if(!w)return;
    const type=clientType.value;
    if(e.target===clientType && type!=='muse' && name.dataset.suggestedMuse===name.value)name.value='';
    if(e.target===name || type!=='muse')delete name.dataset.suggestedMuse;
    const chosen=name.value.trim();
    if((e.target===clientType && type==='muse' && !chosen) || chosen.toLowerCase()==='muse'){
      const base=w.name.slice(0,51)+' Muse';
      const taken=new Set([...agentGrants(w).map(a=>a.actor),...agentInvites(w).map(i=>i.name)].filter(Boolean).map(n=>n.toLowerCase()));
      let suggestion=base;
      for(let i=2;taken.has(suggestion.toLowerCase());i++)suggestion=base+' '+i;
      if(!chosen){name.value=suggestion;name.dataset.suggestedMuse=suggestion;}
      name.setCustomValidity(chosen?'Muse is reserved for the saved connector. Try “'+suggestion+'” for this agent.':'');
    }else name.setCustomValidity('');
    f.querySelector('.agent-client-preview').innerHTML=invitationLogo({name:name.value.trim(),clientType:type},28);
  });
  document.addEventListener('change',e=>{
    if(e.target.id==='trace-select' && current()){traceId=e.target.value;graph(current(),gatewayObjects(current()));return;}
    if(e.target.matches('[data-tool-access]') && directory?.type==='tools') {
      const v=directory,item=v.items[Number(e.target.dataset.toolAccess)],select=e.target;
      if(!item||item.unsupportedReason||v.workspace!==workspaceId)return;
      const allow=select.value==='allow';select.value=item.allowed?'allow':'block';
      mutateManagement(async()=>{await request('tool-access',{workspace:v.workspace,connectionId:v.connectionId,slug:item.slug,version:item.version,allow});item.allowed=allow;item.approvedVersion=allow?item.version:null;if(directory===v&&$('#directory-results'))paintDirectory(v);message('Tool access updated.');});return;
    }
    if(e.target.id==='workspace'){if(busy){e.target.value=workspaceId;return;} selectWorkspace(e.target.value);}
    if(e.target.id==='policy'){const policy=e.target.value;action(async w=>{await request('policy',{workspace:w.id,policy});message('Inbox counts policy saved.');}).finally(()=>{if(current() && $('#policy')) $('#policy').value=current().policy;});}
  });
  document.addEventListener('submit',e=>{
    const f=e.target;if(!(f instanceof HTMLFormElement))return;e.preventDefault();
    if(f.id==='overview-test'){
      const tool=f.elements.tool.value;
      if(!['gmail_inbox_counts','gmail_send_email'].includes(tool))return;
      closeDialog();test(tool);return;
    }
    if(f.id==='directory-search'){if(directory){directory.search=f.elements.q.value.trim();directory.index=0;directory.cursors=[''];loadDirectory();}return;}
    if(f.id==='workspace-create'){const name=f.elements.name.value.trim();if(!name)return;mutateManagement(async()=>{const r=await request('workspace-create',{name});testResult=null;closeDialog();await refresh();navigate('#overview',r.workspace.id);message('Workspace created.');});return;}
    if(f.id==='create-agent-invitation'){
      const name=f.elements.name.value.trim(),lifetime=f.elements.lifetime.value,clientType=f.elements.clientType.value;
      if(!Array.isArray(state.agentInvitations)||!agentEndpoint())return;
      mutateManagement(async w=>{const r=await request('agent-invite',{workspace:w.id,lifetime,...(name?{name}:{}),...(clientType?{clientType}:{})});newAgentInvite(w,r,lifetime);});return;
    }
    if(f.id==='named-agent'){
      const name=f.elements.name.value.trim(),lifetime=f.elements.lifetime.value,clientType=f.elements.clientType.value;
      if(!name)return;
      mutateManagement(async w=>{const r=await request('agent-add',{workspace:w.id,name,lifetime,...(clientType?{clientType}:{})});newAgentSecret(w,r);});return;
    }
    if(f.id==='toolkit-add'){startToolkit(f);return;}
    if(f.id==='connect-form'){
      const expectedEmail=f.elements.expectedEmail.value.trim();
      action(async w=>{const r=await request('connect',{workspace:w.id,expectedEmail});authorizeMail(r.url,w);});
    }else if(f.dataset.pair){
      const code=f.elements.code.value.trim(); if(!code)return;
      const id=f.dataset.pair;
      action(async w=>{await request('approve-invite',{id,code});issuedInvites.set(w.id,{stage:'approved',expiresAt:w.invitation?.expiresAt || issuedInvites.get(w.id)?.expiresAt});f.elements.code.value='';message('Pairing approved. Return to Muse and ask it to finish connecting.');});
    }
  });
  for(const type of ['pointerover','focusin','pointerout','focusout']){
    document.addEventListener(type,e=>{
      const node=e.target.closest?.('.map-node');if(!node)return;
      const wire=[...$('#gate-map').querySelectorAll('[data-wire]')].find(v=>v.dataset.wire===node.dataset.node);
      wire?.classList.toggle('inspect-wire',type==='pointerover'||type==='focusin');
    });
  }
  window.addEventListener('hashchange',()=>{if(current())render();});
  window.addEventListener('popstate',()=>{if(current())render();});
  async function checkPendingApp() {
    if(!state?.ready || document.hidden || terminal)return;
    const returned=returningToConsole;
    returningToConsole=false;
    const pending=(state.connections||[]).filter(c=>c.status==='pending');
    const ids=new Set(pending.map(c=>c.id));
    for(const id of pendingAppChecks.keys())if(!ids.has(id))pendingAppChecks.delete(id);
    const route=parseRoute();
    const target=authorizationDialog()?.dataset.authorizingId || (route.page==='connections' && route.id);
    const now=Date.now();
    const interval=returned?2000:10000;
    let due=null;
    for(const c of pending){
      if(c.workspace!==workspaceId)continue;
      let tracker=pendingAppChecks.get(c.id);
      if(!tracker){
        // Allow an open sign-in longer; briefly retry other pending rows found on load.
        tracker={last:0,until:now+(c.id===target?300000:30000)};
        pendingAppChecks.set(c.id,tracker);
      }
      if(returned)tracker.until=Math.max(tracker.until,now+30000);
      if(tracker.last && (now>tracker.until || now-tracker.last<interval))continue;
      if(!due || tracker.last<due.tracker.last || (tracker.last===due.tracker.last && c.id===target))due={c,tracker};
    }
    // One due sign-in per tick keeps abandoned connections from flooding the provider.
    if(!due)return;
    const {c,tracker}=due;
    tracker.last=now;
    const result=await request('connection-check',{workspace:c.workspace,connectionId:c.id,pendingOnly:true}).catch(()=>null);
    if(result && result.status!=='pending' && !terminal)await refresh();
  }
  function resumeChecks() {
    if(document.hidden)return;
    returningToConsole=true;
    tick();
  }
  async function tick() {
    if(busy || managementBusy || stateInflight || terminal || document.hidden) return;
    stateInflight=true;
    try {
      if(state) for(const w of state.workspaces || []){
        if(w.status!=='pending'){lastCheck.delete(w.id);pendingSince.delete(w.id);continue;}
        const now=Date.now();
        if(!pendingSince.has(w.id)){pendingSince.set(w.id,now);lastCheck.set(w.id,now);}
        if(now-pendingSince.get(w.id)<300000 && now-lastCheck.get(w.id)>=10000){
          lastCheck.set(w.id,now);
          await request('check',{workspace:w.id}).catch(()=>{});
        }
      }
      await refresh();
      await checkPendingApp();
    } catch(e){network(e.message||'Cannot reach the Airport gateway.');}
    finally{stateInflight=false;}
  }
  async function init(){
    if(location.hash.startsWith('#owner=')){
      const raw=location.hash.slice(7);
      history.replaceState(null,'',location.pathname+location.search);
      try { await request('session',{ticket:decodeURIComponent(raw)}); } catch(e){ network(e.message);return; }
    }
    if(!['localhost','127.0.0.1','[::1]'].includes(location.hostname)){
      const active=await window.AirportAccount.connect();
      if(!active)return;
    }
    await tick();
    if(!terminal){
      setInterval(tick,3000);
      document.addEventListener('visibilitychange',resumeChecks);
      window.addEventListener('focus',resumeChecks);
      window.addEventListener('pageshow',event=>{if(event.persisted)resumeChecks();});
    }
  }
  init();
})();
