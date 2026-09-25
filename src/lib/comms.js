// Client Communications - thin data-access layer over the existing db.js
// shim, following the same conventions as the rest of the app (see
// CLAUDE.md's own convention note on why sendReply below uses a bare
// supabase.from().insert() rather than db.doc().set() - inserting a
// message isn't "for someone else" the way that note warns about, but the
// same underlying PostgREST behavior applies: a plain insert with no
// .select() avoids re-checking the SELECT policy on the returned row).
import { db } from './db.js';
import { supabase } from './supabaseClient.js';
import { randomId } from './db.js';

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

export async function sendReply(threadId, body, myUid) {
  const row = {
    id: 'cm_' + randomId().slice(0, 8),
    threadId,
    direction: 'outbound',
    body,
    sentAt: new Date().toISOString(),
    sentBy: myUid,
    createdAt: new Date().toISOString(),
  };
  const { error } = await supabase.from('commsMessages').insert(row);
  if (error) throw error;
  await supabase.from('commsThreads').update({ lastMessageAt: row.sentAt }).eq('id', threadId);
  return row;
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
