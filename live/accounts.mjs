// Access uses its signed issuer and subject. Native login binds a proven mailbox
// to the existing registry entry (or the operator-pinned legacy owner) at sign-in.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fail } from './store.mjs';

const inviteLifetime = 7 * 24 * 60 * 60 * 1000;
const invitePattern = /^ainv_[A-Za-z0-9_-]{43}$/;
const digest = value => createHash('sha256').update(value).digest('hex');

export function canonicalEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/u.test(email) ? email : null;
}

function inviteError(message,code) {
  throw Object.assign(new Error(message),{status:403,code});
}
function profileName(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 80 ||
      /[\x00-\x1f\x7f]/u.test(value)) fail('Enter a display name of 1–80 characters.');
  return value.trim();
}

function publicAccount(row) {
  return row ? {id:row.id,email:row.email,displayName:row.display_name,role:row.role,
    createdAt:new Date(row.created_at).toISOString()} : null;
}

function invitation(row, now) {
  const status = row.accepted_at !== null ? 'accepted' : row.revoked_at !== null ? 'revoked' :
    row.expires_at <= now ? 'expired' : 'pending';
  return {id:row.id,email:row.email,status,createdAt:new Date(row.created_at).toISOString(),
    expiresAt:new Date(row.expires_at).toISOString()};
}

export function createAccounts(file, {signupMode='invite',bootstrapEmail=null,bootstrapTenant=null,now=Date.now}={}) {
  const existing=lstatSync(file,{throwIfNoEntry:false});
  if(existing && !existing.isFile())throw Error('The Airport accounts database must be a regular file.');
  const db = new DatabaseSync(file);
  chmodSync(file,0o600);
  db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      tenant TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')),
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS single_platform_owner ON users(role) WHERE role='admin';
    CREATE TABLE IF NOT EXISTS customer_invitations (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL REFERENCES users(tenant), created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER, accepted_at INTEGER,
      accepted_by TEXT REFERENCES users(tenant)
    );
    CREATE INDEX IF NOT EXISTS customer_invitation_email ON customer_invitations(email);
  `);
  const byTenant = db.prepare('SELECT * FROM users WHERE tenant=?');
  const byEmail = db.prepare('SELECT tenant FROM users WHERE email=?');
  const byInvite = db.prepare('SELECT * FROM customer_invitations WHERE id=?');
  const byToken = db.prepare('SELECT * FROM customer_invitations WHERE token_hash=?');
  const admin = db.prepare("SELECT tenant FROM users WHERE role='admin'");
  const insert = db.prepare('INSERT INTO users(tenant,id,email,display_name,role,created_at) VALUES (?,?,?,?,?,?)');
  const createInvite = db.prepare('INSERT INTO customer_invitations(id,email,token_hash,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?)');

  function write(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {const result=fn();db.exec('COMMIT');return result;}
    catch(e){db.exec('ROLLBACK');throw e;}
  }
  function checkEmail(identity) {
    if(bootstrapTenant && identity.email===bootstrapEmail && identity.tenant!==bootstrapTenant)
      fail('This account requires its original sign-in identity. Contact your Airport administrator.',409);
    const other=byEmail.get(identity.email);
    if(other && other.tenant!==identity.tenant) fail('This verified address is already associated with another sign-in. Contact your Airport administrator.',409);
  }
  function bootstrap(identity) {
    return !!bootstrapEmail && identity.email===bootstrapEmail &&
      bootstrapTenant===identity.tenant && !admin.get();
  }
  function ensureAdmin(identity) {
    if (byTenant.get(identity.tenant)?.role!=='admin') fail('An Airport administrator is required.',403);
    if (signupMode==='open') throw Object.assign(new Error('People can sign up directly while registration is open.'),{status:409,code:'invitations_disabled'});
  }
  return {
    tenantForVerifiedEmail(email) {
      return byEmail.get(email)?.tenant || (email===bootstrapEmail ? bootstrapTenant : null);
    },
    emailSessionIsCurrent({tenant,email}) {
      const current=byTenant.get(tenant);
      return !current || current.email===email;
    },
    resolve(identity,hasLegacyTenant) {
      const row=byTenant.get(identity.tenant);
      if(row?.email===identity.email && (row.role==='admin' || !bootstrap(identity))) return publicAccount(row);
      if(!row && !hasLegacyTenant && !bootstrap(identity)) return null;
      return write(()=>{
        const current=byTenant.get(identity.tenant);
        checkEmail(identity);
        const grantAdmin=bootstrap(identity);
        if(current) {
          db.prepare('UPDATE users SET email=?,role=? WHERE tenant=?').run(identity.email,grantAdmin?'admin':current.role,identity.tenant);
        } else if(hasLegacyTenant || grantAdmin) {
          const name=Array.from(identity.email.split('@')[0]).slice(0,80).join('');
          insert.run(identity.tenant,randomUUID(),identity.email,name,grantAdmin?'admin':'member',now());
        }
        return publicAccount(byTenant.get(identity.tenant));
      });
    },
    signup(identity,displayName,token) {
      const name=profileName(displayName);
      if (token!==undefined && (typeof token!=='string'||!invitePattern.test(token))) inviteError('The invitation is invalid or no longer available.','invitation_invalid');
      return write(()=>{
        if(byTenant.get(identity.tenant))fail('This account has already been created.',409);
        checkEmail(identity);
        const at=now();
        let invite;
        if(token!==undefined) {
          invite=byToken.get(digest(token));
          if(!invite || invite.email!==identity.email || invitation(invite,at).status!=='pending') inviteError('The invitation is invalid or no longer available.','invitation_invalid');
        } else if(signupMode!=='open') inviteError('An invitation to this email address is required.','invitation_required');
        insert.run(identity.tenant,randomUUID(),identity.email,name,'member',at);
        if(invite)db.prepare('UPDATE customer_invitations SET accepted_at=?,accepted_by=? WHERE id=?').run(at,identity.tenant,invite.id);
        db.prepare('UPDATE customer_invitations SET revoked_at=? WHERE email=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?').run(at,identity.email,at);
        return publicAccount(byTenant.get(identity.tenant));
      });
    },
    profile(identity,displayName) {
      const name=profileName(displayName);
      return write(()=>{
        if(!byTenant.get(identity.tenant))fail('Create your Airport account first.',403);
        db.prepare('UPDATE users SET display_name=? WHERE tenant=?').run(name,identity.tenant);
        return publicAccount(byTenant.get(identity.tenant));
      });
    },
    listInvitations(identity) {
      ensureAdmin(identity);
      const at=now();
      return db.prepare('SELECT id,email,accepted_at,revoked_at,created_at,expires_at FROM customer_invitations ORDER BY created_at DESC, rowid DESC')
        .all().map(row=>invitation(row,at));
    },
    invite(identity,value) {
      return write(()=>{
        ensureAdmin(identity);
        const email=canonicalEmail(value);
        if(!email)fail('Enter the full email address for this invitation.');
        if(byEmail.get(email))fail('An Airport account already uses this email address.',409);
        const at=now(), id=randomUUID(), token='ainv_'+randomBytes(32).toString('base64url');
        db.prepare('UPDATE customer_invitations SET revoked_at=? WHERE email=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?').run(at,email,at);
        createInvite.run(id,email,digest(token),identity.tenant,at,at+inviteLifetime);
        return {invitation:invitation(byInvite.get(id),at),token};
      });
    },
    revoke(identity,id) {
      return write(()=>{
        ensureAdmin(identity);
        if(typeof id!=='string' || id.length>80)fail('Invalid invitation.');
        const row=byInvite.get(id),at=now();
        if(!row)fail('Invitation not found.',404);
        if(invitation(row,at).status==='pending') db.prepare('UPDATE customer_invitations SET revoked_at=? WHERE id=?').run(at,id);
        return invitation(byInvite.get(id),at);
      });
    },
    close(){db.close();}
  };
}
