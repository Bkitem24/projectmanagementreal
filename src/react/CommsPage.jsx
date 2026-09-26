// Client Communications - Phase A. Three-pane layout: connected accounts
// (Gmail/Slack/WhatsApp) -> threads for the selected account -> messages +
// reply box. Real data only, via src/lib/comms.js - no mock data. Mounted
// at #/comms by renderComms() in main.js, following the exact
// activeReactRoot lifecycle pattern proven in the Phase A spikes (unmounts
// on navigating away, so its data doesn't keep loading in the background).
//
// Slack and WhatsApp accounts may exist in commsAccounts (created by an
// admin ahead of time) but have no live channel wired up yet - see
// docs/superpowers/plans/2026-09-25-phase-a-foundation-and-comms.md's
// "Known blockers" section. Threads/messages for those show whatever's
// already in the database (nothing, until their Workers are built), not an
// error - this page doesn't know or care which channel is "live" vs
// "data-model-only", that's a Worker-side concern.
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button.jsx';
import { Textarea } from '../components/ui/textarea.jsx';
import { ScrollArea } from '../components/ui/scroll-area.jsx';
import * as comms from '../lib/comms.js';
import AccountsAdmin from './comms/AccountsAdmin.jsx';

const CHANNEL_LABEL = { gmail: 'Gmail', slack: 'Slack', whatsapp: 'WhatsApp' };

export default function CommsPage({ myUid, isAdmin }) {
  const [adminOpen, setAdminOpen] = useState(false);
  const [accounts, setAccounts] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [threads, setThreads] = useState([]);
  const [selectedThread, setSelectedThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [replyBody, setReplyBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [windowOpening, setWindowOpening] = useState(false);

  // Gmail and WhatsApp both open the real, live logged-in web page in its
  // own window rather than being rebuilt inside this page (Slack still
  // uses commsThreads/commsMessages below, pending its own live re-test).
  function handleOpenRealInbox(channel) {
    setWindowOpening(true);
    const open = channel === 'gmail' ? comms.openGmailWeb() : comms.openWhatsAppWeb();
    open.catch((e) => setError((e && e.message) || String(e))).finally(() => setWindowOpening(false));
  }

  useEffect(() => {
    if (adminOpen) return; // re-fetch when the admin screen closes, so a newly-created account shows up
    let cancelled = false;
    comms.listMyAccounts()
      .then((rows) => { if (!cancelled) setAccounts(rows); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [adminOpen]);

  useEffect(() => {
    if (!selectedAccount) { setThreads([]); return; }
    let cancelled = false;
    comms.listThreads(selectedAccount.id)
      .then((rows) => { if (!cancelled) setThreads(rows); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [selectedAccount]);

  useEffect(() => {
    if (!selectedThread) { setMessages([]); return; }
    let cancelled = false;
    comms.listMessages(selectedThread.id)
      .then((rows) => { if (!cancelled) setMessages(rows); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [selectedThread]);

  function handleSend() {
    if (!replyBody.trim() || !selectedThread) return;
    setSending(true);
    const threadId = selectedThread.id;
    // sendReply's return shape is whatever the channel's own Worker
    // responds with (Gmail/WhatsApp API results), not a message row - the
    // Worker already wrote the real row once the send actually succeeded,
    // so re-fetch rather than guess at its shape.
    comms.sendReply(threadId, replyBody.trim(), myUid)
      .then(() => comms.listMessages(threadId))
      .then((rows) => { setMessages(rows); setReplyBody(''); })
      .catch((e) => setError(String(e)))
      .finally(() => setSending(false));
  }

  if (adminOpen) {
    return <AccountsAdmin myUid={myUid} onClose={() => setAdminOpen(false)} />;
  }

  if (accounts === null && !error) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex h-[calc(100vh-1px)] text-sm">
      {/* Accounts */}
      <div className="w-56 border-r border-border flex flex-col">
        <div className="p-3 flex items-center justify-between border-b border-border">
          <h2 className="font-semibold">Accounts</h2>
          {isAdmin && (
            <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setAdminOpen(true)}>
              Manage
            </Button>
          )}
        </div>
        <ScrollArea className="flex-1">
          {accounts && accounts.length === 0 && (
            <div className="p-3 text-muted-foreground text-xs">
              {isAdmin ? 'No accounts connected yet - click Manage to add one.' : 'No accounts connected for you yet.'}
            </div>
          )}
          {accounts && accounts.map((acc) => (
            <button
              key={acc.id}
              onClick={() => { setSelectedAccount(acc); setSelectedThread(null); }}
              className={
                'w-full text-left px-3 py-2 border-b border-border hover:bg-muted transition-colors ' +
                (selectedAccount && selectedAccount.id === acc.id ? 'bg-muted' : '')
              }
            >
              <div className="text-xs uppercase tracking-wide text-muted-foreground">{CHANNEL_LABEL[acc.channel] || acc.channel}</div>
              <div className="truncate">{acc.label}</div>
            </button>
          ))}
        </ScrollArea>
      </div>

      {/* Threads */}
      <div className="w-72 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border font-semibold">Conversations</div>
        <ScrollArea className="flex-1">
          {!selectedAccount && <div className="p-3 text-muted-foreground text-xs">Pick an account on the left.</div>}
          {selectedAccount && selectedAccount.channel === 'whatsapp' && (
            <div className="p-3 text-xs text-muted-foreground">
              WhatsApp opens in its own window - real chats, filtered to your connected contacts.
            </div>
          )}
          {selectedAccount && selectedAccount.channel === 'gmail' && (
            <div className="p-3 text-xs text-muted-foreground">
              Gmail opens in its own window - your real, full inbox.
            </div>
          )}
          {selectedAccount && selectedAccount.channel !== 'whatsapp' && selectedAccount.channel !== 'gmail' && threads.length === 0 && <div className="p-3 text-muted-foreground text-xs">No conversations yet.</div>}
          {selectedAccount && selectedAccount.channel !== 'whatsapp' && selectedAccount.channel !== 'gmail' && threads.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedThread(t)}
              className={
                'w-full text-left px-3 py-2 border-b border-border hover:bg-muted transition-colors ' +
                (selectedThread && selectedThread.id === t.id ? 'bg-muted' : '')
              }
            >
              <div className="truncate font-medium">{t.subject || '(no subject)'}</div>
              <div className="text-xs text-muted-foreground">{new Date(t.lastMessageAt).toLocaleString()}</div>
            </button>
          ))}
        </ScrollArea>
      </div>

      {/* Messages */}
      <div className="flex-1 flex flex-col">
        {selectedAccount && (selectedAccount.channel === 'whatsapp' || selectedAccount.channel === 'gmail') && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <p className="text-muted-foreground text-sm max-w-xs text-center">
              {selectedAccount.channel === 'gmail'
                ? 'The real, full Gmail inbox, in its own window.'
                : 'Real WhatsApp Web, in its own window - filtered to only the contacts connected to this account.'}
            </p>
            <Button className="bg-[var(--blue)] hover:opacity-90" disabled={windowOpening} onClick={() => handleOpenRealInbox(selectedAccount.channel)}>
              {windowOpening ? 'Opening…' : 'Open ' + (selectedAccount.channel === 'gmail' ? 'Gmail' : 'WhatsApp')}
            </Button>
          </div>
        )}
        {(!selectedAccount || (selectedAccount.channel !== 'whatsapp' && selectedAccount.channel !== 'gmail')) && !selectedThread && (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">Select a conversation</div>
        )}
        {selectedAccount && selectedAccount.channel !== 'whatsapp' && selectedAccount.channel !== 'gmail' && selectedThread && (
          <React.Fragment>
            <ScrollArea className="flex-1 p-4 space-y-3">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={
                    'max-w-[70%] rounded-lg px-3 py-2 ' +
                    (m.direction === 'outbound' ? 'ml-auto bg-[var(--blue)] text-white' : 'bg-muted')
                  }
                >
                  <div className="whitespace-pre-wrap">{m.body}</div>
                  <div className={'text-[10px] mt-1 ' + (m.direction === 'outbound' ? 'text-white/70' : 'text-muted-foreground')}>
                    {new Date(m.sentAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </ScrollArea>
            <div className="border-t border-border p-3 flex gap-2 items-end">
              <Textarea
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                placeholder="Write a reply…"
                className="flex-1 min-h-[44px] max-h-32"
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              />
              <Button className="bg-[var(--blue)] hover:opacity-90" disabled={sending || !replyBody.trim()} onClick={handleSend}>
                Send
              </Button>
            </div>
          </React.Fragment>
        )}
      </div>

      {error && (
        <div className="fixed bottom-4 right-4 bg-destructive text-white text-xs px-3 py-2 rounded-md shadow-lg max-w-sm">
          {error}
        </div>
      )}
    </div>
  );
}
