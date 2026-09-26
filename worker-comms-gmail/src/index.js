// Client Communications - Gmail Worker (Phase A).
//
// The IMAP/SMTP protocol functions below (readUntil, imapReadSince,
// smtpSendMail) are adapted from spike-imap/src/index.js, which was
// verified live against a real Gmail/Workspace account on BOTH `wrangler
// dev` and `wrangler dev --remote` (Cloudflare's real network) - see
// docs/superpowers/specs/2026-09-25-phase-a-spike-results.md, Spike 3,
// PASS. Only the wiring changed here: reading since a stored UID instead
// of a fixed 30-day window, matching senders against commsContacts before
// storing anything (the privacy rule - nothing else is ever kept), and
// writing to Supabase instead of just returning JSON.
import { connect } from 'cloudflare:sockets';

const CRLF = '\r\n';

async function readUntil(reader, test, timeoutMs = 10000) {
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (!test(buf)) {
    if (Date.now() > deadline) throw new Error('timed out waiting for: ' + test.toString().slice(0, 80));
    const { value, done } = await reader.read();
    if (done) throw new Error('socket closed while waiting for response. Got so far: ' + buf.slice(-500));
    buf += decoder.decode(value, { stream: true });
  }
  return buf;
}

// ---- IMAP: fetch every message with UID greater than lastUid (or the last
// 30 days on a brand-new account with no lastUid yet) ----
async function imapReadSince(user, appPassword, lastUid) {
  const socket = connect('imap.gmail.com:993', { secureTransport: 'on' });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const enc = new TextEncoder();
  let tagN = 0;
  const nextTag = () => 'A' + ++tagN;

  async function cmd(line, tag) {
    await writer.write(enc.encode(`${tag} ${line}${CRLF}`));
    const resp = await readUntil(reader, (b) => b.includes(`${tag} OK`) || b.includes(`${tag} NO`) || b.includes(`${tag} BAD`));
    if (resp.includes(`${tag} NO`) || resp.includes(`${tag} BAD`)) throw new Error(`IMAP ${line.split(' ')[0]} failed: ${resp.slice(-300)}`);
    return resp;
  }

  try {
    await readUntil(reader, (b) => b.includes(CRLF)); // greeting
    await cmd(`LOGIN "${user}" "${appPassword}"`, nextTag());
    await cmd('SELECT INBOX', nextTag());

    let searchCmd;
    if (lastUid) {
      searchCmd = `UID SEARCH UID ${Number(lastUid) + 1}:*`;
    } else {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      searchCmd = `UID SEARCH SINCE ${since.getUTCDate()}-${months[since.getUTCMonth()]}-${since.getUTCFullYear()}`;
    }
    const searchResp = await cmd(searchCmd, nextTag());
    const searchLine = searchResp.split(CRLF).find((l) => l.startsWith('* SEARCH')) || '* SEARCH';
    // "UID x:*" always includes x itself even with nothing newer - drop it if it's the only hit and equals lastUid.
    let uids = searchLine.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean);
    if (lastUid) uids = uids.filter((u) => Number(u) > Number(lastUid));
    if (!uids.length) { await cmd('LOGOUT', nextTag()).catch(() => {}); return { messages: [] }; }

    const fetchResp = await cmd(`UID FETCH ${uids.join(',')} (ENVELOPE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)] BODY.PEEK[TEXT])`, nextTag());
    const messages = [];
    const fetchLines = fetchResp.split(/\r?\n(?=\* \d+ FETCH)/);
    for (const chunk of fetchLines) {
      const uidM = chunk.match(/UID (\d+)/);
      if (!uidM) continue;
      const subjM = chunk.match(/ENVELOPE \("[^"]*" (NIL|"((?:[^"\\]|\\.)*)")/);
      const fromM = chunk.match(/ENVELOPE[\s\S]*?\(\("([^"]*)" NIL "([^"]*)" "([^"]*)"\)\)/);
      const midM = chunk.match(/Message-ID:\s*(<[^>]+>)/i);
      // Very small, deliberately non-general body extraction - good enough
      // for plain-text mail; a real implementation would want a proper
      // MIME parser for HTML/multipart bodies.
      const bodyM = chunk.match(/BODY\[TEXT\][^\r\n]*\{?\d*\}?\r\n([\s\S]*?)(?:\r\n\)\r\n|\r\n\)$)/);
      messages.push({
        uid: uidM[1],
        subject: subjM ? (subjM[2] || '').replace(/\\(.)/g, '$1') : '',
        fromName: fromM ? fromM[1] : '',
        fromAddress: fromM ? `${fromM[2]}@${fromM[3]}`.toLowerCase() : '',
        messageId: midM ? midM[1] : null,
        body: bodyM ? bodyM[1].trim() : '',
      });
    }
    await cmd('LOGOUT', nextTag()).catch(() => {});
    return { messages };
  } finally {
    try { writer.releaseLock(); } catch (e) {}
    try { reader.releaseLock(); } catch (e) {}
    try { await socket.close(); } catch (e) {}
  }
}

// ---- SMTP: send a real reply to a real contact, threaded via In-Reply-To/References ----
async function smtpSendMail(user, appPassword, { to, subject, body, inReplyTo }) {
  const socket = connect('smtp.gmail.com:465', { secureTransport: 'on' });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const enc = new TextEncoder();

  async function expect(code) {
    const resp = await readUntil(reader, (b) => /\r\n$/.test(b) && /^\d{3}(?:[ -]|$)/m.test(b.split(CRLF).filter(Boolean).pop() || ''));
    const last = resp.trim().split(CRLF).pop() || '';
    if (!last.startsWith(String(code))) throw new Error(`SMTP expected ${code}, got: ${resp.slice(-300)}`);
    return resp;
  }
  async function send(line) { await writer.write(enc.encode(line + CRLF)); }

  try {
    await expect(220);
    await send('EHLO blue-kite-ops'); await expect(250);
    await send(`AUTH PLAIN ${btoa(`\0${user}\0${appPassword}`)}`); await expect(235);
    await send(`MAIL FROM:<${user}>`); await expect(250);
    await send(`RCPT TO:<${to}>`); await expect(250);
    await send('DATA'); await expect(354);

    const msgId = `<bko-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@blue-kite-ops.local>`;
    // Dot-stuff any line that starts with a literal "." (SMTP transparency rule).
    const stuffedBody = body.split(/\r?\n/).map((l) => (l.startsWith('.') ? '.' + l : l)).join(CRLF);
    const headers = [
      `From: ${user}`,
      `To: ${to}`,
      `Subject: ${subject || 'Re:'}`,
      `Message-ID: ${msgId}`,
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
      inReplyTo ? `References: ${inReplyTo}` : null,
      'Content-Type: text/plain; charset=utf-8',
      '',
      stuffedBody,
      '.',
    ].filter((l) => l !== null);
    await send(headers.join(CRLF));
    await expect(250);
    await send('QUIT');
    return { messageId: msgId };
  } finally {
    try { writer.releaseLock(); } catch (e) {}
    try { reader.releaseLock(); } catch (e) {}
    try { await socket.close(); } catch (e) {}
  }
}

// ---- Supabase (service role) - same sbFetch pattern as worker-r2 ----
// Verifies the caller is a real logged-in user AND that they're actually
// allowed to use this specific account (admin, or granted - reuses the
// same has_comms_access() SQL function the database's own RLS uses, called
// here with the CALLER's own JWT so auth.uid() resolves to them, not the
// service role). Without this, anyone who found this Worker's public URL
// could send arbitrary email from a connected account.
async function verifySenderAllowed(env, request, accountId) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return 'missing Authorization header';
  const res = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/has_comms_access', {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid: accountId }),
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

function appPasswordFor(env, accountId) {
  return env['GMAIL_APP_PASSWORD_' + accountId.toUpperCase()];
}

// Poll every active Gmail account: fetch new mail, match senders against
// commsContacts, store only matches - the privacy rule ("only messages from
// contacts attached to a client record are kept/shown, on ALL channels").
async function pollAccount(env, account) {
  const appPassword = appPasswordFor(env, account.id);
  if (!appPassword) return { skipped: 'no app-password secret set for this account' };

  const { messages } = await imapReadSince(account.externalId, appPassword, account.lastPolledUid);
  let stored = 0, highestUid = account.lastPolledUid ? Number(account.lastPolledUid) : 0;

  for (const msg of messages) {
    highestUid = Math.max(highestUid, Number(msg.uid));
    if (!msg.fromAddress) continue;
    const contacts = await sbJson(env, `/rest/v1/commsContacts?channel=eq.gmail&externalAddress=eq.${encodeURIComponent(msg.fromAddress)}&select=id,clientId`);
    if (!contacts || !contacts.length) continue; // not a known client contact - skip, never store

    const contact = contacts[0];
    let thread = (await sbJson(env, `/rest/v1/commsThreads?accountId=eq.${account.id}&contactId=eq.${contact.id}&select=id&limit=1`))[0];
    if (!thread) {
      const threadId = 'cthr_' + crypto.randomUUID().slice(0, 8);
      await sbFetch(env, '/rest/v1/commsThreads', {
        method: 'POST',
        body: JSON.stringify({ id: threadId, accountId: account.id, contactId: contact.id, subject: msg.subject, lastMessageAt: new Date().toISOString() }),
      });
      thread = { id: threadId };
    }

    // Upsert-ignore-duplicate via the unique (threadId, externalMessageId) index.
    const insertRes = await sbFetch(env, `/rest/v1/commsMessages?on_conflict=threadId,externalMessageId`, {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify({
        id: 'cmsg_' + crypto.randomUUID().slice(0, 8),
        threadId: thread.id,
        direction: 'inbound',
        body: msg.body,
        externalMessageId: msg.messageId,
        sentAt: new Date().toISOString(),
      }),
    });
    if (insertRes.ok) { stored++; await sbFetch(env, `/rest/v1/commsThreads?id=eq.${thread.id}`, { method: 'PATCH', body: JSON.stringify({ lastMessageAt: new Date().toISOString() }) }); }
  }

  if (highestUid > (account.lastPolledUid ? Number(account.lastPolledUid) : 0)) {
    await sbFetch(env, `/rest/v1/commsAccounts?id=eq.${account.id}`, { method: 'PATCH', body: JSON.stringify({ lastPolledUid: String(highestUid) }) });
  }
  return { fetched: messages.length, stored };
}

async function pollAll(env) {
  const accounts = await sbJson(env, `/rest/v1/commsAccounts?channel=eq.gmail&active=eq.true&select=*`);
  const results = {};
  for (const account of accounts) {
    try { results[account.label] = await pollAccount(env, account); }
    catch (err) { results[account.label] = { error: String(err) }; console.error('[comms-gmail] poll failed for', account.label, err); }
  }
  return results;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAll(env).then((r) => console.log('[comms-gmail] poll cycle', JSON.stringify(r))));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      // Manual poll trigger, for local/live testing (mirrors the spike's
      // approach - a real GET, not just "no error").
      if (url.pathname === '/poll') {
        return Response.json(await pollAll(env));
      }
      if (url.pathname === '/send' && request.method === 'POST') {
        const { accountId, threadId, to, subject, body, inReplyTo } = await request.json();
        const denied = await verifySenderAllowed(env, request, accountId);
        if (denied) return Response.json({ error: denied }, { status: 403 });
        const [account] = await sbJson(env, `/rest/v1/commsAccounts?id=eq.${accountId}&select=*`);
        if (!account) return Response.json({ error: 'unknown account' }, { status: 404 });
        const appPassword = appPasswordFor(env, accountId);
        if (!appPassword) return Response.json({ error: 'no app-password secret set for this account' }, { status: 400 });

        const result = await smtpSendMail(account.externalId, appPassword, { to, subject, body, inReplyTo });
        await sbFetch(env, '/rest/v1/commsMessages', {
          method: 'POST',
          body: JSON.stringify({
            id: 'cmsg_' + crypto.randomUUID().slice(0, 8),
            threadId,
            direction: 'outbound',
            body,
            externalMessageId: result.messageId,
            sentAt: new Date().toISOString(),
          }),
        });
        await sbFetch(env, `/rest/v1/commsThreads?id=eq.${threadId}`, { method: 'PATCH', body: JSON.stringify({ lastMessageAt: new Date().toISOString() }) });
        return Response.json(result);
      }
      return new Response('Client Comms Gmail Worker. POST /send {accountId,threadId,to,subject,body,inReplyTo}. GET /poll for a manual poll cycle.', { status: 200 });
    } catch (err) {
      return Response.json({ error: String((err && err.stack) || err) }, { status: 500 });
    }
  },
};
