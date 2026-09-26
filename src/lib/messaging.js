// Messaging (Phase B) - Instagram-DM-style: 1:1s, a default per-Team group
// chat (auto-created/auto-joined server-side, see schema_v36.sql), custom
// group chats (admin/manager create only), attachments via the existing
// R2 worker, reactions + quoted replies, seen receipts (one
// lastReadMessageId per participant, not a row per message - scales fine
// even for a large Team's default chat), and typing indicators via
// Supabase Presence (ephemeral, never written to a table - same pattern
// src/lib/presence.js already uses for online/offline).
import { db } from './db.js';
import { supabase } from './supabaseClient.js';
import { randomId } from './db.js';
import { uploadFile, fileUrl } from './r2.js';

export { fileUrl };

// PostgREST errors are plain objects (no .toString() override), so a bare
// String(e) renders "[object Object]" instead of the real reason - found
// live while testing (a real RLS rejection showed as this instead of its
// message). Every catch in the Messaging UI should use this, not String().
export function errMsg(e) {
  if (!e) return 'Unknown error';
  return e.message || e.error_description || e.error || JSON.stringify(e);
}

export async function listMyConversations(myUid) {
  const partSnap = await db.collection('messagingParticipants').where('userId', '==', myUid).get();
  const myParts = partSnap.docs.map((d) => d.data());
  const convIds = myParts.map((p) => p.conversationId);
  if (!convIds.length) return [];
  const convSnap = await db.collection('messagingConversations').where('id', 'in', convIds).orderBy('lastMessageAt', 'desc').get();
  const convs = convSnap.docs.map((d) => d.data());

  // Unread + last-message preview, in one extra query (not one per
  // conversation): fetch every message across all of these conversations
  // ordered newest-first, then keep the first (newest) row seen per
  // conversationId in JS - cheap at this app's real scale (a handful of
  // conversations, a small Team), avoids an N+1 query per row in the list.
  const msgSnap = await db.collection('messagingMessages').where('conversationId', 'in', convIds).orderBy('createdAt', 'desc').get();
  const latestByConv = {};
  msgSnap.docs.forEach((d) => {
    const m = d.data();
    if (!latestByConv[m.conversationId]) latestByConv[m.conversationId] = m;
  });
  const partByConv = {};
  myParts.forEach((p) => { partByConv[p.conversationId] = p; });

  return convs.map((c) => {
    const latest = latestByConv[c.id] || null;
    const myPart = partByConv[c.id];
    const unread = !!latest && latest.senderId !== myUid && (!myPart || myPart.lastReadMessageId !== latest.id);
    return Object.assign({}, c, { unread, latestMessage: latest });
  });
}

// Everyone on the Team (or, for admin - who has no Team of their own -
// everyone in the company) except yourself. Used for both "New group chat"
// and "New direct message" pickers.
export async function listOtherTeamMembers(myUid, myTeamId) {
  const query = myTeamId ? db.collection('profiles').where('teamId', '==', myTeamId) : db.collection('profiles');
  const snap = await query.get();
  return snap.docs.map((d) => d.data()).filter((p) => p.id !== myUid);
}

// Leave a group chat (removes only your own participant row - RLS only
// allows self-removal, schema_v39.sql). Never used for team_default (you
// can't opt out of your own Team's default chat) or direct (leaving a 1:1
// would just orphan the other person's view of it) - MessagingPage.jsx only
// ever shows the "Leave" action for kind='group'.
export async function leaveConversation(conversationId, myUid) {
  const snap = await db.collection('messagingParticipants').where('conversationId', '==', conversationId).where('userId', '==', myUid).get();
  if (snap.empty) return;
  const { error } = await supabase.from('messagingParticipants').delete().eq('id', snap.docs[0].id);
  if (error) throw error;
}

export async function deleteMessage(messageId) {
  const { error } = await supabase.from('messagingMessages').delete().eq('id', messageId);
  if (error) throw error;
}

// RLS only allows this for kind='group' conversations, by admin/manager -
// never the per-Team default chat or someone's 1:1 (schema_v38.sql).
// Participants/messages/reactions cascade-delete for free.
export async function deleteConversation(conversationId) {
  const { error } = await supabase.from('messagingConversations').delete().eq('id', conversationId);
  if (error) throw error;
}

export async function getMyParticipantRow(conversationId, myUid) {
  const snap = await db.collection('messagingParticipants').where('conversationId', '==', conversationId).where('userId', '==', myUid).get();
  return snap.docs.length ? snap.docs[0].data() : null;
}

export async function listParticipants(conversationId) {
  const snap = await db.collection('messagingParticipants').where('conversationId', '==', conversationId).get();
  return snap.docs.map((d) => d.data());
}

export async function listMessages(conversationId) {
  const snap = await db.collection('messagingMessages').where('conversationId', '==', conversationId).orderBy('createdAt', 'asc').get();
  return snap.docs.map((d) => d.data());
}

export function subscribeToMessages(conversationId, onChange) {
  return db.collection('messagingMessages').where('conversationId', '==', conversationId).onSnapshot((snap) => onChange(snap.docs.map((d) => d.data())));
}

export async function sendMessage({ conversationId, senderId, body, file, quotedMessageId }) {
  let attachmentKey = null, attachmentType = null;
  if (file) {
    attachmentKey = 'messaging/' + conversationId + '/' + randomId().slice(0, 8) + '-' + file.name;
    await uploadFile(file, attachmentKey);
    attachmentType = file.type.startsWith('image/') ? 'image' : (file.type.startsWith('audio/') ? 'voice' : 'file');
  }
  const row = {
    id: 'mmsg_' + randomId().slice(0, 8),
    conversationId,
    senderId,
    body: body || '',
    attachmentKey,
    attachmentType,
    quotedMessageId: quotedMessageId || null,
  };
  // createdAt is deliberately NOT set client-side - two people's clocks can
  // disagree, but Postgres's own now() (the column default) is a single
  // authoritative clock, which is what real ordering between two different
  // senders actually needs. .select().single() is safe here (unlike the
  // "insert for someone else" trap documented in CLAUDE.md) because the
  // sender is always a participant of their own conversation, so the
  // SELECT-policy re-check on the returned row passes.
  const { data, error } = await supabase.from('messagingMessages').insert(row).select().single();
  if (error) throw error;
  await supabase.from('messagingConversations').update({ lastMessageAt: data.createdAt }).eq('id', conversationId);
  return data;
}

export async function markRead(conversationId, userId, messageId) {
  await supabase.from('messagingParticipants').update({ lastReadMessageId: messageId }).eq('conversationId', conversationId).eq('userId', userId);
}

export async function toggleReaction(messageId, userId, emoji) {
  const existing = await db.collection('messagingReactions').where('messageId', '==', messageId).where('userId', '==', userId).where('emoji', '==', emoji).get();
  if (!existing.empty) {
    await supabase.from('messagingReactions').delete().eq('id', existing.docs[0].id);
    return;
  }
  const { error } = await supabase.from('messagingReactions').insert({ id: 'mreact_' + randomId().slice(0, 8), messageId, userId, emoji, createdAt: new Date().toISOString() });
  if (error) throw error;
}

export async function listReactions(messageIds) {
  if (!messageIds.length) return [];
  const snap = await db.collection('messagingReactions').where('messageId', 'in', messageIds).get();
  return snap.docs.map((d) => d.data());
}

export async function createGroupChat(name, participantUserIds, myUid, teamId) {
  const conversationId = 'mconv_' + randomId().slice(0, 8);
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('messagingConversations').insert({
    id: conversationId, teamId: teamId || null, kind: 'group', name, createdBy: myUid, createdAt: nowIso, lastMessageAt: nowIso,
  });
  if (error) throw error;
  const rows = Array.from(new Set(participantUserIds.concat([myUid]))).map((uid) => ({
    id: 'mpart_' + randomId().slice(0, 8), conversationId, userId: uid, joinedAt: nowIso,
  }));
  const { error: pErr } = await supabase.from('messagingParticipants').insert(rows);
  if (pErr) throw pErr;
  return conversationId;
}

// Reuses an existing direct conversation between exactly these two people
// if one already exists, rather than creating a duplicate every time.
export async function startDirectChat(otherUserId, myUid, teamId) {
  const mine = await db.collection('messagingParticipants').where('userId', '==', myUid).get();
  const myConvIds = mine.docs.map((d) => d.data().conversationId);
  if (myConvIds.length) {
    const theirs = await db.collection('messagingParticipants').where('userId', '==', otherUserId).where('conversationId', 'in', myConvIds).get();
    for (const d of theirs.docs) {
      const conv = await db.doc('messagingConversations/' + d.data().conversationId).get();
      if (conv.exists && conv.data().kind === 'direct') return conv.id;
    }
  }
  const conversationId = 'mconv_' + randomId().slice(0, 8);
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('messagingConversations').insert({
    id: conversationId, teamId: teamId || null, kind: 'direct', createdBy: myUid, createdAt: nowIso, lastMessageAt: nowIso,
  });
  if (error) throw error;
  const { error: pErr } = await supabase.from('messagingParticipants').insert([
    { id: 'mpart_' + randomId().slice(0, 8), conversationId, userId: myUid, joinedAt: nowIso },
    { id: 'mpart_' + randomId().slice(0, 8), conversationId, userId: otherUserId, joinedAt: nowIso },
  ]);
  if (pErr) throw pErr;
  return conversationId;
}

// Typing indicator - Presence only, never a table (see this file's own
// header comment). Returns { setTyping(bool), stop() }.
export function startTypingIndicator(conversationId, myUid, onChange) {
  const channel = supabase.channel('typing:' + conversationId, { config: { presence: { key: myUid } } });
  channel
    .on('presence', { event: 'sync' }, () => {
      onChange(Object.keys(channel.presenceState()).filter((k) => k !== myUid));
    })
    .subscribe();
  return {
    setTyping(isTyping) { if (isTyping) channel.track({ typing: true }); else channel.untrack(); },
    stop() { supabase.removeChannel(channel); },
  };
}
