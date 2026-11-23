(() => {
  'use strict';

  const find = selector => document.querySelector(selector);
  const tokenKey = 'airport.account.invite';
  const tokenFormat = /^ainv_[A-Za-z0-9_-]{43}$/;
  let session, inviteToken = '', invalidLink = false, settingsHost, createdInvite;

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function symbol(name, size = 18) {
    const span = element('span','acct-icon');
    span.setAttribute('aria-hidden','true');
    span.innerHTML = window.Art.icon(name,size);
    return span;
  }
  function button(label, kind, click) {
    const el = element('button','btn '+(kind || ''),label);
    el.type = 'button';
    if (click) el.addEventListener('click',click);
    return el;
  }
  function link(label, href, className) {
    const el = element('a',className,label);
    el.href = href;
    return el;
  }
  function feedback() {
    const el = element('p','acct-feedback');
    el.setAttribute('aria-live','polite');
    el.setAttribute('aria-atomic','true');
    return el;
  }
  function tell(el, text, error = false) {
    el.textContent = text;
    el.classList.toggle('is-error',error);
  }
  function inputField(title, name, type = 'text') {
    const label = element('label','acct-field'), input = element('input');
    input.type = type;
    input.name = name;
    label.append(element('span','',title), input);
    return {label,input};
  }
  function submit(label) {
    const el = button(label,'primary');
    el.type = 'submit';
    return el;
  }
  async function accountAPI(path = '', data) {
    const init = {cache:'no-store',credentials:'same-origin',redirect:'error'};
    if (data !== undefined) Object.assign(init,{
      method:'POST',headers:{'Content-Type':'application/json','X-Airport-Console':'1'},body:JSON.stringify(data)
    });
    const response = await fetch('/api/account'+path,init);
    const result = await response.json().catch(()=>({}));
    if (!response.ok) {
      const err = new Error(typeof result?.error === 'string' ? result.error : 'Airport could not complete this request.');
      err.code = result?.code;
      err.status = response.status;
      throw err;
    }
    if (data===undefined && path==='' && (typeof result?.identity?.email!=='string' || !result.identity.email ||
        (result.account!==null && typeof result.account?.displayName!=='string'))) {
      throw new TypeError('Airport returned an incomplete account response.');
    }
    return result;
  }

  function temporarilyUnavailable(error) {
    return error instanceof TypeError || [502,503,504].includes(error.status);
  }

  async function loadSession() {
    // The owner shell can arrive just before the host switches instances.
    // Retry only the account read. Signup and other account changes run once.
    for (const delay of [750,1500]) {
      try { return await accountAPI(); }
      catch (error) {
        if (!temporarilyUnavailable(error)) throw error;
      }
      await new Promise(resolve=>setTimeout(resolve,delay));
    }
    return accountAPI();
  }

  function remember(token) {
    inviteToken = token;
    try {
      if (token) sessionStorage.setItem(tokenKey,token);
      else sessionStorage.removeItem(tokenKey);
    } catch { /* The same-page flow still works without session storage. */ }
  }
  function captureInvite() {
    if (location.hash.startsWith('#invite=')) {
      let raw = '';
      try { raw = decodeURIComponent(location.hash.slice(8)); } catch { /* Malformed fragment. */ }
      history.replaceState(null,'',location.pathname+location.search);
      invalidLink = !tokenFormat.test(raw);
      remember(invalidLink ? '' : raw);
    } else {
      try {
        const stored = sessionStorage.getItem(tokenKey) || '';
        if (tokenFormat.test(stored)) inviteToken = stored;
        else remember('');
      } catch { /* Optional browser storage. */ }
    }
  }
  function tokenFromInput(value) {
    const text = value.trim();
    if (tokenFormat.test(text)) return text;
    let url;
    try { url = new URL(text); } catch { return ''; }
    if (url.origin !== location.origin || !['/','/welcome'].includes(url.pathname) || url.username || url.password || url.search) return '';
    const raw = url.hash.startsWith('#invite=') ? url.hash.slice(8) : '';
    return tokenFormat.test(raw) ? raw : '';
  }
  const isPlatformAdmin=()=>Boolean(session?.account && session.isPlatformAdmin===true);
  function drawFooter() {
    const account = session?.account;
    if (!account) return;
    const words = account.displayName.trim().split(/\s+/u);
    find('#account-avatar').textContent = [words[0],...(words.length>1 ? [words.at(-1)] : [])].map(w=>[...w][0]).join('').toLocaleUpperCase();
    find('#account-menu-email').textContent = account.email;
    find('#account-switch-name').textContent = account.displayName;
    find('#account-switch').setAttribute('aria-label','Account menu for '+account.displayName);
    find('#local-account').hidden = true;
    find('#account-dock').hidden = false;
    find('#account-billing').hidden = session.publicBeta!==true;
    const platform=find('#platform-nav');
    platform.hidden=!isPlatformAdmin();
    if(platform.hidden)platform.replaceChildren();
    else if(!platform.childElementCount){
      const admin=link('','/admin','nav-item');
      admin.dataset.nav='admin';
      const icon=element('span');
      icon.dataset.icon='shield';icon.setAttribute('aria-hidden','true');
      icon.innerHTML=window.Art.icon('shield',16);
      admin.append(icon,element('span','','Admin'));
      platform.append(element('div','nav-label second','Platform'),admin);
    }
  }
  function closeMenu(focus = false) {
    const pop = find('#account-popover');
    if (pop.hidden) return;
    pop.hidden = true;
    find('#account-switch').setAttribute('aria-expanded','false');
    if (focus) find('#account-switch').focus();
  }
  function bindMenu() {
    const dock = find('#account-dock'), trigger = find('#account-switch'), pop = find('#account-popover');
    trigger.addEventListener('click',()=>{
      if (!pop.hidden) return closeMenu();
      pop.hidden = false; trigger.setAttribute('aria-expanded','true');
      pop.querySelector('a').focus();
    });
    dock.addEventListener('focusout',e=>{if(e.relatedTarget && !dock.contains(e.relatedTarget)) closeMenu();});
    dock.addEventListener('keydown',e=>{
      if(e.key==='Escape' && !pop.hidden){e.stopPropagation();e.preventDefault();closeMenu(true);}
    });
    document.addEventListener('click',e=>{if(!dock.contains(e.target) || e.target.closest('#account-popover a'))closeMenu();});
    dock.querySelector('[data-account-logout]').addEventListener('click',signOut);
  }
  function gate(title, description) {
    const root = find('#account-access');
    document.body.classList.add('acct-onboarding');
    root.hidden = false;
    root.classList.add('access-shell');
    const top=element('header','access-header'),brand=link('Airport','https://airport.so/','access-brand');
    brand.setAttribute('aria-label','Airport home');
    brand.insertAdjacentHTML('afterbegin',window.Art.brand(37));
    const help=link('How Airport works','https://airport.so/#agents','access-home');
    const arrow=element('span','','↗');arrow.setAttribute('aria-hidden','true');help.append(arrow);
    top.append(brand,help);
    const world=element('div','access-world'),panel=element('section','access-pass');
    const h=element('h1','',title); h.id='access-title'; h.tabIndex=-1;
    panel.append(h,element('p','access-intro',description));
    const radar=element('img','access-radar');
    radar.src='/assets/access-airfield.svg';radar.width=620;radar.height=620;
    radar.alt='Example route from an agent through Airport to email and calendar.';
    world.append(panel,radar);
    root.replaceChildren(top,world);document.title=title+' · Airport';
    h.focus({preventScroll:true});
    return panel;
  }
  function identityBadge(email) {
    const el = element('div','acct-identity');
    el.append(symbol('check',15),element('span','','Signed in as '+email));
    return el;
  }
  async function signOut(event) {
    event.preventDefault();
    remember('');
    if (session?.authMode !== 'email') {
      location.assign('/cdn-cgi/access/logout');
      return;
    }
    try {
      const result = await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json','X-Airport-Console':'1'},body:'{}'});
      if (result.ok || result.status===401) return location.replace('/login');
    } catch { /* Let the user retry without implying their session was cleared. */ }
    const panel=gate('Couldn’t sign out','Check your connection and try again.');
    panel.append(button('Retry sign out','primary',signOut));
  }
  function switchIdentity(panel) {
    const foot = element('div','acct-entry-foot');
    const other=link('Use a different email','/login','acct-text-link');
    other.addEventListener('click',signOut);
    foot.append(other);
    panel.append(foot);
  }
  function showRegistration() {
    const open = session.signupMode === 'open';
    const title = inviteToken ? 'Accept your invitation' : open ? 'Create your account' : 'Join Airport';
    const note = inviteToken ? 'Set up your own Airport account and workspaces.' : open ? 'Choose the name you want to use in Airport.' : 'Airport is invite-only. Open your invitation link or paste it below to create your account.';
    const panel = gate(title,note);
    panel.append(identityBadge(session.identity.email));
    const form = element('form','access-form acct-join-form'), name = inputField('Display name','displayName');
    name.input.required=true;name.input.maxLength=80;name.input.autocomplete='name';
    const invite = inputField('Invitation link','invitation'); invite.input.autocomplete='off'; invite.input.spellcheck=false;
    invite.input.placeholder='Paste your Airport invitation';
    const requireToken = !open && !inviteToken;
    invite.input.required=requireToken;invite.label.hidden=!requireToken && !invalidLink;
    const action=submit(inviteToken?'Accept and create account':'Create account'), status=feedback();
    if(invalidLink)tell(status,'This link is incomplete. Paste a fresh invitation from your Airport admin.',true);
    form.append(name.label,invite.label,action,status);panel.append(form);switchIdentity(panel);
    form.addEventListener('submit',async e=>{
      e.preventDefault();if(action.disabled)return;
      const entered = invite.input.value.trim();
      const token = entered ? tokenFromInput(entered) : inviteToken;
      if((entered && !token) || (!open && !token)){
        tell(status,'Enter the complete invitation link from your Airport admin.',true);invite.input.focus();return;
      }
      if(!name.input.value.trim()){tell(status,'Enter a display name.',true);name.input.focus();return;}
      action.disabled=true;tell(status,'Creating your account…');
      try{
        await accountAPI('/signup',{displayName:name.input.value.trim(),...(token?{token}:{})});
        remember('');location.reload();
      }catch(error){
        if(error.code==='invitation_invalid' || error.code==='invitation_required'){
          tell(status,'This invitation could not be accepted. Sign in with the invited email, or ask your admin for a fresh link if it expired, was used, or was revoked.',true);
          invite.label.hidden=false;invite.input.focus();
        }else tell(status,error.message || 'Could not create the account. Try again.',true);
      }finally{action.disabled=false;}
    });
  }
  async function connect() {
    captureInvite();
    try{
      session = await loadSession();
    }catch(error){
      if(temporarilyUnavailable(error)){
        const panel=gate('Airport is temporarily unavailable','Try again to open this workspace.');
        const actions=element('div','acct-actions');
        actions.append(button('Try again','primary',()=>location.reload()));
        panel.append(actions);return false;
      }
      const panel=gate('Open your Airport account','We couldn’t load your sign-in details. Sign in again or retry the connection.');
      const actions=element('div','acct-actions');
      const signInPath=location.pathname==='/account'||location.pathname==='/billing'||location.pathname.startsWith('/w/')
        ? location.pathname+location.search : '/login'+location.hash;
      actions.append(link('Sign in',signInPath,'btn primary'),button('Retry','',()=>location.reload()));
      panel.append(actions);return false;
    }
    if(session.signupMode==='open'){remember('');invalidLink=false;}
    if(!session.account){showRegistration();return false;}
    if(inviteToken || invalidLink){
      const panel=gate('You already have an account','Continue to your workspaces, or switch emails to use an invitation for another account.');
      panel.append(identityBadge(session.account.email));
      const actions=element('div','acct-actions');
      actions.append(button('Open my workspace','primary',()=>{remember('');location.reload();}));panel.append(actions);switchIdentity(panel);
      return false;
    }
    drawFooter();bindMenu();return true;
  }
  function block(title, description) {
    const section=element('section','panel acct-block'),head=element('div','acct-block-head');
    head.append(element('h2','',title),element('p','',description));
    section.append(head);return section;
  }
  function profile(root) {
    const p=session.account,section=block('Profile','Your display name appears in the account menu.');
    const form=element('form','acct-profile-form'),name=inputField('Display name','displayName');
    name.input.maxLength=80;name.input.required=true;name.input.autocomplete='name';name.input.value=p.displayName;
    const save=submit('Save name'),row=element('div','acct-form-line'),status=feedback();
    row.append(name.label,save);form.append(row,status);section.append(form);
    const details=element('dl','acct-details');
    const item=(label,value)=>{const line=element('div');line.append(element('dt','',label),element('dd','',value));details.append(line);return line.lastElementChild;};
    const email=item('Sign-in email',p.email),verified=element('span','acct-verified','Verified');verified.prepend(symbol('check',12));email.append(verified);
    item('Account role',p.role==='admin'?'Administrator':'Member');section.append(details);
    form.addEventListener('submit',async e=>{
      e.preventDefault();const displayName=name.input.value.trim();if(save.disabled||!displayName)return;
      save.disabled=true;
      try{const result=await accountAPI('/profile',{displayName});session=result;drawFooter();name.input.value=session.account.displayName;tell(status,'Display name saved.');}
      catch(error){tell(status,error.message,true);}
      finally{save.disabled=false;}
    });
    root.append(section);
  }
  function invitations(root) {
    const section=block('Account invitations','Invite someone to create their own Airport account. Each link works once and expires in seven days.');
    const form=element('form','acct-invite-form'),field=inputField('Recipient email','email','email');
    field.input.autocomplete='off';field.input.required=true;field.input.maxLength=254;field.input.placeholder='name@example.com';
    const send=submit('Create invitation'),line=element('div','acct-form-line'),status=feedback();
    const result=element('div','acct-copy-result'),list=element('div','acct-invite-list');
    line.append(field.label,send);form.append(line,status);section.append(form,result,list);root.append(section);
    let revision=0;
    const current=()=>root===settingsHost && root.isConnected;
    function showLink(){
      result.replaceChildren();if(!current()||!createdInvite)return;
      const box=inputField('One-use invitation for '+createdInvite.email,'inviteURL');
      box.input.readOnly=true;box.input.value=createdInvite.url;box.input.autocomplete='off';
      const copy=button('Copy link','',async()=>{
        try{await navigator.clipboard.writeText(box.input.value);tell(message,'Link copied.');}
        catch{box.input.focus();box.input.select();tell(message,'Select and copy the link.');}
      });copy.prepend(symbol('copy',14));const row=element('div','acct-form-line'),message=feedback();
      row.append(box.label,copy);result.append(row,element('p','acct-hint','Copy this link before leaving this page.'),message);
    }
    async function refresh(){
      const seq=++revision;
      try{
        const data=await accountAPI('/invitations');
        if(!current()||seq!==revision)return;
        const rows=data.invitations;
        if(createdInvite&&!rows.some(r=>r.id===createdInvite.id&&r.status==='pending')){createdInvite=null;showLink();}
        list.replaceChildren();
        if(!rows.length){list.append(element('p','acct-empty','No invitations yet.'));return;}
        list.append(element('h3','acct-list-title','Invitation history'));
        for(const r of rows){
          const row=element('div','acct-invite-row'),info=element('div','acct-invite-info');
          const date=new Date(r.expiresAt).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
          info.append(element('strong','',r.email),element('small','',r.status==='pending'?'Expires '+date:'Created '+new Date(r.createdAt).toLocaleDateString()));
          const tag=element('span','acct-state',r.status[0].toUpperCase()+r.status.slice(1));tag.dataset.state=r.status;
          row.append(info,tag);
          if(r.status==='pending'){
            const revoke=button('Revoke','acct-revoke',()=>{
              const group=element('div','acct-revoke-confirm'),question=element('span','','Revoke this link?');
              const yes=button('Revoke','',async()=>{
                yes.disabled=true;
                try{await accountAPI('/invitations/revoke',{id:r.id});if(!current())return;tell(status,'Invitation revoked.');await refresh();field.input.focus();}
                catch(error){tell(status,error.message,true);yes.disabled=false;}
              });
              const cancel=button('Cancel','',()=>{group.replaceWith(revoke);revoke.focus();});
              group.append(question,cancel,yes);revoke.replaceWith(group);cancel.focus();
            });
            revoke.setAttribute('aria-label','Revoke invitation for '+r.email);row.append(revoke);
          }
          list.append(row);
        }
      }catch(error){if(current()&&seq===revision){list.replaceChildren(element('p','acct-feedback is-error',error.message),button('Retry','',refresh));}}
    }
    form.addEventListener('submit',async e=>{
      e.preventDefault();if(send.disabled)return;
      send.disabled=true;tell(status,'');
      try{
        const data=await accountAPI('/invitations',{email:field.input.value.trim()});
        if(!current())return;
        if(!tokenFromInput(data.inviteUrl))throw Error('The server returned an invalid invitation link.');
        createdInvite={id:data.invitation.id,email:data.invitation.email,url:data.inviteUrl};
        field.input.value='';tell(status,'Invitation created.');showLink();await refresh();
      }catch(error){if(current())tell(status,error.message,true);}
      finally{send.disabled=false;}
    });
    list.append(element('p','acct-empty','Loading invitations…'));refresh();
  }
  function settings(root) {
    if(root===settingsHost)return;
    settingsHost=root;const inner=element('div','acct-settings');root.replaceChildren(inner);
    profile(inner);if(session.signupMode==='invite' && session.account.role==='admin')invitations(root);
  }
  window.AirportAccount = {connect,isPlatformAdmin,hasBilling:()=>session?.publicBeta===true && Boolean(session?.account),accountId:()=>session?.account?.id,signedIn:()=>Boolean(session?.account),settings,unmount(){settingsHost=null;createdInvite=null;closeMenu();}};
})();
