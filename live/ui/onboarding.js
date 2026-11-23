(() => {
  'use strict';

  const starters = {gmail:'Gmail',googledrive:'Google Drive',github:'GitHub',notion:'Notion'};
  const steps = [
    ['connect','Connect an app'], ['policy','Choose access'], ['invite','Invite an agent'], ['request','Try a request']
  ];
  // Prefer a question with a small, useful answer when its exact tool is allowed.
  const starterQuestions = new Map([
    ['gmail_inbox_counts', 'How many messages are unread in my Gmail inbox? Just give me the count.'],
    ['GMAIL_GET_LABEL', 'How many messages are unread in my Gmail inbox? Check the INBOX label and give me the count.'],
    ['GMAIL_LIST_LABELS', 'What are three labels in my Gmail account? Just give me their names.'],
    ['GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', 'Which three GitHub repositories have I updated most recently? Just give me their names.'],
    ['GITHUB_LIST_REPOSITORIES', 'Can you list up to three GitHub repository names?'],
    ['GOOGLEDRIVE_FIND_FILE', 'What are my three most recently modified files in Google Drive? Just give me their names.'],
    ['GOOGLEDRIVE_LIST_FILES', 'What are my three most recently modified files in Google Drive? Just give me their names.'],
    ['NOTION_SEARCH_NOTION_PAGE', 'Which pages can you see in Notion? Show up to three page titles.'],
    ['NOTION_LIST_PAGES', 'Which pages can you see in Notion? Show up to three page titles.']
  ]);
  const choices = new Map();

  function model(state,w) {
    const receipt = w.firstAgentRequest;
    if (receipt) {
      const app = receipt.exchange?.request?.connection ||
        (receipt.tool==='gmail_inbox_counts' ? {toolkit:'gmail',label:'Gmail'} : null);
      const agent = {actor:receipt.actor,clientType:receipt.clientType};
      return {stage:'complete',receipt,app,agent};
    }
    const connections = (state.connections || []).filter(c => c.workspace === w.id && ['active','pending'].includes(c.status));
    if (['active','pending','mismatch'].includes(w.status)) {
      const tools = [...(w.gmailCatalog?.tools || [])];
      if (w.policy === 'Allow') tools.unshift({name:'Read inbox counts',mcpName:'gmail_inbox_counts',readOnly:true,allowed:true});
      connections.unshift({id:'pilot-gmail',toolkit:'gmail',label:w.email || 'Gmail',status:w.status,accessMode:w.gmailCatalog?.accessMode,tools});
    }
    const active = connections.filter(c => c.status === 'active');
    const reads = c => (c.tools || []).filter(t => t.allowed && t.readOnly === true);
    const hasAccess = c => (c.tools || []).some(t => t.allowed);
    const app = active.find(c => reads(c).length) || active.find(hasAccess) || active[0] || connections[0];
    const available = app && app.status === 'active' ? reads(app) : [];
    const byTool = new Map(available.map(t => [t.slug || t.mcpName,t]));
    const read = byTool.get([...starterQuestions.keys()].find(key => byTool.has(key))) || available[0];
    // A saved Muse connector can call inbox counts. Catalog tools require a named workspace credential.
    const pilotRead = read?.mcpName === 'gmail_inbox_counts';
    const agent = (state.agentGrants || []).find(a => a.workspace === w.id) || (pilotRead && w.grant ? {actor:'Muse',clientType:'muse'} : null);
    const pendingMuse = w.invitation || (state.invites || []).find(i=>i.workspace===w.id);
    const invite = (state.agentInvitations || []).find(i => i.workspace === w.id) || (pilotRead && pendingMuse ? {name:'Muse',legacy:true} : null);
    const lastAttempt = agent && (state.logs || []).find(l=>l.workspace===w.id && l.actor===agent.actor && ['http','mcp'].includes(l.exchange?.channel) && l.tool!=='airport_list_connections' && ['Failed','Blocked','Interrupted'].includes(l.outcome));
    const stage = !active.length ? 'connect' : !hasAccess(app) ? 'policy' : !agent ? 'invite' : 'request';
    return {stage,app,read,agent,invite,lastAttempt};
  }

  function readPrompt(w,app,read) {
    const question = starterQuestions.get(read.slug || read.mcpName) ||
      'What can you tell me using the '+JSON.stringify(read.name || read.slug)+' tool? Start with one result and summarize it in a sentence. Ask me for any inputs you need.';
    return question+' Use '+JSON.stringify(app.label)+' in my '+JSON.stringify(w.name)+' Airport workspace. Use only the approved '+JSON.stringify(read.name || read.slug)+' tool.';
  }

  function view(ctx) {
    const {w,state,model:m,esc,href,mark,icon,agentLogo,when} = ctx;
    const {stage,app,read,agent,invite,receipt} = m;
    const choice = choices.get(w.id) || 'gmail';
    const link = (target,label,action,primary=false) => '<a class="btn '+(primary?'primary':'')+'" href="'+esc(href(target))+'" data-setup-action="'+action+'">'+label+'</a>';
    const policy = app && '#connections/'+encodeURIComponent(app.id)+'/tools';
    const next = icon('arrow-right',16);
    let title,description,control;
    if (stage === 'connect' && !app) {
      title='Connect your first app';
      description='Connect an account to '+w.name+'. After sign-in, you’ll choose which tools agents in this workspace can use.';
      control='<label class="setup-field" for="setup-app-choice">App to connect</label><div class="setup-choice"><span aria-hidden="true">'+mark(choice,22)+'</span><select id="setup-app-choice">'+
        Object.entries(starters).map(([slug,name])=>'<option value="'+slug+'"'+(slug===choice?' selected':'')+'>'+name+'</option>').join('')+
        '</select></div><div class="setup-actions"><button type="button" class="btn primary" data-manage="setup-connect" data-id="'+choice+'">Connect '+starters[choice]+next+'</button>'+
        link('#integrations','Browse all apps','catalog')+'</div>';
    } else if (stage === 'connect') {
      const pending=app.status==='pending';
      title=pending?'Finish connecting your account':'Reconnect your account';
      description=pending?'Finish signing in with the provider. Airport checks the connection when you return.':'Open the connection and sign in with the account you want in this workspace.';
      control=link('#connections/'+encodeURIComponent(app.id)+'/settings','Open '+esc(app.label)+' settings'+next,'connection',true);
    } else if (stage === 'policy') {
      title='Choose what your agent can do';
      description=app.accessMode?'Your current selection allows zero tools on '+app.label+'. Review the individual tools, or connect a different app to try your first request.':
        'Start with Read only. You’ll see which tools Airport can allow for '+app.label+' before you apply the preset. You can change it later.';
      control=app.accessMode?link(policy+'/advanced','Review individual tools'+next,'policy',true)+' '+link('#integrations','Connect another app','catalog'):
        link(policy,'Choose tool access'+next,'policy',true);
    } else if (stage === 'invite') {
      if (invite) {
        title='Give your agent its setup prompt';
        description=invite.legacy?'Open the saved Muse connector to finish pairing. Return here after Muse collects its credential.':'Open '+(invite.name || 'your assistant')+', paste the one-use setup prompt into its chat, then come back here. This step updates when the agent registers.';
        control=invite.legacy?link('#agents/muse','Open Muse pairing'+next,'agents',true):link('#agents','Manage invitations'+next,'agents')+'<p class="setup-note">Lost the prompt? Revoke its invitation in Agents and create another.</p>';
      } else {
        title='Invite your first agent';
        description='Create a one-use prompt, open the assistant you already use, and paste it into its chat. Come back here when it registers. Use an assistant that can connect to a remote MCP server.';
        control='<button type="button" class="btn primary" data-manage="setup-invite">Create agent invitation'+next+'</button>';
      }
    } else if (stage === 'request' && !read) {
      title='Try your workspace policy';
      description='Your policy has no verified read-only tool for a suggested request. Ask '+agent.actor+' to use Airport for a task you choose, then see what happened in Activity. You can keep your current permissions.';
      control=link('#activity','View activity'+next,'activity',true)+' '+link(policy,'Review tool access','policy');
    } else if (stage === 'request') {
      title='Ask your agent for a real read';
      description='Send this to '+agent.actor+'. When its request succeeds, Airport will show you exactly which tool it called.';
      control='<label class="setup-field" for="setup-prompt">First request for '+esc(agent.actor)+'</label><textarea id="setup-prompt" rows="4" readonly>'+esc(readPrompt(w,app,read))+'</textarea><div class="setup-actions"><button class="btn primary" type="button" data-manage="setup-copy">'+icon('copy',16)+'Copy request</button>'+
        link('#activity','View activity','activity')+'<span role="status" id="setup-copy-status"></span></div>';
    } else {
      title='Your first agent request went through';
      description=receipt.actor+' used '+(app?.label || 'an app')+' in '+w.name+'. Open the receipt to see the request, the policy decision, and the response details Airport recorded.';
      const operation=receipt.exchange?.request?.operation;
      const slug=(operation?.slug || receipt.tool).toUpperCase();
      const prefix=(app?.toolkit || '').toUpperCase()+'_';
      const words=(slug.startsWith(prefix)?slug.slice(prefix.length):slug).toLowerCase().replaceAll('_',' ');
      const toolName=receipt.tool==='gmail_inbox_counts'?'Read inbox counts':words.charAt(0).toUpperCase()+words.slice(1);
      control='<div class="setup-receipt"><span>'+icon('check',17)+'Allowed</span><strong>'+esc(toolName)+'</strong><time>'+esc(when(receipt.at))+'</time></div>'+
        link('#activity/'+encodeURIComponent(receipt.id),'View request in Activity'+next,'receipt',true);
    }
    if (m.lastAttempt && ['request','policy'].includes(stage)) {
      const entry=m.lastAttempt;
      control+='<p class="setup-note">'+esc(entry.actor)+' had a '+esc(entry.outcome.toLowerCase())+' request. <a href="'+esc(href('#activity/'+encodeURIComponent(entry.id)))+'">View the attempt in Activity</a></p>';
    }
    const index=stage==='complete'?steps.length:steps.findIndex(([k])=>k===stage);
    const progress='<ol class="setup-steps" aria-label="Workspace setup progress">'+steps.map(([key,label],i)=>{
      const status=i<index?'done':i===index?'current':'next';
      return '<li class="'+status+'" '+(status==='current'?'aria-current="step"':'')+'><span class="setup-step-dot" aria-hidden="true">'+(status==='done'?icon('check',12):i+1)+'</span><span>'+esc(label)+'</span>'+(status==='done'?'<span class="setup-sr"> completed</span>':'')+'</li>';
    }).join('')+'</ol>';
    const workspaces=state.workspaces.map(ws=>'<option value="'+esc(ws.id)+'" '+(ws.id===w.id?'selected':'')+'>'+esc(ws.name)+'</option>').join('');
    const workspaceControl='<label class="setup-space-switch"><span>Workspace</span><select id="setup-workspace" aria-label="Setup workspace">'+workspaces+'</select></label>';
    const scopeCopy= w.id==='work'?'Use Work for your work accounts. An agent invited here can use only the tools you allow here. Your Personal accounts stay separate.':
      w.id==='personal'?'Keep your personal accounts here and your work accounts in Work. Each agent can use only the tools you allow in the workspace you invite it to.':
      'A workspace keeps its own app accounts, agents, and permissions. An agent invited here can use only the tools you allow here.';
    const node=(glyph,name,detail)=>'<li><span class="setup-node-icon" aria-hidden="true">'+glyph+'</span><div><strong>'+esc(name)+'</strong><small>'+esc(detail)+'</small></div></li>';
    const route='<aside class="setup-scope" aria-label="Workspace access"><div class="setup-scope-top">'+workspaceControl+'</div><p>'+scopeCopy+'</p><ol class="setup-route" aria-label="How a request travels">'+
      node(agent?agentLogo(agent.actor,22,agent.clientType):icon('agents',21),agent?.actor || 'Your agent',receipt?'Made the request':agent?'Workspace credential issued':'Sends a request')+
      node(mark('gateway',26),'Airport',receipt?'Allowed by workspace policy':'Checks the workspace policy')+
      node(app?mark(app.toolkit,21):icon('connections',21),app?.label || 'Your app',receipt?'Returned the result':app?.status==='active'?'Account connected':app?'Awaiting sign-in':'Provides the allowed data')+'</ol></aside>';
    return '<div class="setup-card" data-setup-stage="'+stage+'">'+progress+'<div class="setup-grid"><div class="setup-current"><span class="setup-kicker">'+(stage==='complete'?'Request recorded':'Step '+(index+1)+' of '+steps.length)+'</span><h2>'+esc(title)+'</h2><p class="setup-description">'+esc(description)+'</p><div class="setup-controls">'+control+'</div></div>'+route+'</div></div>';
  }

  const setChoice=(ws,slug)=>{if(Object.hasOwn(starters,slug))choices.set(ws,slug);};
  window.AirportOnboarding={model,view,setChoice,starters};
})();
