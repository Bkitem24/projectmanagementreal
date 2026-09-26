// Messaging (Phase B) - Instagram-DM-style. Conversation list (default
// Team chat + direct + custom group chats) -> message thread -> composer
// with attachments, quoted replies, and reactions. Real-time via
// subscribeToMessages (postgres_changes, same mechanism db.js's onSnapshot
// already wraps everywhere else) and a typing indicator via Presence.
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button.jsx';
import { Textarea } from '../components/ui/textarea.jsx';
import { ScrollArea } from '../components/ui/scroll-area.jsx';
import { db } from '../lib/db.js';
import * as messaging from '../lib/messaging.js';
import NewGroupChatDialog from './messaging/NewGroupChatDialog.jsx';

const EMOJI_CHOICES = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export default function MessagingPage({ myUid, myTeamId, canManage }) {
  const [conversations, setConversations] = useState(null);
  const [profilesById, setProfilesById] = useState({});
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [body, setBody] = useState('');
  const [quoted, setQuoted] = useState(null);
  const [typingUsers, setTypingUsers] = useState([]);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  const typingRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  function refreshConversations() {
    messaging.listMyConversations(myUid).then(setConversations).catch((e) => setError(String(e)));
  }
  useEffect(refreshConversations, [myUid]);

  useEffect(() => {
    if (!myTeamId) return;
    db.collection('profiles').where('teamId', '==', myTeamId).get()
      .then((snap) => {
        const map = {};
        snap.docs.forEach((d) => { const p = d.data(); map[p.id] = p; });
        setProfilesById(map);
      })
      .catch(() => {});
  }, [myTeamId]);

  useEffect(() => {
    if (!selected) { setMessages([]); setParticipants([]); return; }
    let unsub = null;
    messaging.listMessages(selected.id).then(setMessages).catch((e) => setError(String(e)));
    messaging.listParticipants(selected.id).then(setParticipants).catch((e) => setError(String(e)));
    unsub = messaging.subscribeToMessages(selected.id, setMessages);
    typingRef.current = messaging.startTypingIndicator(selected.id, myUid, setTypingUsers);
    return () => { if (unsub) unsub(); if (typingRef.current) typingRef.current.stop(); };
  }, [selected, myUid]);

  useEffect(() => {
    if (!messages.length) { setReactions([]); return; }
    messaging.listReactions(messages.map((m) => m.id)).then(setReactions).catch(() => {});
  }, [messages]);

  useEffect(() => {
    if (!selected || !messages.length) return;
    const lastMsg = messages[messages.length - 1];
    const mine = participants.find((p) => p.userId === myUid);
    if (mine && mine.lastReadMessageId !== lastMsg.id) {
      messaging.markRead(selected.id, myUid, lastMsg.id).catch(() => {});
    }
  }, [selected, messages, participants, myUid]);

  function handleBodyChange(e) {
    setBody(e.target.value);
    if (typingRef.current) {
      typingRef.current.setTyping(true);
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => typingRef.current && typingRef.current.setTyping(false), 3000);
    }
  }

  function handleSend(file) {
    if (!selected || (!body.trim() && !file)) return;
    messaging.sendMessage({ conversationId: selected.id, senderId: myUid, body: body.trim(), file, quotedMessageId: quoted ? quoted.id : null })
      .then(() => { setBody(''); setQuoted(null); refreshConversations(); })
      .catch((e) => setError(String(e)));
  }

  function handleFilePick(e) {
    const file = e.target.files && e.target.files[0];
    if (file) handleSend(file);
    e.target.value = '';
  }

  function nameFor(uid) {
    const p = profilesById && profilesById[uid];
    return (p && (p.displayName || p.email)) || 'Someone';
  }

  if (conversations === null && !error) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex h-[calc(100vh-1px)] text-sm">
      <div className="w-64 border-r border-border flex flex-col">
        <div className="p-3 flex items-center justify-between border-b border-border">
          <h2 className="font-semibold">Chats</h2>
          {canManage && (
            <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setGroupDialogOpen(true)}>+ Group</Button>
          )}
        </div>
        <ScrollArea className="flex-1">
          {conversations && conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelected(c)}
              className={'w-full text-left px-3 py-2 border-b border-border hover:bg-muted transition-colors ' + (selected && selected.id === c.id ? 'bg-muted' : '')}
            >
              <div className="font-medium truncate">
                {c.kind === 'team_default' ? 'Team chat' : (c.name || 'Direct message')}
              </div>
              <div className="text-xs text-muted-foreground">{new Date(c.lastMessageAt).toLocaleString()}</div>
            </button>
          ))}
          {conversations && conversations.length === 0 && <div className="p-3 text-xs text-muted-foreground">No conversations yet.</div>}
        </ScrollArea>
      </div>

      <div className="flex-1 flex flex-col">
        {!selected && <div className="flex-1 flex items-center justify-center text-muted-foreground">Select a chat</div>}
        {selected && (
          <React.Fragment>
            <div className="p-3 border-b border-border font-semibold">
              {selected.kind === 'team_default' ? 'Team chat' : (selected.name || 'Direct message')}
            </div>
            <ScrollArea className="flex-1 p-4 space-y-3">
              {messages.map((m) => {
                const mine = m.senderId === myUid;
                const myReactions = reactions.filter((r) => r.messageId === m.id);
                const quotedMsg = m.quotedMessageId ? messages.find((mm) => mm.id === m.quotedMessageId) : null;
                return (
                  <div key={m.id} className={'max-w-[70%] group ' + (mine ? 'ml-auto' : '')}>
                    {!mine && <div className="text-xs text-muted-foreground mb-1">{nameFor(m.senderId)}</div>}
                    {m.quotedMessageId && (
                      <div className="text-xs bg-muted/60 border-l-2 border-[var(--blue)] px-2 py-1 mb-1 rounded truncate">
                        {quotedMsg ? quotedMsg.body || '(attachment)' : 'Message no longer available'}
                      </div>
                    )}
                    <div className={'rounded-lg px-3 py-2 ' + (mine ? 'bg-[var(--blue)] text-white' : 'bg-muted')}>
                      {m.attachmentKey && m.attachmentType === 'image' && (
                        <img src={messaging.fileUrl(m.attachmentKey)} alt="" className="max-w-full rounded mb-1" />
                      )}
                      {m.attachmentKey && m.attachmentType === 'voice' && (
                        <audio controls src={messaging.fileUrl(m.attachmentKey)} className="mb-1" />
                      )}
                      {m.attachmentKey && m.attachmentType === 'file' && (
                        <a href={messaging.fileUrl(m.attachmentKey)} target="_blank" rel="noreferrer" className="underline block mb-1">Download attachment</a>
                      )}
                      {m.body && <div className="whitespace-pre-wrap">{m.body}</div>}
                    </div>
                    <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="text-xs text-muted-foreground" onClick={() => setQuoted(m)}>Reply</button>
                      {EMOJI_CHOICES.map((em) => (
                        <button key={em} className="text-xs" onClick={() => messaging.toggleReaction(m.id, myUid, em).then(() => messaging.listReactions(messages.map((mm) => mm.id)).then(setReactions))}>{em}</button>
                      ))}
                    </div>
                    {myReactions.length > 0 && (
                      <div className="text-xs mt-0.5">{myReactions.map((r) => r.emoji).join(' ')}</div>
                    )}
                  </div>
                );
              })}
            </ScrollArea>
            {typingUsers.length > 0 && (
              <div className="px-4 text-xs text-muted-foreground italic">{typingUsers.map(nameFor).join(', ')} typing…</div>
            )}
            {quoted && (
              <div className="px-4 py-1 text-xs bg-muted/60 flex items-center justify-between">
                <span className="truncate">Replying to: {quoted.body || '(attachment)'}</span>
                <button onClick={() => setQuoted(null)} className="ml-2 text-muted-foreground">✕</button>
              </div>
            )}
            <div className="border-t border-border p-3 flex gap-2 items-end">
              <input ref={fileInputRef} type="file" className="hidden" onChange={handleFilePick} />
              <Button variant="outline" className="h-9" onClick={() => fileInputRef.current && fileInputRef.current.click()}>📎</Button>
              <Textarea
                value={body}
                onChange={handleBodyChange}
                placeholder="Message…"
                className="flex-1 min-h-[44px] max-h-32"
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              />
              <Button className="bg-[var(--blue)] hover:opacity-90" disabled={!body.trim()} onClick={() => handleSend()}>Send</Button>
            </div>
          </React.Fragment>
        )}
      </div>

      <NewGroupChatDialog
        open={groupDialogOpen}
        onOpenChange={setGroupDialogOpen}
        myUid={myUid}
        myTeamId={myTeamId}
        onCreated={() => refreshConversations()}
      />

      {error && (
        <div className="fixed bottom-4 right-4 bg-destructive text-white text-xs px-3 py-2 rounded-md shadow-lg max-w-sm">{error}</div>
      )}
    </div>
  );
}
