// Airport's hosted beta starts at midnight Pacific on November 22. Keep this
// launch window fixed for cohort reporting even when the free allowance renews.
export const BETA_START = '2026-11-22T08:00:00.000Z';
export const BETA_END = '2026-12-22T08:00:00.000Z';
export const BETA_LIMIT = 1000;
export const ALLOWANCE_DETAIL = 'The account’s free action allowance is in use. Open Billing in Airport to see usage and the next allowance date.';
const launch = Date.parse(BETA_START);
const duration = Date.parse(BETA_END) - launch;
const iso = ms => new Date(ms).toISOString();
const isAgent = "x.channel IN ('mcp','http')";
const periodRows = 'FROM requests r JOIN request_exchanges x ON x.request_id=r.id WHERE r.at>=? AND r.at<?';

function periodAt(at) {
  const cycles = Math.max(0, Math.floor((at-launch)/duration));
  const start = launch+cycles*duration;
  return {start,end:start+duration,status:at<launch?'upcoming':cycles?'continued':'beta'};
}

export function createBetaMeter(db) {
  // A Running audit entry holds its slot until finish() commits the final
  // outcome. Startup recovery changes abandoned requests to Interrupted.
  const held = db.prepare(`SELECT count(*) AS count ${periodRows} AND ${isAgent}
    AND r.providerCalled=1 AND r.outcome IN ('Allowed','Running')`);
  const bySpace = db.prepare(`SELECT w.id,w.name,coalesce(u.used,0) AS used FROM workspaces w
    LEFT JOIN (SELECT r.workspace,count(*) AS used ${periodRows} AND ${isAgent}
      AND r.providerCalled=1 AND r.outcome='Allowed' GROUP BY r.workspace) u ON w.id=u.workspace ORDER BY w.id`);
  return {
    // Called inside the same BEGIN IMMEDIATE transaction that inserts the Running entry.
    available(at) {
      const {start,end,status}=periodAt(at);
      return status==='upcoming' || held.get(start,end).count < BETA_LIMIT;
    },
    usage(at) {
      const {start,end,status}=periodAt(at);
      const byWorkspace=bySpace.all(start,Math.min(end,at+1));
      const used=byWorkspace.reduce((sum,w)=>sum+w.used,0);
      return {plan:'free-beta',status,periodStart:iso(start),periodEnd:iso(end),launchStart:BETA_START,launchEnd:BETA_END,
        limit:BETA_LIMIT,used,remaining:Math.max(0,BETA_LIMIT-used),byWorkspace};
    }
  };
}

// Read-only for the admin report. Some tenants last opened an older release.
export function readBetaUsage(db, at=Date.now(), window='launch') {
  const {start,end}=periodAt(window==='current'?at:launch);
  const report={start:iso(start),end:iso(end),limit:BETA_LIMIT,used:0,providerAttempts:0,limitDenials:0,agentFailures:0,policyDenials:0,daily:[]};
  const tables=db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('requests','request_exchanges')").get();
  if(tables.n!==2 || at<start) return report;
  const columns=db.prepare('PRAGMA table_info(request_exchanges)').all().map(c=>c.name);
  // Older catalog receipts explicitly record dispatch in the response. The
  // built-in Gmail read goes straight to the provider once its policy passes.
  const attempted=`coalesce(${columns.includes('provider_dispatched')?'x.provider_dispatched,':''}json_extract(x.response_json,'$.dispatched'),
    (r.providerCalled=1 AND (r.tool='gmail_inbox_counts' OR r.outcome='Allowed')),0)`;
  const denied=columns.includes('decision_code')?"coalesce(x.decision_code='account_action_limit',0)":"0";
  const rows=db.prepare(`SELECT CAST((r.at-?)/86400000 AS INTEGER) AS dayIndex,
    count(*) FILTER (WHERE ${isAgent} AND r.providerCalled=1 AND r.outcome='Allowed') AS used,
    count(*) FILTER (WHERE ${attempted}=1) AS providerAttempts,
    count(*) FILTER (WHERE ${isAgent} AND r.outcome='Blocked' AND ${denied}) AS limitDenials,
    count(*) FILTER (WHERE ${isAgent} AND r.outcome='Blocked' AND NOT ${denied}) AS policyDenials,
    count(*) FILTER (WHERE ${isAgent} AND r.outcome IN ('Interrupted','Failed')) AS agentFailures
    ${periodRows} GROUP BY dayIndex ORDER BY dayIndex`)
    .all(start,start,Math.min(end,at+1));
  for(const row of rows) {
    if(!row.used && !row.providerAttempts && !row.limitDenials && !row.policyDenials && !row.agentFailures)continue;
    for(const field of ['used','providerAttempts','limitDenials','policyDenials','agentFailures'])report[field]+=row[field];
    report.daily.push({day:iso(start+row.dayIndex*86400000).slice(0,10),used:row.used,providerAttempts:row.providerAttempts});
  }
  return report;
}
