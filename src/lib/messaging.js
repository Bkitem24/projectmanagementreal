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

export async function listMyConversations(myUid) {
  const snap = await db.collection('messagingParticipants').where('userId', '==', myUid).get();
  const convIds = snap.docs.map((d) => d.data().conversationId);
  if (!convIds.length) return [];
  const convSnap = await db.collection('messagingConversations').where('id', 'in', convIds).orderBy('lastMessageAt', 'desc').get();
  return convSnap.docs.map((d) => d.data());
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
    createdAt: new Date().toISOString(),
  };
  const { error } = await supabase.from('messagingMessages').insert(row);
  if (error) throw error;
  await supabase.from('messagingConversations').update({ lastMessageAt: row.createdAt }).eq('id', conversationId);
  return row;
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
