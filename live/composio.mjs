const api = 'https://backend.composio.dev/api/v3.1';
const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const states = new Set(['INITIALIZING', 'INITIATED', 'INACTIVE', 'ACTIVE', 'EXPIRED', 'FAILED', 'REVOKED', 'DISABLED']);

// Only application-authored messages are suitable for the owner's activity log.
export class ComposioError extends Error {}

function fail(message) {
  throw new ComposioError(message);
}

function checkOwner(owner) {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 255 || /[\r\n,]/.test(owner)) {
    fail('Invalid workspace owner.');
  }
}

function connectedId(value) {
  return typeof value === 'string' && /^ca_[\w-]{1,200}$/.test(value);
}

export function createComposio(apiKey, configId) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
    fail('Set the server-side Composio API key first.');
  }
  if (configId && !/^ac_[\w-]{1,200}$/.test(configId)) fail('Invalid Gmail auth config ID.');

  async function request(path, body) {
    let response;
    try {
      response = await fetch(api + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(15000)
      });
    } catch {
      fail('Composio could not be reached. Try again.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) fail('Composio denied this request. Check the project key and its permissions.');
      if (response.status === 429) fail('Composio is rate-limiting requests. Try again later.');
      fail('Composio could not complete the request (HTTP ' + response.status + ').');
    }
    try {
      return await response.json();
    } catch {
      fail('Composio returned an unreadable response.');
    }
  }

  async function accountStatus(owner, id) {
    checkOwner(owner);
    if (!connectedId(id)) fail('Invalid Gmail connection.');
    // Composio is deprecating the returned user_id. Verify ownership with the
    // server-side owner filter as well as the exact account and toolkit filters.
    const query = new URLSearchParams({ user_ids: owner, connected_account_ids: id, toolkit_slugs: 'gmail', limit: '1' });
    const result = await request('/connected_accounts?' + query);
    const account = result?.items?.[0];
    if (result?.items?.length !== 1 || account?.id !== id || account.toolkit?.slug !== 'gmail' ||
        (account.user_id !== undefined && account.user_id !== owner) ||
        (configId && account.auth_config?.id !== configId) || account.experimental?.account_type === 'SHARED') {
      fail('The Gmail connection could not be verified for this workspace.');
    }
    if (account.is_disabled || account.auth_config?.is_disabled) return 'DISABLED';
    if (!states.has(account.status)) fail('Composio returned an unknown connection state.');
    return account.status;
  }

  async function readGmail(owner, id, resource, fields) {
    const response = await request('/tools/execute/proxy', {
      user_id: owner, connected_account_id: id, method: 'GET', endpoint: gmail + resource,
      parameters: [{ type: 'query', name: 'fields', value: fields }]
    });
    if (response?.status === 401 || response?.status === 403) fail('Gmail denied the read. Reconnect with Gmail metadata access.');
    if (response?.status !== 200 || !response.data) fail('Gmail could not complete the read.');
    return response.data;
  }

  return {
    async start(owner, callbackURL) {
      checkOwner(owner);
      let callback;
      try { callback = new URL(callbackURL); } catch { fail('Invalid OAuth callback.'); }
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname);
      if (callback.username || callback.password || !(callback.protocol === 'https:' || (callback.protocol === 'http:' && local))) {
        fail('Invalid OAuth callback.');
      }
      const settings = { user_id: owner, toolkits: { enable: ['gmail'] }, multi_account: { enable: true } };
      if (configId) settings.auth_configs = { gmail: configId };
      const session = await request('/tool_router/session', settings);
      if (typeof session?.session_id !== 'string' || !/^trs_[\w-]{1,200}$/.test(session.session_id)) {
        fail('Composio returned an invalid session.');
      }
      const link = await request('/tool_router/session/' + session.session_id + '/link', {
        toolkit: 'gmail', callback_url: callback.href
      });
      let url;
      try { url = new URL(link?.redirect_url); } catch { fail('Composio returned an invalid sign-in link.'); }
      if (url.origin !== 'https://connect.composio.dev' || url.username || url.password || !connectedId(link.connected_account_id)) {
        fail('Composio returned an invalid sign-in link.');
      }
      return { connectionId: link.connected_account_id, url: url.href };
    },

    async verify(owner, id) {
      const status = await accountStatus(owner, id);
      if (status !== 'ACTIVE') return { active: false, status };
      const profile = await readGmail(owner, id, 'profile', 'emailAddress');
      if (typeof profile.emailAddress !== 'string' || profile.emailAddress.length > 254 ||
          !/^[^\s<>@]+@[^\s<>@]+$/.test(profile.emailAddress)) fail('Gmail returned an invalid account identity.');
      return { active: true, status, email: profile.emailAddress };
    },

    async counts(owner, id) {
      if (await accountStatus(owner, id) !== 'ACTIVE') fail('This Gmail connection is inactive. Reconnect it to continue.');
      const inbox = await readGmail(owner, id, 'labels/INBOX', 'messagesTotal,messagesUnread');
      const { messagesTotal: total, messagesUnread: unread } = inbox;
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(unread) || unread < 0 || unread > total) {
        fail('Gmail returned invalid inbox counts.');
      }
      return { total, unread };
    }
  };
}
