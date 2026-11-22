(() => {
  'use strict';

  const esc = value => UI.esc(String(value ?? ''));
  const serviceName = key => DB.serviceName(key) || 'Integration';
  const providerName = key => DB.providers[key] || key || 'Custom agent';
  const serviceTools = key => DB.services[key]?.tools || [];
  const nameOf = tool => String(tool || '').replace(/[_-]/g, ' ').replace(/^./, c => c.toUpperCase());
  const options = (choices, selected) => choices.map(([key, label]) =>
    `<option value="${esc(key)}"${String(key) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`
  ).join('');
  const logo = (key, size = 36) => `<span aria-hidden="true">${UI.logo(key, size)}</span>`;
  const showDate = at => {
    const day = new Date(at).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});
    return `<time datetime="${esc(at)}">${esc(day)}<span class="sub"> · ${esc(UI.time(at))}</span></time>`;
  };
  const findById = (list, id) => list.find(item => String(item.id) === String(id));
  const button = (action, label, id = '', primary = false, glyph = '') =>
    `<button class="btn${primary ? ' primary' : ''}" type="button" data-m-open="${esc(action)}" data-m-id="${esc(id)}">${glyph ? UI.icon(glyph, 15) : ''}${esc(label)}</button>`;
  const empty = (title, description, cta = '') =>
    `<div class="empty"><strong>${esc(title)}</strong><p>${esc(description)}</p>${cta}</div>`;
  const head = (title, subtitle, action) =>
    `<header class="page-head"><div><h1 class="page-title">${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p></div>${action || ''}</header>`;
  const back = '<button type="button" class="btn" data-m-close>Cancel</button>';
  const field = (label, control, hint = '') =>
    `<label class="field"><span>${esc(label)}</span>${control}${hint ? `<small class="sub">${esc(hint)}</small>` : ''}</label>`;
  const form = (type, body, submit) => `<form class="form" data-m-form="${type}">
    ${body}<p class="sub" role="alert" data-m-error hidden></p>
    <div class="actions">${back}<button class="btn primary" type="submit">${esc(submit)}</button></div>
  </form>`;
  const panelHead = (title, aside = '') =>
    `<div class="panel-head"><h2>${esc(title)}</h2>${aside}</div>`;
  const tone = outcome => ({ Allowed: 'allow', Approved: 'allow', Pending: 'ask', Blocked: 'block', Denied: 'block' })[outcome] || 'neutral';
  const chip = (label, kind = tone(label)) =>
    `<span class="chip ${kind}">${esc(label)}</span>`;
  const pending = log => log.outcome === 'Pending';

  function link(path,text,cls='btn',glyph='') {
    return `<a class="${cls}" href="${esc(UI.href(path))}" data-nav="${esc(path)}">${glyph ? UI.icon(glyph,15):''}${esc(text)}</a>`;
  }
  function missing(label,destination) {
    return head(label+' unavailable','This item may have been removed or belongs to another workspace.')+
      link(destination,'Back to '+destination);
  }
  function accountRows(w) {
    return w.connections.map(c => {
      const path='connections/'+c.id+'/settings', tools=serviceTools(c.service);
      const allowed=tools.filter(t=>DB.policy(w,c,t)==='Allow').length;
      return `<a class="entity-row" href="${esc(UI.href(path))}" data-nav="${esc(path)}">
        <span class="entity-mark">${logo(c.service,30)}</span><span class="entity-id"><strong>${esc(serviceName(c.service))}</strong><small>${esc(c.account)}</small></span>
        <span class="entity-meta"><strong>${allowed} of ${tools.length}</strong><small>tools allowed</small></span>
        <span class="entity-meta"><strong>${w.logs.filter(l=>l.connectionId===c.id).length}</strong><small>requests</small></span>
        ${UI.icon('chevron-right',16)}</a>`;
    }).join('');
  }
  function connections() {
    const w=DB.w();
    const add=link('integrations','Browse integrations','btn primary','plus');
    return head('Connections','Accounts connected to '+w.name+'.',add)+
      `<section class="panel">${panelHead('Connected accounts',chip(String(w.connections.length),'neutral'))}
      ${accountRows(w)||empty('No connected accounts','Choose an integration to add the first account.',add)}</section>`;
  }

  function agents() {
    const w=DB.w(), add=button('agent','Add agent','',true,'plus');
    const rows=w.agents.map(a=>{
      const status=DB.agentStatus(a), duration=DB.lifetimes[a.lifetime]?.label;
      const path='agents/'+a.id, last=w.logs.find(l=>l.agentId===a.id);
      return `<a class="entity-row agent-row" href="${esc(UI.href(path))}" data-nav="${esc(path)}"><span class="entity-mark">${logo(a.provider,30)}</span>
      <span class="entity-id"><strong>${esc(a.name)}</strong><small>${esc(providerName(a.provider))}${duration?' · '+esc(duration):''}</small></span>
      <span class="entity-meta"><strong>${last?showDate(last.at):'No requests'}</strong><small>Last request</small></span>
      ${chip(status,status==='Active'?'allow':'neutral')}${UI.icon('chevron-right',16)}</a>`;
    }).join('');
    return head('Agents','Assistants with access to '+w.name+'.',add)+
      `<section class="panel">${panelHead('Workspace agents',chip(String(w.agents.length),'neutral'))}
      ${rows||empty('No agents yet','Add an agent to preview registration and workspace access.',add)}</section>`;
  }

  function policiesForm(connections,all) {
    const w=DB.w();
    if(!connections.length)return `<section class="panel">${empty('No connected accounts','Connect an account to choose which tools agents can use.',link('integrations','Browse integrations'))}</section>`;
    const filter=all && connections.length>1?`<label class="field"><span>Account</span><select data-m-filter-policies>${options([['','All accounts'],...connections.map(c=>[c.id,serviceName(c.service)+' · '+c.account])])}</select></label>`:'';
    const sections=connections.map(c=>{
      const tools=serviceTools(c.service);
      const rows=tools.map(tool=>{
        const value=DB.policy(w,c,tool);
        return `<div class="permission-row"><span><strong>${esc(nameOf(tool))}</strong><code>${esc(tool)}</code></span>
        <select aria-label="${esc(c.account)} permission for ${esc(nameOf(tool))}" data-m-rule="${esc(tool)}" data-m-connection="${esc(c.id)}" data-saved="${value}">
        ${options(['Allow','Ask','Block'].map(v=>[v,v==='Ask'?'Ask approval':v]),value)}</select></div>`;
      }).join('');
      return `<section class="panel perm-group" data-m-policy-group="${esc(c.id)}"><div class="panel-head">${all?`<div class="bare-id">${logo(c.service,26)}<div><h2>${esc(serviceName(c.service))}</h2><p>${esc(c.account)}</p></div></div>`:'<h2>Tool permissions</h2>'}
        ${all?link('connections/'+c.id+'/tools','Account tools','text-btn','chevron-right'):`<span class="sub">${tools.length} sample tools</span>`}</div>
        ${rows||empty('Tools are available in the live console','The prototype includes sample operations for selected integrations.')}</section>`;
    }).join('');
    return `<form data-m-form="permissions" class="policy-editor">
      <div class="policy-toolbar">${filter}<div class="policy-save"><span data-policy-status role="status">All changes saved</span><button class="btn" type="reset" disabled>Discard</button><button type="submit" class="btn primary" disabled>Save changes</button></div></div>
      <p class="sub policy-simulation-note">Ask approval pauses a simulated request for review. Live tool permissions support Allow and Block.</p><p class="sub" role="alert" data-m-error hidden></p>${sections}</form>`;
  }
  function policies(){
    return head('Policies','Choose whether each account tool runs, asks for approval, or is blocked.',button('test','Test a request','','','play'))+
      policiesForm(DB.w().connections,true);
  }
  function requestList(logs,blank,action=''){
    if(!logs.length)return `<section class="panel">${empty('No requests yet',blank,action)}</section>`;
    const sorted=[...logs].sort((a,b)=>new Date(b.at)-new Date(a.at));
    const rows=sorted.map(log=>{
      const path='activity/'+log.id;
      return `<a class="request-row" href="${esc(UI.href(path))}" data-nav="${esc(path)}" data-m-log-row="${esc(tone(log.outcome))}" data-m-search="${esc([log.agent,serviceName(log.service),log.tool,log.outcome,log.target].join(' ').toLowerCase())}">
      <span class="entity-id"><strong>${esc(nameOf(log.tool))}</strong><small>${esc(log.agent)} → ${esc(serviceName(log.service))}</small></span>
      ${chip(log.outcome)}<span class="request-time">${showDate(log.at)}</span>${UI.icon('chevron-right',15)}</a>`;
    }).join('');
    return `<div class="request-filters">${field('Search requests','<input type="search" placeholder="Agent, service or tool" data-m-filter-activity>')}
      ${field('Decision',`<select data-m-filter-outcome>${options([['','All decisions'],['allow','Allowed or approved'],['ask','Needs approval'],['block','Blocked or denied']])}</select>`)}</div>
      <section class="panel"><div class="panel-head"><h2>Requests</h2><span class="sub" data-request-count>${logs.length}</span></div>
      ${rows}<div data-m-no-results hidden>${empty('No matching requests','Try a different search or decision.')}</div></section>`;
  }
  function activity(){
    return head('Activity','Inspect requests and review approvals in '+DB.w().name+'.',button('test','Test a request','',true,'play'))+
      requestList(DB.w().logs,'Simulate a request to see how its policy applies.',button('test','Test a request'));
  }
  function connectionPage(id,tab){
    const w=DB.w(), c=findById(w.connections,id);
    if(!c)return missing('Connection','connections');
    const service=serviceName(c.service),base='connections/'+c.id;
    const tabs=[['settings','Settings'],['tools','Tools'],['activity','Activity']].map(([key,label])=>
      `<a href="${esc(UI.href(base+'/'+key))}" data-nav="${esc(base+'/'+key)}" ${key===tab?'aria-current="page"':''}>${label}</a>`).join('');
    const opener=serviceTools(c.service).length?button('test','Test a request',id,false,'play'):'';
    const header=`<header class="entity-head"><span class="large-mark">${logo(c.service,42)}</span><div><h1 class="page-title">${esc(service)}</h1>
      <p class="subtitle">${esc(c.account)}</p></div>${opener}</header><nav class="section-tabs" aria-label="Connection sections">${tabs}</nav>`;
    if(tab==='activity')return header+requestList(w.logs.filter(l=>l.connectionId===id),'Requests for this account will appear here.',opener);
    if(tab==='tools')return header+policiesForm([c],false);
    return header+`<section class="panel setting-panel">${panelHead('Account settings')}
      <form class="settings-form form" data-m-form="settings" data-m-id="${esc(id)}">
      ${field('Account label',`<input name="account" value="${esc(c.account)}" required maxlength="100" autocomplete="off">`)}
      <dl class="facts"><div><dt>Workspace</dt><dd>${esc(w.name)}</dd></div><div><dt>Connection type</dt><dd>Simulated account</dd></div></dl>
      <p class="sub" role="alert" data-m-error hidden></p><button type="submit" class="btn">Save label</button></form></section>
      <section class="panel disconnect-row"><div><h2>Disconnect account</h2><p class="sub">Remove this account and its permissions from ${esc(w.name)}. Request history stays available.</p></div>
      ${button('disconnect','Disconnect',c.id)}</section>`;
  }

  function connectionForm(slug) {
    const preset=slug && AirportDirectory.app(slug);
    const key=preset ? AirportDirectory.service(preset.slug) : '';
    const choices = preset ? [[key,preset.name]] : Object.entries(DB.services).map(([id,v])=>[id,v.name]);
    UI.modal('Add sample connection',form('connection',
      `<input type="hidden" name="slug" value="${esc(preset?.slug||'')}">
      ${field('Integration',`<select name="service" required>${options(choices,key)}</select>`)}
      ${field('Account label','<input name="account" required maxlength="100" placeholder="e.g. Work account" autocomplete="off">','This account and its policies are saved in this browser.')}`, 'Add connection'));
  }

  function agentForm() {
    const w=DB.w(),extra=DB.workspaces().filter(space=>space.id!==w.id);
    const additional=extra.length?`<details class="extra-workspaces"><summary>Additional workspaces</summary><fieldset><legend>Grant this named sample agent access</legend>
      ${extra.map(space=>`<label><input type="checkbox" name="workspaces" value="${esc(space.id)}">${esc(space.name)}</label>`).join('')}</fieldset></details>`:'';
    UI.modal('Add an agent', form('agent',
      `${field('Agent name', '<input name="name" placeholder="Grokbot, Instinct, or another name" maxlength="70" autocomplete="off">')}
      <p class="sub">Leave the name empty to let the agent choose it during registration. Access applies to the ${esc(DB.w().name)} workspace.</p>
      ${field('Agent access duration',`<select name="lifetime">${options(Object.entries(DB.lifetimes).map(([value,d])=>[value,d.label]),'30d')}</select>`)}
      ${additional}`, 'Preview setup'));
  }

  function workspaceForm() {
    UI.modal('New workspace', form('workspace',
      field('Workspace name', '<input name="name" placeholder="e.g. Studio" required maxlength="64" autocomplete="off">'), 'Create workspace'));
  }

  function setupPrompt(agent,lifetime=agent?.lifetime) {
    const name=agent?.name;
    const identity=name?'Register as '+name+'.':'Choose a short display name for yourself and include it as name.';
    const duration=DB.lifetimes[lifetime]?.label;
    return `Setup example for the ${DB.w().name} workspace. ${identity}${duration?' The owner selected “'+duration+'” for sample access.':''}\n\nUse the one-use Airport invitation to POST JSON to https://airport.example/agents/register. Save the returned token in your credential store. Connect to https://airport.example/mcp with the bearer token. List the available tools before making a request.\n\nCreate a live invitation in Airport for the actual endpoint and one-use credential.`;
  }

  function agentDetail(id) {
    const w=DB.w(), agent=findById(w.agents,id);
    if(!agent)return missing('Agent','agents');
    const grants=DB.agentWorkspaces(id),status=DB.agentStatus(agent);
    const duration=DB.lifetimes[agent.lifetime]?.label || 'No expiry was set';
    const expiry=agent.expiresAt?`<div><dt>Expires</dt><dd>${showDate(agent.expiresAt)}</dd></div>`:'';
    const pause=status==='Expired'?'':`<button type="button" class="btn" data-m-pause="${esc(id)}">${agent.active?'Pause':'Resume'} in ${esc(w.name)}</button>`;
    return `<header class="entity-head"><span class="large-mark">${logo(agent.provider,42)}</span><div><h1 class="page-title">${esc(agent.name)}</h1>
      <p class="subtitle">${esc(providerName(agent.provider))} · ${esc(w.name)} workspace</p></div>${chip(status,status==='Active'?'allow':'neutral')}</header>
      <div class="agent-detail-grid"><section class="panel">${panelHead('Workspace access')}<div class="panel-inner">
      <dl class="facts"><div><dt>Agent name</dt><dd>${esc(agent.name)}</dd></div><div><dt>Linked workspaces</dt><dd>${esc(grants.map(g=>g.name).join(', '))}</dd></div>
      <div><dt>Access duration</dt><dd>${esc(duration)}</dd></div>${expiry}</dl>
      <div class="agent-access-actions">${pause}${button('revoke-agent','Revoke access',id)}</div></div></section>
      <section class="panel">${panelHead('Setup prompt')}<div class="panel-inner form"><label class="field">
      <span>Registration example</span><textarea rows="6" readonly data-m-prompt>${esc(setupPrompt(agent))}</textarea></label>
      <div class="actions"><button type="button" class="btn" data-m-copy>${UI.icon('copy',14)}Copy prompt</button></div></div></section></div>
      <h2 class="section-title">Agent activity</h2>${requestList(w.logs.filter(log=>log.agentId===id),'Requests from this agent will appear here.')}`;
  }
  function revokeAgentForm(id) {
    const w=DB.w(), agent=findById(w.agents,id);
    if(!agent)return;
    UI.modal('Revoke sample access?',`<form class="form" data-m-form="revoke-agent" data-m-id="${esc(id)}">
      <p>${esc(agent.name)} will lose access to ${esc(w.name)}. Its request history stays available.</p>
      <p class="sub" role="alert" data-m-error hidden></p><div class="actions">${back}<button class="btn danger" type="submit">Revoke access</button></div></form>`);
  }
  function disconnectForm(id) {
    const c=findById(DB.w().connections,id);
    if(!c)return;
    UI.modal('Disconnect '+serviceName(c.service)+'?',`<form class="form" data-m-form="disconnect" data-m-id="${esc(id)}">
      <p>Remove ${esc(c.account)} from ${esc(DB.w().name)}? Agents will lose access to this account.</p><p class="sub" role="alert" data-m-error hidden></p>
      <div class="actions">${back}<button class="btn danger" type="submit">Disconnect account</button></div></form>`);
  }

  function testForm(connectionId) {
    const w = DB.w();
    if (!w.agents.length || !w.connections.length) {
      const missing = w.agents.length ? 'connection' : 'agent';
      UI.modal('Test a request', empty(`Add ${missing === 'agent' ? 'an agent' : 'a connection'} first`,
        'A test needs a workspace agent and a connected service.', button(missing, missing === 'agent' ? 'Add agent' : 'Add connection', '', true)));
      return;
    }
    const supported=w.connections.filter(c=>serviceTools(c.service).length);
    if(!supported.length){UI.modal('Test a request',empty('No sample tools here','Connect an integration with sample tools, such as Gmail, to simulate a request.',link('integrations','Browse integrations')));return;}
    const chosen = findById(supported, connectionId) || supported[0];
    const tools = serviceTools(chosen.service);
    UI.modal('Test a request', form('test', `<p class="sub">See how this workspace handles a simulated request.</p>
      ${field('Agent', `<select name="agent" required>${options(w.agents.map(a => [a.id, a.name + (DB.agentStatus(a)==='Active'?'':' ('+DB.agentStatus(a).toLowerCase()+')')]))}</select>`)}
      ${field('Connection', `<select name="connection" data-m-test-connection required>${options(supported.map(c => [c.id, `${serviceName(c.service)} · ${c.account}`]), chosen.id)}</select>`)}
      ${field('Tool', `<select name="tool" required>${options(tools.map(t => [t, nameOf(t)]))}</select>`)}
      ${field('Target', '<input name="target" placeholder="e.g. Monday planning notes" required maxlength="180" autocomplete="off">')}`, 'Run test'));
  }

  function logDetail(id) {
    const w = DB.w();
    const log = findById(w.logs, id);
    if (!log) return missing('Request','activity');
    const connection = findById(w.connections, log.connectionId);
    const workspaces = DB.agentWorkspaces(log.agentId).map(g => g.name).join(', ');
    const title=pending(log)?'Review request':'Request details';
    return head(title,nameOf(log.tool)+' · '+serviceName(log.service),chip(log.outcome))+
      `<section class="panel receipt-panel">${panelHead('Request')}
        <dl class="facts"><div><dt>Agent</dt><dd>${findById(w.agents,log.agentId)?link('agents/'+log.agentId,log.agent,'text-btn'):esc(log.agent)}</dd></div>
        <div><dt>Workspace</dt><dd>${esc(w.name)}</dd></div>${workspaces ? `<div><dt>Agent workspaces</dt><dd>${esc(workspaces)}</dd></div>`:''}
        <div><dt>Account</dt><dd>${connection?link('connections/'+connection.id+'/activity',connection.account,'text-btn'):esc(log.account||'Disconnected account')}</dd></div>
        <div><dt>Tool</dt><dd><code>${esc(log.tool)}</code></dd></div><div><dt>Target</dt><dd>${esc(log.target||'—')}</dd></div><div><dt>Time</dt><dd>${showDate(log.at)}</dd></div></dl></section>
        <section class="panel receipt-panel">${panelHead('Policy decision')}<dl class="facts">
        <div><dt>${log.policy?'Policy at request':'Current tool policy'}</dt><dd>${esc(log.policy || DB.policy(w,connection,log.tool))}</dd></div>
        <div><dt>Result</dt><dd>${esc(log.detail||log.outcome)}</dd></div></dl>
        ${pending(log)?`<div class="receipt-actions"><button type="button" class="btn" data-m-decision="deny" data-m-id="${esc(id)}">Deny</button><button type="button" class="btn primary" data-m-decision="approve" data-m-id="${esc(id)}">Approve</button></div>`:''}</section>`;
  }

  function error(formEl, message) {
    const box = formEl.querySelector('[data-m-error]');
    box.textContent = message;
    box.hidden = false;
  }

  function submit(e) {
    const f = e.target.closest('form[data-m-form]');
    if (!f) return;
    e.preventDefault();
    const data = new FormData(f);
    const val = key => String(data.get(key) || '').trim();
    const w = DB.w();
    const same = (a,b) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
    try {
      switch (f.dataset.mForm) {
        case 'workspace': {
          const name = val('name');
          if (!name) return error(f, 'Enter a workspace name.');
          if (DB.workspaces().some(v => same(v.name,name))) return error(f, 'A workspace already uses that name.');
          DB.createWorkspace(name);
          UI.nav('overview'); UI.toast('Workspace created');
          break;
        }
        case 'connection': {
          const service = val('service'), account = val('account');
          const app=AirportDirectory.app(val('slug'));
          if (!account || (!DB.services[service] && !app)) return error(f,'Choose an integration and enter an account label.');
          if (w.connections.some(c => c.service === service && same(c.account, account))) return error(f, 'This account is already connected.');
          const added=DB.addConnection(service,account,app?.name);
          UI.nav('connections/'+added.id+'/settings'); UI.toast('Sample connection added');
          break;
        }
        case 'agent': {
          const name = val('name');
          if (!name) {
            UI.modal('Agent chooses its name', `<div class="form"><textarea readonly data-m-prompt rows="7">${esc(setupPrompt(null,val('lifetime')))}</textarea><div class="actions"><button class="btn" data-m-copy>Copy example</button></div></div>`);break;
          }
          const provider = Object.hasOwn(DB.providers,name.toLowerCase()) ? name.toLowerCase() : 'custom';
          if (w.agents.some(a => same(a.name, name))) return error(f, 'An agent already uses that name.');
          const grants = data.getAll('workspaces').map(String);
          const added = DB.addAgent(name, provider, [...new Set([w.id, ...grants])],val('lifetime'));
          UI.nav('agents/'+added.id); UI.toast('Sample agent added');
          break;
        }
        case 'permissions': {
          const changes=Array.from(f.querySelectorAll('[data-m-rule]')).filter(el=>el.value!==el.dataset.saved)
            .map(el=>({connectionId:el.dataset.mConnection,tool:el.dataset.mRule,value:el.value}));
          DB.savePolicies(changes);
          for(const el of f.querySelectorAll('[data-m-rule]')) {el.dataset.saved=el.value;for(const opt of el.options)opt.defaultSelected=opt.selected;}
          refreshDirty(f);UI.toast('Tool permissions saved');break;
        }
        case 'settings': DB.renameConnection(f.dataset.mId,val('account'));UI.refresh();UI.toast('Account label saved');break;
        case 'revoke-agent': DB.revokeAgent(f.dataset.mId);UI.nav('agents');UI.toast('Sample access revoked');break;
        case 'disconnect': DB.removeConnection(f.dataset.mId);UI.nav('connections');UI.toast('Account disconnected');break;
        case 'test': {
          const a = findById(w.agents,val('agent')), c = findById(w.connections,val('connection'));
          if (!a || !c || !serviceTools(c.service).includes(val('tool')) || !val('target')) return error(f,'Choose an agent, connection, tool, and target.');
          const log = DB.run(a.id, c.id, val('tool'), val('target'));
          if(log) UI.nav('activity/'+log.id);
          break;
        }
      }
    } catch (err) { error(f, err.message || 'The change could not be saved.'); }
  }

  function filterActivity() {
    const input = document.querySelector('[data-m-filter-activity]');
    if (!input) return;
    const query = input.value.trim().toLowerCase();
    const outcome = document.querySelector('[data-m-filter-outcome]').value;
    let shown = 0;
    document.querySelectorAll('[data-m-log-row]').forEach(row => {
      const matches = (!outcome || row.dataset.mLogRow === outcome) && row.dataset.mSearch.includes(query);
      row.hidden = !matches;
      if (matches) shown++;
    });
    document.querySelector('[data-m-no-results]').hidden = Boolean(shown);
    document.querySelector('[data-request-count]').textContent=shown;
  }

  async function copyPrompt(el) {
    const box = el.closest('.form')?.querySelector('[data-m-prompt]');
    if (!box) return;
    try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(box.value); }
    catch {
      box.focus(); box.select();
      if (!document.execCommand?.('copy')) { UI.toast('Select and copy the setup prompt'); return; }
    }
    UI.toast('Setup prompt copied');
  }

  function refreshDirty(f) {
    const count=[...f.querySelectorAll('[data-m-rule]')].filter(el=>el.dataset.saved!==el.value).length;
    for(const b of f.querySelectorAll('button[type=reset],button[type=submit]'))b.disabled=!count;
    f.querySelector('[data-policy-status]').textContent=count?count+' unsaved '+(count===1?'change':'changes'):'All changes saved';
  }
  const openers={connection:connectionForm,agent:agentForm,workspace:workspaceForm,test:testForm,disconnect:disconnectForm,'revoke-agent':revokeAgentForm,
    log:id=>UI.nav('activity/'+id),'connection-detail':id=>UI.nav('connections/'+id+'/settings'),'agent-detail':id=>UI.nav('agents/'+id)};
  const pages={connections,agents,policies,activity};
  window.Mgr={
    page(page,id,tab){
      if(page==='connections'&&id)return connectionPage(id,tab);
      if(page==='activity'&&id)return logDetail(id);
      if(page==='agents'&&id)return agentDetail(id);
      return Object.hasOwn(pages,page)?pages[page]():missing('Page','overview');
    },
    open(action,id){if(Object.hasOwn(openers,action))openers[action](id);}
  };
  document.addEventListener('reset',e=>{if(e.target.matches('[data-m-form=permissions]'))setTimeout(()=>refreshDirty(e.target),0);});
  document.addEventListener('submit', submit);
  document.addEventListener('click', e => {
    const el = e.target.closest('button');
    if (!el) return;
    if (el.hasAttribute('data-m-close')) UI.close();
    if (el.dataset.mOpen) window.Mgr.open(el.dataset.mOpen, el.dataset.mId);
    if (el.hasAttribute('data-m-copy')) copyPrompt(el);
    if (el.dataset.mPause) {
      try { DB.toggleAgent(el.dataset.mPause);UI.toast('Agent access updated'); }
      catch(err){ UI.toast(err.message); }
      UI.refresh();
    }
    if (el.dataset.mDecision) {
      const approve = el.dataset.mDecision === 'approve';
      const log = findById(DB.w().logs, el.dataset.mId);
      if (!log || !pending(log)) return;
      const resolved = DB.resolve(log.id, approve);
      UI.close(); UI.refresh(); UI.toast('Request ' + resolved.outcome.toLowerCase());
    }
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.matches('[data-m-test-connection]')) {
      const c = findById(DB.w().connections, el.value);
      if (c) el.form.elements.tool.innerHTML = options(serviceTools(c.service).map(t => [t,nameOf(t)]));
    }
    if(el.matches('[data-m-rule]'))refreshDirty(el.form);
    if (el.matches('[data-m-filter-policies]')) {
      document.querySelectorAll('[data-m-policy-group]').forEach(group => { group.hidden = Boolean(el.value && group.dataset.mPolicyGroup !== el.value); });
    }
    if (el.matches('[data-m-filter-outcome]')) filterActivity();
  });
  document.addEventListener('input', e => { if (e.target.matches('[data-m-filter-activity]')) filterActivity(); });
})();
