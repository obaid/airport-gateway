// Both consoles supply workspace-scoped data and links to the same overview.
(() => {
  'use strict';
  function stats(model,ui) {
    const {week}=model;
    const values=[
      [model.agents,'Active agents','agents'],[model.accounts,'Connected accounts','connections'],
      [week.requests,'Requests in 7 days','activity'],[week.blocked,'Policy blocks in 7 days','policies']
    ];
    return '<div class="stats">'+values.map(([n,label,page],index)=>{
      const minimum=week.limited && index>1;
      return '<a href="'+ui.escape(ui.href(page))+'"'+(minimum?' title="Minimum count from the available activity history"':'')+'><span>'+label+'</span><strong>'+Number(n).toLocaleString()+(minimum?'+':'')+'</strong></a>';
    }).join('')+'</div>';
  }
  function mapFrame({legendHTML,agentsHTML,gatewayHTML,accountsHTML,traceHTML},ui) {
    return '<div class="map-heading"><div><span class="map-symbol">'+ui.icon('route',19)+'</span><h2>Gateway map</h2></div><div class="map-legend">'+legendHTML+'</div></div>'+
      '<div class="diagram"><svg class="route-lines" aria-hidden="true"></svg>'+agentsHTML+
      '<div class="map-center"><div class="radar-rings" aria-hidden="true"><i></i><i></i><i></i></div>'+gatewayHTML+'</div>'+accountsHTML+'</div>'+
      '<div class="trace-bar">'+traceHTML+'</div>';
  }
  function recentRequests({recent},ui) {
    const escape=ui.escape;
    const rows=recent.slice(0,4).map(l=>{
      const outcome=String(l.outcome||'Unknown');
      const requester=ui.requestLogo?ui.requestLogo(l,24):ui.logo(l.mark||'custom',24);
      return '<a class="feed-row" href="'+escape(ui.activityURL(l.id))+'"><span class="feed-logo">'+requester+'</span><span class="feed-id"><strong>'+
        escape(l.actor||'Requester not recorded')+(l.service?' <span class="route-arrow">→</span> '+escape(l.service):'')+'</strong><code>'+escape(l.tool)+'</code></span><span class="state-badge '+escape(outcome.toLowerCase())+'"><i></i>'+escape(outcome)+'</span><span class="feed-time">'+escape(ui.time(l.at))+'</span></a>';
    });
    return '<section class="panel feed"><div class="panel-head"><h2>Recent requests</h2><a class="text-btn" href="'+escape(ui.href('activity'))+'">View log '+ui.icon('chevron-right',13)+'</a></div>'+
      (rows.join('')||'<div class="empty">Run a test request to see its decision here.</div>')+'</section>';
  }
  function decisions({week,pendingId},ui) {
    const categories=[['Allowed','good',week.allowed],['Blocked or denied','stop',week.blocked]];
    if(week.pending!==undefined)categories.push(['Pending approval','wait',week.pending]);
    if(week.failed)categories.push(['Failed or interrupted','failed',week.failed]);
    if(week.other)categories.push(['In progress','other',week.other]);
    const total=categories.reduce((sum,row)=>sum+row[2],0);
    let offset=0;
    const segments=categories.filter(c=>c[2]).map(([,cls,n])=>{
      const start=offset;offset+=n;
      return '<rect class="'+cls+'" x="'+start+'" width="'+n+'" height="1"/>';
    }).join('');
    const pendingLink=pendingId?'<a class="review-pending" href="'+ui.escape(ui.activityURL(pendingId))+'">'+ui.icon('clock',14)+'Review pending request '+ui.icon('chevron-right',13)+'</a>':'';
    return '<section class="panel decisions"><div class="panel-head"><h2>Policy decisions</h2><span class="sub">7 days</span></div><div class="dec-body"><div class="dec-main"><b>'+Number(week.requests).toLocaleString()+(week.limited?'+':'')+'</b><span>total requests</span></div>'+
      '<svg class="decision-bar" aria-hidden="true" viewBox="0 0 '+Math.max(total,1)+' 1" preserveAspectRatio="none">'+segments+'</svg>'+
      categories.map(([label,cls,n])=>'<div class="dec-row"><i class="'+cls+'"></i><span>'+label+'</span><b>'+Number(n).toLocaleString()+'</b></div>').join('')+'</div>'+pendingLink+'</section>';
  }
  function lower(model,ui) {return '<div class="bottom-grid">'+recentRequests(model,ui)+decisions(model,ui)+'</div>';}
  window.AirportOverview={stats,mapFrame,lower};
})();
