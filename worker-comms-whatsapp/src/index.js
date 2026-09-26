// Client Communications - WhatsApp Worker (Phase A).
//
// The webhook verification handshake + event-shape parsing is copied from
// spike-wa/ (verified live - Meta's real handshake succeeded against a
// deployed copy of this same code, see docs/superpowers/specs/
// 2026-09-25-phase-a-spike-results.md, Spike 4). What's new here: matching
// senders against commsContacts (the privacy rule - unmatched senders are
// never stored, same as Gmail), writing to Supabase, and a /send endpoint
// using the Cloud API's own send-message call.
//
// See wrangler.toml for the real status: this number hasn't finished
// registering on Meta's side yet, so this Worker is built and ready but not
// yet provable end-to-end.

// Same real-auth check as worker-comms-gmail - see that Worker's own
// comment for why. /send needs a real accountId to check access for;
// WHATSAPP_ACCOUNT_ID (the one dedicated number this Worker manages) is
// the only account that could ever apply here.
async function verifySenderAllowed(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return 'missing Authorization header';
  const res = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/has_comms_access', {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid: env.WHATSAPP_ACCOUNT_ID }),
  });
  if (!res.ok) return `could not verify access (${res.status})`;
  const allowed = await res.json();
  return allowed === true ? null : 'not allowed to use this account';
}

function sbFetch(env, path, opts) {
  return fetch(env.SUPABASE_URL + path, Object.assign({}, opts, {
    headers: Object.assign({
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    }, (opts && opts.headers) || {}),
  }));
}
async function sbJson(env, path, opts) {
  const res = await sbFetch(env, path, opts);
  if (!res.ok) throw new Error(`Supabase ${path} -> ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Store one inbound message, matching the sender against commsContacts -
// silently skipped if there's no match (never store a message from an
// unknown number, on any channel).
async function storeInboundMessage(env, accountId, msg) {
  const from = msg.from; // E.164 without a leading '+', e.g. "923149231044"
  const contacts = await sbJson(env, `/rest/v1/commsContacts?channel=eq.whatsapp&externalAddress=eq.${encodeURIComponent(from)}&select=id`);
  if (!contacts || !contacts.length) return { skipped: 'sender not a known client contact' };
  const contact = contacts[0];

  let thread = (await sbJson(env, `/rest/v1/commsThreads?accountId=eq.${accountId}&contactId=eq.${contact.id}&select=id&limit=1`))[0];
  if (!thread) {
    const threadId = 'cthr_' + crypto.randomUUID().slice(0, 8);
    await sbFetch(env, '/rest/v1/commsThreads', {
      method: 'POST',
      body: JSON.stringify({ id: threadId, accountId, contactId: contact.id, subject: '', lastMessageAt: new Date().toISOString() }),
    });
    thread = { id: threadId };
  }

  // WhatsApp text messages carry the body at msg.text.body; other types
  // (image, audio, etc.) are recorded with a placeholder - this Worker
  // doesn't download/store media, matching the plan's text-first scope.
  const body = msg.type === 'text' ? (msg.text && msg.text.body) || '' : `[${msg.type} message - not downloaded]`;
  const insertRes = await sbFetch(env, `/rest/v1/commsMessages?on_conflict=threadId,externalMessageId`, {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({
      id: 'cmsg_' + crypto.randomUUID().slice(0, 8),
      threadId: thread.id,
      direction: 'inbound',
      body,
      externalMessageId: msg.id,
      sentAt: new Date(Number(msg.timestamp) * 1000).toISOString(),
    }),
  });
  if (insertRes.ok) {
    await sbFetch(env, `/rest/v1/commsThreads?id=eq.${thread.id}`, { method: 'PATCH', body: JSON.stringify({ lastMessageAt: new Date().toISOString() }) });
  }
  return { stored: insertRes.ok };
}

async function handleWebhookEvent(env, body) {
  const accountId = env.WHATSAPP_ACCOUNT_ID;
  const results = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const msg of value.messages || []) {
        try { results.push(await storeInboundMessage(env, accountId, msg)); }
        catch (err) { results.push({ error: String(err) }); console.error('[comms-whatsapp] failed to store message', err); }
      }
    }
  }
  return results;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/webhook') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === env.VERIFY_TOKEN) return new Response(challenge, { status: 200 });
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method === 'POST' && url.pathname === '/webhook') {
      let body;
      try { body = await request.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
      const results = await handleWebhookEvent(env, body).catch((e) => { console.error('[comms-whatsapp] webhook handling failed', e); return [{ error: String(e) }]; });
      console.log('[comms-whatsapp] webhook event', JSON.stringify(results));
      // Meta requires 200 within a few seconds regardless of internal outcome, or it retries/backs off.
      return new Response('EVENT_RECEIVED', { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === '/send') {
      try {
        const denied = await verifySenderAllowed(env, request);
        if (denied) return Response.json({ error: denied }, { status: 403 });
        const { threadId, to, body } = await request.json();
        const resp = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
        });
        const result = await resp.json();
        if (!resp.ok) return Response.json({ error: result }, { status: resp.status });

        const externalId = result.messages && result.messages[0] && result.messages[0].id;
        await sbFetch(env, '/rest/v1/commsMessages', {
          method: 'POST',
          body: JSON.stringify({
            id: 'cmsg_' + crypto.randomUUID().slice(0, 8),
            threadId,
            direction: 'outbound',
            body,
            externalMessageId: externalId,
            sentAt: new Date().toISOString(),
          }),
        });
        await sbFetch(env, `/rest/v1/commsThreads?id=eq.${threadId}`, { method: 'PATCH', body: JSON.stringify({ lastMessageAt: new Date().toISOString() }) });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: String((err && err.stack) || err) }, { status: 500 });
      }
    }

    return new Response('Client Comms WhatsApp Worker. GET/POST /webhook for Meta, POST /send {threadId,to,body}.', { status: 200 });
  },
};
