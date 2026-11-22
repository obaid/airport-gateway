import {randomUUID} from 'node:crypto';

// Invitations and bearer credentials use separate tables and independent random secrets.
// Each exchange owns its write transaction, including the insertion of the named grant.
export function createEnrollment({db,transaction,get,grantDuration,agentClientType,availableAgentName,insertNamedGrant,insertLog,secret,hash,fail}) {
  transaction(()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS agent_invitations(
    id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspaces(id),
    digest TEXT NOT NULL UNIQUE, name TEXT, expires INTEGER NOT NULL, lifetime TEXT NOT NULL DEFAULT '12h', clientType TEXT
  ); CREATE INDEX IF NOT EXISTS agent_invitations_workspace ON agent_invitations(workspace,expires);`);
    if (!db.prepare('PRAGMA table_info(agent_invitations)').all().some(c=>c.name==='lifetime'))
      db.exec("ALTER TABLE agent_invitations ADD COLUMN lifetime TEXT NOT NULL DEFAULT '12h'");
    if (!db.prepare('PRAGMA table_info(agent_invitations)').all().some(c=>c.name==='clientType'))
      db.exec('ALTER TABLE agent_invitations ADD COLUMN clientType TEXT');
  });
  function issueAgentInvitation(workspace,name,lifetime='12h',clientType) {
    return transaction(()=>{
      get(workspace);
      grantDuration(lifetime);
      const type=agentClientType(clientType);
      const pinned=name==null?null:availableAgentName(workspace,name);
      const id=randomUUID(),invitation=secret(),expires=Date.now()+10*60_000;
      db.prepare('DELETE FROM agent_invitations WHERE expires<=?').run(Date.now());
      db.prepare('INSERT INTO agent_invitations(id,workspace,digest,name,expires,lifetime,clientType) VALUES(?,?,?,?,?,?,?)').run(id,workspace,hash(invitation),pinned,expires,lifetime,type);
      insertLog(workspace,'Owner console','issue_agent_invitation','Issued',false,'Created a one-use invitation for a workspace agent.');
      return {id,workspace,name:pinned,lifetime,invitation,...(type && {clientType:type}),expiresAt:new Date(expires).toISOString()};
    });
  }
  function listAgentInvitations() {
    return db.prepare('SELECT id,workspace,name,lifetime,expires,clientType FROM agent_invitations WHERE expires>? ORDER BY expires,id').all(Date.now())
      .map(({expires,clientType,...r})=>({...r,...(clientType && {clientType}),expiresAt:new Date(expires).toISOString()}));
  }
  function revokeAgentInvitation(workspace,id) {
    return transaction(()=>{
      if(!db.prepare('DELETE FROM agent_invitations WHERE id=? AND workspace=?').run(id,workspace).changes)
        fail('Unknown agent invitation in this workspace.',404);
      insertLog(workspace,'Owner console','revoke_agent_invitation','Revoked',false,'Revoked an unclaimed agent invitation.');
    });
  }
  function registerAgent(invitation,name) {
    return transaction(()=>{
      const entry=typeof invitation==='string' && /^[A-Za-z0-9_-]{43}$/.test(invitation) &&
        db.prepare('SELECT id,workspace,name,lifetime,clientType FROM agent_invitations WHERE digest=? AND expires>?').get(hash(invitation),Date.now());
      if(!entry) fail('Invitation is invalid, expired or already used.',403);
      if(entry.name!==null && name!==undefined && name!==entry.name)
        fail('Use the agent name selected by the owner.',400);
      const {actor,token,expiresAt}=insertNamedGrant(entry.workspace,entry.name??name,entry.lifetime,entry.clientType);
      db.prepare('DELETE FROM agent_invitations WHERE id=?').run(entry.id);
      insertLog(entry.workspace,actor,'register_agent','Issued',false,'Registered with a one-use workspace invitation.',undefined,entry.clientType);
      return {name:actor,token,expiresAt};
    });
  }
  return {issueAgentInvitation,listAgentInvitations,revokeAgentInvitation,registerAgent};
}
