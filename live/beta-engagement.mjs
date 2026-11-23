import {lstatSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const day=24*60*60*1000;
const milliseconds=value=>typeof value==='number'?value:Date.parse(value);

// Called once inside the admin reporting worker. Include signups that never opened a workspace.
export function createBetaEngagement(tenantDir,launchStart,launchEnd,now) {
  const start=milliseconds(launchStart),stop=Math.min(milliseconds(launchEnd),now);
  const path=join(dirname(tenantDir),'accounts.sqlite3');
  if(!lstatSync(path,{throwIfNoEntry:false})?.isFile())return {observe(){},summary(){return null;}};
  const registry=new DatabaseSync(path,{readOnly:true});
  let signups;
  try {
    signups=registry.prepare(`SELECT tenant,created_at FROM users WHERE created_at>=? AND created_at<?`)
      .all(start,stop);
  }finally{registry.close();}
  const joined=new Map(signups.map(row=>[row.tenant,row.created_at]));
  const counts={
    signups:joined.size,activationEligible:signups.filter(row=>row.created_at+day<=stop).length,
    activatedWithin24h:0,weekTwoEligible:0,returnedWeekTwo:0
  };
  return {
    observe(tenant,db){
      const at=joined.get(tenant);
      if(at===undefined || at+day>stop)return;
      // Some legacy stores predate transport attribution. An owner test cannot establish agent use.
      if(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('requests','request_exchanges')").get().n!==2)return;
      const action=db.prepare(`SELECT 1 FROM requests r JOIN request_exchanges x ON x.request_id=r.id
        WHERE r.at>=? AND r.at<? AND r.outcome='Allowed' AND r.providerCalled=1 AND x.channel IN ('http','mcp') LIMIT 1`);
      const activated=Boolean(action.get(at,at+day));
      if(activated)counts.activatedWithin24h++;
      if(at+14*day>stop || !(activated || action.get(at+day,at+7*day)))return;
      counts.weekTwoEligible++;
      if(action.get(at+7*day,at+14*day))counts.returnedWeekTwo++;
    },
    summary(){return {...counts};}
  };
}
