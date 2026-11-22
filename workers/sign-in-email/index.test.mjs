import assert from 'node:assert/strict';
import {createHmac, randomBytes} from 'node:crypto';
import test from 'node:test';
import worker from './index.mjs';

const secret = randomBytes(32).toString('base64url');
const payload = {email:'worker-test@example.com', code:'01234567'};

async function deliver(message, {skew=0, key=secret, fail=false}={}) {
  const body = JSON.stringify(message);
  const timestamp = String(Math.floor(Date.now()/1000)+skew);
  const headers = {
    'content-type':'application/json', 'x-airport-timestamp':timestamp,
    'x-airport-signature':createHmac('sha256',key).update(timestamp+'\n'+body).digest('hex')
  };
  const request = new Request('https://worker.test/sign-in',{method:'POST', headers, body});
  const emails = [];
  const response = await worker.fetch(request,{RELAY_SECRET:secret, EMAIL:{async send(email) {
    if (fail) throw Error('Unavailable');
    emails.push(email);
  }}});
  return {status:response.status, emails};
}

test('sends only the fixed sign-in template after verifying the gateway signature', async () => {
  const {status, emails} = await deliver(payload);
  assert.equal(status,204);
  assert.equal(emails.length,1);
  assert.equal(emails[0].to,payload.email);
  assert.equal(emails[0].from.email,'signin@auth.airport.so');
  assert.equal(emails[0].subject,'Your Airport sign-in code');
  assert.match(emails[0].text,/01234567/);
});

test('rejects invalid signatures, stale requests and invalid recipient or template fields',async () => {
  for (const [body,opts,expected] of [
    [payload,{key:'wrong'},401], [payload,{skew:-60},401],
    [{...payload,email:'a@example.com,b@example.com'},{},400],
    [{...payload,email:'a@example.com\r\nBcc: b@example.com'},{},400],
    [{...payload,subject:'arbitrary'},{},400], [{...payload,code:'<unsafe>'},{},400],
    [{...payload,code:'x'.repeat(2048)},{},413], [payload,{fail:true},502]
  ]) {
    const {status,emails} = await deliver(body,opts);
    assert.equal(status,expected);
    assert.equal(emails.length,0);
  }
});
