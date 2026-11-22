import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCodeSender, createEmailAuth, mailbox, readEmailConfig, requestAddress } from './email-auth.mjs';

const empty = {headers:{}};
const reqWith = cookie => ({headers:{cookie:cookie.split(';')[0]}});
const statusIs = n => err => err.status===n;
function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'airport-email-auth-')), file=join(dir,'auth.sqlite3');
  let at=7200000, sent;
  const opts = {
    secret:Buffer.alloc(32,18),now:()=>at,
    sendCode:async message=>{sent=message;},
    verifiedIdentity:email=>({tenant:'test',email})
  };
  let auth=createEmailAuth(file,opts);
  t.after(()=>{auth.close();rmSync(dir,{recursive:true,force:true});});
  return {
    get auth(){return auth;},file,opts,
    restart(){auth.close();auth=createEmailAuth(file,opts);},
    advance(ms){at+=ms;},
    async start(email='owner@example.com',ip='127.0.0.1'){
      const {challengeId}=await auth.start(email,ip);
      return {challengeId,code:sent.code};
    }
  };
}

test('email sessions, one-use codes and revocation survive restarts; credentials are hashed at rest',async t=>{
  const f=setup(t);
  const {challengeId,code}=await f.start(' OWNER@Example.com ');
  assert.match(code,/^\d{8}$/);
  const db=new DatabaseSync(f.file,{readOnly:true});
  try {
    const row=db.prepare('SELECT * FROM challenges').get();
    assert.equal(row.email,'owner@example.com');
    assert.notEqual(row.id,challengeId);
    assert.notEqual(row.code_hash,code);
    assert.notEqual(row.ip_key,'127.0.0.1');
    const cookie=f.auth.verify(challengeId,code,empty);
    const fields=cookie.split('; ');
    for(const flag of ['Path=/','Secure','HttpOnly','SameSite=Lax','Max-Age=1209600']) assert(fields.includes(flag));
    assert(!fields.some(v=>v.startsWith('Domain=')));
    const request=reqWith(cookie);
    assert.notEqual(db.prepare('SELECT token_hash FROM sessions').get().token_hash,fields[0].split('=')[1]);
    f.restart();
    assert.throws(()=>f.auth.verify(challengeId,code,empty),statusIs(401));
    assert.equal(f.auth.read(request).email,'owner@example.com');
    assert.equal(f.auth.read({headers:{cookie:fields[0]+'; '+fields[0]}}),null);
    assert.match(f.auth.logout(request),/Max-Age=0/);
    f.restart();
    assert.equal(f.auth.read(request),null);
    f.advance(60_000);
    const second=await f.start();
    const next=reqWith(f.auth.verify(second.challengeId,second.code,empty));
    f.advance(14*24*3_600_000);
    assert.equal(f.auth.read(next),null);
  } finally {db.close();}
});

test('expires codes, bounds guessing and throttles recipients and sources independently',async t=>{
  const f=setup(t);
  const first=await f.start();
  const incorrect=first.code==='00000000'?'00000001':'00000000';
  for(let i=0;i<5;i++) assert.throws(()=>f.auth.verify(first.challengeId,incorrect,empty),statusIs(401));
  assert.throws(()=>f.auth.verify(first.challengeId,first.code,empty),statusIs(401));
  await assert.rejects(f.start('Owner@example.com','192.0.2.2'),statusIs(429));
  f.advance(60_000);
  const expired=await f.start();
  f.advance(600_000);
  assert.throws(()=>f.auth.verify(expired.challengeId,expired.code,empty),statusIs(401));
  for(let i=0;i<3;i++) {await f.start();f.advance(60_000);}
  await assert.rejects(f.start('owner@example.com','192.0.2.2'),statusIs(429));
  for(let i=0;i<25;i++) await f.start('user'+i+'@example.com');
  await assert.rejects(f.start('another@example.com'),statusIs(429));
  await f.start('another@example.com','192.0.2.2');
  f.advance(3_600_000);
  await f.start();
});

test('sends a code to a single mailbox using the configured Cloudflare sender',async ()=>{
  for(const value of ['Alice <a@example.com>','foo,bar@example.com','foo..z@example.com','foo@-bad.com','foo@a.com,b.com','foo@a.com\r\ncc:other@a.com']) assert.equal(mailbox(value),null);
  assert.equal(mailbox("alex.o'brien+airport@example.co.uk"),"alex.o'brien+airport@example.co.uk");
  const config={from:'signin@auth.example.com',account:'1'.repeat(32),token:'synthetic-key'};
  const email='member@example.com';
  let result={success:true,result:{delivered:[],queued:[email]}};
  const deliver=createCodeSender(config,async (url,opts)=>{
    assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/'+config.account+'/email/sending/send');
    assert.equal(opts.headers.authorization,'Bearer synthetic-key');
    assert.equal(opts.redirect,'error');
    const body=JSON.parse(opts.body);
    assert.equal(body.from,config.from);assert.equal(body.to,email);assert.match(body.text,/00001234/);
    return Response.json(result);
  });
  await deliver({email,code:'00001234'});
  result={success:true,result:{permanent_bounces:[email]}};
  await assert.rejects(deliver({email,code:'00001234'}),/delivery unavailable/);
  const request={socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-for':'192.0.2.1, 192.0.2.2'}};
  assert.equal(requestAddress(request,false),'127.0.0.1');
  assert.equal(requestAddress(request,true),'192.0.2.2');
});

test('the restricted email relay receives precisely the signed login template payload',async ()=>{
  const secret=Buffer.alloc(32,29).toString('base64url');
  const endpoint='https://relay.example.com/sign-in';
  const config=readEmailConfig({AIRPORT_EMAIL_RELAY_URL:endpoint,AIRPORT_EMAIL_RELAY_SECRET:secret});
  assert.throws(()=>readEmailConfig({AIRPORT_EMAIL_RELAY_URL:endpoint}),/AIRPORT_EMAIL_RELAY_SECRET/);
  assert.throws(()=>readEmailConfig({AIRPORT_EMAIL_RELAY_URL:'http://relay.example.com',AIRPORT_EMAIL_RELAY_SECRET:secret}),/AIRPORT_EMAIL_RELAY_URL/);
  let status=204;
  const send=createCodeSender(config,async (url,opts)=>{
    assert.equal(url,endpoint);
    assert.equal(opts.body,'{"email":"person@example.com","code":"01234567"}');
    const time=opts.headers['x-airport-timestamp'];
    assert.match(time,/^\d+$/);
    assert.equal(opts.headers['x-airport-signature'],createHmac('sha256',secret).update(time+'\n'+opts.body).digest('hex'));
    return new Response(null,{status});
  });
  const data={email:'person@example.com',code:'01234567',extra:'ignored'};
  await send(data);
  status=403;
  await assert.rejects(send(data),/delivery unavailable/);
});
