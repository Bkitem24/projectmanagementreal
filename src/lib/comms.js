// Client Communications - thin data-access layer over the existing db.js
// shim, following the same conventions as the rest of the app.
import { db } from './db.js';
import { supabase } from './supabaseClient.js';
import { randomId } from './db.js';

const GMAIL_WORKER_URL = (import.meta.env.VITE_COMMS_GMAIL_WORKER_URL || '').replace(/\/$/, '');
const WHATSAPP_WORKER_URL = (import.meta.env.VITE_COMMS_WHATSAPP_WORKER_URL || '').replace(/\/$/, '');

async function authedFetch(workerUrl, path, body) {
  const { data } = await supabase.auth.getSession();
  const token = data && data.session && data.session.access_token;
  const res = await fetch(workerUrl + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && json.error && JSON.stringify(json.error)) || ('Send failed (' + res.status + ')'));
  return json;
}

export async function listMyAccounts() {
  const snap = await db.collection('commsAccounts').where('active', '==', true).get();
  return snap.docs.map((d) => d.data());
}

export async function listThreads(accountId) {
  const snap = await db.collection('commsThreads').where('accountId', '==', accountId).orderBy('lastMessageAt', 'desc').get();
  return snap.docs.map((d) => d.data());
}

export async function listMessages(threadId) {
  const snap = await db.collection('commsMessages').where('threadId', '==', threadId).orderBy('sentAt', 'asc').get();
  return snap.docs.map((d) => d.data());
}

export async function getContact(contactId) {
  const snap = await db.doc('commsContacts/' + contactId).get();
  return snap.exists ? snap.data() : null;
}

// Actually SENDS through the real channel (via the matching Worker's own
// /send, which itself writes the sent message once delivery succeeds - see
// worker-comms-gmail/worker-comms-whatsapp's /send handlers) rather than
// just writing a local row. A message that failed to send is never
// recorded as if it had.
export async function sendReply(threadId, body, myUid) {
  const threadSnap = await db.doc('commsThreads/' + threadId).get();
  if (!threadSnap.exists) throw new Error('Conversation not found');
  const thread = threadSnap.data();
  const accountSnap = await db.doc('commsAccounts/' + thread.accountId).get();
  if (!accountSnap.exists) throw new Error('Account not found');
  const account = accountSnap.data();
  const contact = await getContact(thread.contactId);
  if (!contact) throw new Error('Contact not found');

  if (account.channel === 'gmail') {
    if (!GMAIL_WORKER_URL) throw new Error('VITE_COMMS_GMAIL_WORKER_URL is not set - see .env.example');
    const priorMessages = await listMessages(threadId);
    const lastInbound = priorMessages.slice().reverse().find((m) => m.direction === 'inbound');
    return authedFetch(GMAIL_WORKER_URL, '/send', {
      accountId: account.id,
      threadId,
      to: contact.externalAddress,
      subject: thread.subject ? 'Re: ' + thread.subject.replace(/^Re:\s*/i, '') : 'Re:',
      body,
      inReplyTo: lastInbound ? lastInbound.externalMessageId : null,
    });
  }
  if (account.channel === 'whatsapp') {
    if (!WHATSAPP_WORKER_URL) throw new Error('VITE_COMMS_WHATSAPP_WORKER_URL is not set - see .env.example');
    return authedFetch(WHATSAPP_WORKER_URL, '/send', { threadId, to: contact.externalAddress, body });
  }
  if (account.channel === 'slack') {
    // Goes through Rust (src-tauri/src/slack.rs), not a Worker - the
    // session lives only on this machine. Not yet wired end-to-end (see
    // docs/phase-3-punch-list.md - the cookie-capture fix needs a live
    // re-verification, and commsContacts.externalAddress for Slack still
    // needs to resolve to a DM channel id, not just a user id).
    throw new Error('Slack sending is not wired up yet - see the punch list for what\'s left.');
  }
  throw new Error('Unknown channel: ' + account.channel);
}

// Whether the current user has ANY comms access at all (admin, or at least
// one grant) - used to decide whether to show the sidebar nav item at all.
// Admin/manager get it unconditionally elsewhere (main.js checks
// isAdmin()/canManage() directly, cheap and synchronous); this only needs
// to cover the "admin granted a specific employee" case (2026-09-25).
export async function hasAnyCommsGrant(myUid) {
  if (!myUid) return false;
  const snap = await db.collection('commsAccountGrants').where('userId', '==', myUid).limit(1).get();
  return !snap.empty;
}

// ---- Admin: accounts + grants ----

export async function listAllAccounts() {
  const snap = await db.collection('commsAccounts').get();
  return snap.docs.map((d) => d.data());
}

export async function createAccount({ channel, externalId, label, teamId, myUid }) {
  const row = {
    id: 'cacc_' + randomId().slice(0, 8),
    channel,
    externalId,
    label,
    teamId: teamId || null,
    connectedBy: myUid,
    connectedAt: new Date().toISOString(),
    active: true,
  };
  const { error } = await supabase.from('commsAccounts').insert(row);
  if (error) throw error;
  return row;
}

export async function listGrantsForAccount(accountId) {
  const snap = await db.collection('commsAccountGrants').where('accountId', '==', accountId).get();
  return snap.docs.map((d) => d.data());
}

export async function grantAccess(accountId, userId, myUid) {
  const row = {
    id: 'cgrant_' + randomId().slice(0, 8),
    accountId,
    userId,
    grantedBy: myUid,
    grantedAt: new Date().toISOString(),
  };
  const { error } = await supabase.from('commsAccountGrants').insert(row);
  if (error) throw error;
  return row;
}

export async function revokeAccess(grantId) {
  const { error } = await supabase.from('commsAccountGrants').delete().eq('id', grantId);
  if (error) throw error;
}
