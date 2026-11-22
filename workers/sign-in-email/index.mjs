const encoder = new TextEncoder();
const maxBytes = 1024;
const maxClockSkew = 30;
const sender = 'signin@auth.airport.so';

function reply(status) {
  return new Response(null, {status, headers: {'cache-control':'no-store'}});
}

function validRecipient(email) {
  if (typeof email !== 'string' || email.length > 254) return false;
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  const atom = /^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+$/;
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  return local.length <= 64 && local.split('.').every(piece => atom.test(piece)) &&
    domain.includes('.') && domain.split('.').every(piece => label.test(piece));
}

async function readBody(request) {
  if (!request.body || Number(request.headers.get('content-length')) > maxBytes) return null;
  const bytes = new Uint8Array(maxBytes);
  const reader = request.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) return bytes.subarray(0, offset);
      if (offset + value.byteLength > maxBytes) {
        await reader.cancel();
        return null;
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/sign-in' || url.search) return reply(404);
    if (!env.RELAY_SECRET) return reply(503);
    const timestamp = request.headers.get('x-airport-timestamp') || '';
    const hex = request.headers.get('x-airport-signature') || '';
    if (!/^\d{10}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(hex) ||
        Math.abs(Math.floor(Date.now()/1000) - Number(timestamp)) > maxClockSkew) return reply(401);
    if (request.headers.get('content-type') !== 'application/json') return reply(415);

    const body = await readBody(request);
    if (!body) return reply(413);
    const prefix = encoder.encode(timestamp+'\n');
    const signedBytes = new Uint8Array(prefix.length + body.byteLength);
    signedBytes.set(prefix);
    signedBytes.set(body, prefix.length);
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.RELAY_SECRET),
      {name:'HMAC', hash:'SHA-256'}, false, ['verify']);
    const signature = Uint8Array.from(hex.match(/../g), byte => parseInt(byte,16));
    if (!await crypto.subtle.verify('HMAC', key, signature, signedBytes)) return reply(401);

    let message;
    try { message = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(body)); }
    catch { return reply(400); }
    if (!message || Object.keys(message).length !== 2 || !validRecipient(message.email) ||
        typeof message.code !== 'string' || !/^\d{8}$/.test(message.code)) return reply(400);

    const {email, code} = message;
    try {
      await env.EMAIL.send({
        to: email, from: {email:sender, name:'Airport'}, subject:'Your Airport sign-in code',
        text:`Your Airport sign-in code is ${code}. It expires in 10 minutes. Enter it in the Airport window where you requested it. If you didn’t request a code, you can ignore this email.`,
        html:`<p>Your Airport sign-in code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. Enter it in the Airport window where you requested it.</p><p>If you didn’t request a code, you can ignore this email.</p>`
      });
    } catch { return reply(502); }
    return reply(204);
  }
};
