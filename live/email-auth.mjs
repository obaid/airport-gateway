import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync } from 'node:fs';
import { isIP } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { canonicalEmail } from './accounts.mjs';
import { fail } from './store.mjs';

const minute = 60_000;
const hour = 60 * minute;
const sessionLifetime = 14 * 24 * hour;
const cookieName = '__Host-airport_session';
const cookieOptions = '; Path=/; Secure; HttpOnly; SameSite=Lax';
const opaque = () => randomBytes(32).toString('base64url');
const opaquePattern = /^[A-Za-z0-9_-]{43}$/;
const digest = value => createHash('sha256').update(value).digest('hex');

// Accept one mailbox. Punctuation that mail providers interpret as address lists,
// display names or header delimiters must never reach a delivery service.
export function mailbox(value) {
  const email = canonicalEmail(value);
  if (!email) return null;
  const [local, domain] = email.split('@');
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  return local.length <= 64 && /^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(local)
    && domain.split('.').every(part => label.test(part)) ? email : null;
}

export function readEmailConfig(env) {
  if (env.AIRPORT_EMAIL_RELAY_URL!==undefined || env.AIRPORT_EMAIL_RELAY_SECRET!==undefined) {
    let url;
    try {url=new URL(env.AIRPORT_EMAIL_RELAY_URL);} catch {}
    if (!url || url.protocol!=='https:' || url.username || url.password || url.search || url.hash)
      throw Error('Set AIRPORT_EMAIL_RELAY_URL to the HTTPS sign-in mail relay endpoint.');
    const relaySecret=env.AIRPORT_EMAIL_RELAY_SECRET || '';
    if (!opaquePattern.test(relaySecret) || Buffer.from(relaySecret,'base64url').toString('base64url')!==relaySecret)
      throw Error('Set AIRPORT_EMAIL_RELAY_SECRET to 32 random base64url-encoded bytes.');
    return {relayUrl:url.href,relaySecret};
  }
  const from = mailbox(env.AIRPORT_EMAIL_FROM);
  if (!from) throw Error('Set AIRPORT_EMAIL_FROM to an address on the verified sending domain.');
  const account = env.AIRPORT_EMAIL_ACCOUNT_ID || '';
  if (!/^[0-9a-f]{32}$/.test(account)) throw Error('Set AIRPORT_EMAIL_ACCOUNT_ID to the Cloudflare account ID.');
  const token = env.AIRPORT_EMAIL_API_TOKEN?.trim();
  if (!token || /\s/.test(token)) throw Error('Set AIRPORT_EMAIL_API_TOKEN to the scoped email sending credential.');
  return {from,account,token};
}

export function createCodeSender({from,account,token,relayUrl,relaySecret}, fetchImpl=fetch) {
  if (relayUrl) return async ({email,code}) => {
    const body=JSON.stringify({email,code});
    const timestamp=String(Math.floor(Date.now()/1000));
    const signature=createHmac('sha256',relaySecret).update(timestamp+'\n'+body).digest('hex');
    const response=await fetchImpl(relayUrl,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),body,
      headers:{'content-type':'application/json','x-airport-timestamp':timestamp,'x-airport-signature':signature}
    });
    if (response.status!==204) throw Error('Email delivery unavailable.');
  };
  const url = 'https://api.cloudflare.com/client/v4/accounts/'+account+'/email/sending/send';
  return async ({email,code}) => {
    const response = await fetchImpl(url,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
      headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({
        to:email,from,subject:'Your Airport sign-in code',
        text:'Your Airport sign-in code is '+code+'. It expires in 10 minutes. Enter it only in the Airport sign-in window where you requested it. If you did not request a code, you can ignore this email.',
        html:'<p>Your Airport sign-in code is <strong>'+code+'</strong>.</p><p>It expires in 10 minutes. Enter it only in the Airport sign-in window where you requested it.</p><p>If you did not request a code, you can ignore this email.</p>'
      })
    });
    if (!response.ok) throw Error('Email delivery unavailable.');
    const {success,result} = await response.json();
    const accepted = [result?.delivered,result?.queued].some(list=>Array.isArray(list) && list.includes(email));
    if (success!==true || !accepted) throw Error('Email delivery unavailable.');
  };
}

function sessionToken(req) {
  const parts = (req.headers.cookie || '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(cookieName+'='));
  if (parts.length !== 1) return null;
  const value = parts[0].slice(cookieName.length+1);
  return opaquePattern.test(value) ? value : null;
}

export function requestAddress(req, renderIngress) {
  if (renderIngress) {
    const forwarded = req.headers['x-forwarded-for']?.split(',').at(-1)?.trim();
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Only a successful verification produces a session. Both the challenge secret and
// the cookie are stored as digests. Code hashes are keyed to resist offline guessing.
export function createEmailAuth(file, {secret,sendCode,verifiedIdentity,now=Date.now}) {
  const stat = lstatSync(file,{throwIfNoEntry:false});
  if (stat && !stat.isFile()) throw Error('The Airport authentication database must be a regular file.');
  const db = new DatabaseSync(file);
  chmodSync(file,0o600);
  db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, ip_key TEXT NOT NULL,
      code_hash TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS challenges_created ON challenges(created_at);
    CREATE INDEX IF NOT EXISTS challenges_email ON challenges(email,created_at);
    CREATE INDEX IF NOT EXISTS challenges_ip ON challenges(ip_key,created_at);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, tenant TEXT NOT NULL, email TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  `);
  const mac = (scope,...parts) => createHmac('sha256',secret).update(JSON.stringify([scope,...parts])).digest('hex');
  const throttle = () => fail('Too many sign-in requests. Please try again later.',429);
  const invalidCode = () => fail('That code is incorrect or has expired. Check your latest email or request a new code.',401);
  function write(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {const result=fn();db.exec('COMMIT');return result;}
    catch (error) {db.exec('ROLLBACK');throw error;}
  }

  async function start(value, address) {
    const email = mailbox(value);
    if (!email) fail('Enter a valid email address.');
    const at = now(), ip = mac('address',address);
    const challengeId = opaque(), id = digest(challengeId);
    const code = String(randomInt(100_000_000)).padStart(8,'0');
    write(()=>{
      db.prepare('DELETE FROM challenges WHERE created_at<=?').run(at-hour);
      db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(at);
      const recipient = db.prepare('SELECT count(*) AS count, max(created_at) AS last FROM challenges WHERE email=?').get(email);
      if (recipient.count>=5 || (recipient.last!==null && recipient.last>at-minute)) throttle();
      if (db.prepare('SELECT count(*) AS count FROM challenges WHERE ip_key=?').get(ip).count>=30 ||
          db.prepare('SELECT count(*) AS count FROM challenges').get().count>=250) throttle();
      db.prepare('INSERT INTO challenges(id,email,ip_key,code_hash,created_at) VALUES(?,?,?,?,?)')
        .run(id,email,ip,mac('login-code',id,code),at);
    });
    try {
      await sendCode({email,code});
    } catch {
      db.prepare('UPDATE challenges SET code_hash=NULL WHERE id=?').run(id);
      fail('Airport could not deliver the sign-in code. Please try again shortly.',503);
    }
    return {challengeId};
  }

  function verify(challengeId, code, req) {
    if (typeof challengeId!=='string' || !opaquePattern.test(challengeId) || typeof code!=='string' || !/^\d{8}$/.test(code)) invalidCode();
    const id = digest(challengeId), at = now();
    const cookie = write(()=>{
      const record = db.prepare('SELECT * FROM challenges WHERE id=?').get(id);
      if (!record?.code_hash || record.created_at<=at-10*minute || record.attempts>=5) return null;
      if (!timingSafeEqual(Buffer.from(record.code_hash,'hex'),Buffer.from(mac('login-code',id,code),'hex'))) {
        db.prepare('UPDATE challenges SET attempts=attempts+1 WHERE id=?').run(id);
        return null;
      }
      const identity = verifiedIdentity(record.email);
      const token = opaque();
      const oldToken = sessionToken(req);
      if (oldToken) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(oldToken));
      db.prepare('UPDATE challenges SET code_hash=NULL WHERE email=?').run(record.email);
      db.prepare('INSERT INTO sessions(token_hash,tenant,email,expires_at) VALUES(?,?,?,?)')
        .run(digest(token),identity.tenant,identity.email,at+sessionLifetime);
      return cookieName+'='+token+cookieOptions+'; Max-Age='+sessionLifetime/1000;
    });
    if (!cookie) invalidCode();
    return cookie;
  }

  return {
    start,verify,
    read(req) {
      const token = sessionToken(req);
      if (!token) return null;
      const row = db.prepare('SELECT tenant,email FROM sessions WHERE token_hash=? AND expires_at>?').get(digest(token),now());
      return row || null;
    },
    logout(req) {
      const token = sessionToken(req);
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
      return cookieName+'='+cookieOptions+'; Max-Age=0';
    },
    close(){db.close();}
  };
}
