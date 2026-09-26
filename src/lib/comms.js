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

// Real pages, embedded in the main window (2026-09-26 follow-up, replaces
// this round's earlier separate-window attempt - see
// src-tauri/src/embedded_webview.rs's own comment for why). The IMAP-poll/
// three-pane reader above (listThreads/listMessages/sendReply's gmail
// branch, and Slack's cookie/token dance in src-tauri/src/slack.rs) is the
// original build for Gmail/Slack - kept working, not removed - but Humayun
// asked for the actual real web app for all three channels instead of a
// custom rebuild of one.
export const EMBED_URL = {
  gmail: 'https://mail.google.com/',
  whatsapp: 'https://web.whatsapp.com/',
  slack: 'https://app.slack.com/',
};

// WhatsApp only: filters the real page's own chat list down to contacts
// actually connected to this account - the same privacy rule every other
// channel already applies, just enforced by hiding chat rows instead of by
// never storing them (there's nothing to store here - the real page is
// only ever displayed, never scraped into commsMessages). Gmail and Slack
// get no filter - a full, real inbox/workspace is the point for those.
// Written defensively: if WhatsApp's own markup doesn't match
// ROW_SELECTOR, or no allow-list is configured, every chat stays visible
// rather than the filter hiding everything (fails open, never closed).
export async function buildWhatsAppFilterScript() {
  const snap = await db.collection('commsContacts').where('channel', '==', 'whatsapp').get();
  const identifiers = [];
  snap.docs.forEach((d) => {
    const c = d.data();
    if (c.externalAddress) identifiers.push(c.externalAddress);
    if (c.name) identifiers.push(c.name);
  });
  if (!identifiers.length) return null;
  return `(function () {
    var ALLOWED = ${JSON.stringify(identifiers)}.map(function (s) { return String(s).toLowerCase(); }).filter(Boolean);
    var ROW_SELECTOR = '[data-testid="cell-frame-container"]';
    function applyFilter() {
      var rows = document.querySelectorAll(ROW_SELECTOR);
      if (!rows.length) return false;
      rows.forEach(function (row) {
        var text = (row.textContent || '').toLowerCase();
        var match = ALLOWED.some(function (needle) { return text.indexOf(needle) !== -1; });
        var item = row.closest('[role="listitem"]') || row;
        item.style.display = match ? '' : 'none';
      });
      return true;
    }
    var tries = 0;
    var poll = setInterval(function () {
      tries++;
      if (applyFilter() || tries > 40) clearInterval(poll);
    }, 500);
    var pane = document.getElementById('pane-side') || document.body;
    new MutationObserver(function () { applyFilter(); }).observe(pane, { childList: true, subtree: true });
  })();`;
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
