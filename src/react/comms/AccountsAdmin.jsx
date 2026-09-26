// Admin-only screen: connect a Client Comms account, and grant/revoke
// individual employees' access to it (2026-09-25 requirement - admin can
// grant an employee on top of the default admin/manager access, and can
// also withhold a specific account from a specific manager - see
// commsAccountGrants' comment in schema_v35.sql for why one grant table
// covers both cases). The app never sees or stores a real credential here
// (Gmail app password / Slack token / WhatsApp token) - those live only as
// Cloudflare Worker secrets, set by Humayun himself via `wrangler secret
// put`. This screen just records WHICH account exists and WHO can see it.
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button.jsx';
import { Input } from '../../components/ui/input.jsx';
import { ScrollArea } from '../../components/ui/scroll-area.jsx';
import * as comms from '../../lib/comms.js';
import { db } from '../../lib/db.js';

const CHANNELS = ['gmail', 'slack', 'whatsapp'];

export default function AccountsAdmin({ myUid, onClose }) {
  const [accounts, setAccounts] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [grantsByAccount, setGrantsByAccount] = useState({});
  const [channel, setChannel] = useState('gmail');
  const [externalId, setExternalId] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState(null);

  function refresh() {
    comms.listAllAccounts().then(setAccounts).catch((e) => setError(String(e)));
  }

  useEffect(() => {
    refresh();
    db.collection('profiles').get()
      .then((snap) => setProfiles(snap.docs.map((d) => d.data())))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!accounts) return;
    Promise.all(accounts.map((a) => comms.listGrantsForAccount(a.id).then((g) => [a.id, g])))
      .then((pairs) => setGrantsByAccount(Object.fromEntries(pairs)))
      .catch((e) => setError(String(e)));
  }, [accounts]);

  function handleCreate() {
    if (!externalId.trim() || !label.trim()) return;
    comms.createAccount({ channel, externalId: externalId.trim(), label: label.trim(), myUid })
      .then(() => { setExternalId(''); setLabel(''); refresh(); })
      .catch((e) => setError(String(e)));
  }

  function toggleGrant(accountId, userId, currentGrant) {
    const action = currentGrant ? comms.revokeAccess(currentGrant.id) : comms.grantAccess(accountId, userId, myUid);
    action.then(refresh).catch((e) => setError(String(e)));
  }

  return (
    <div className="fixed inset-0 bg-background z-50 flex flex-col">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <h1 className="text-lg font-semibold">Manage Client Comms accounts</h1>
        <Button variant="outline" onClick={onClose}>Close</Button>
      </div>

      <div className="p-4 border-b border-border flex gap-2 items-end flex-wrap">
        <select value={channel} onChange={(e) => setChannel(e.target.value)} className="h-9 px-2 rounded-md border border-input bg-background">
          {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <Input placeholder="Account id (email / workspace / phone number id)" value={externalId} onChange={(e) => setExternalId(e.target.value)} className="w-72" />
        <Input placeholder="Label shown in the sidebar" value={label} onChange={(e) => setLabel(e.target.value)} className="w-56" />
        <Button className="bg-[var(--blue)] hover:opacity-90" onClick={handleCreate}>Add account</Button>
      </div>
      <div className="px-4 pb-2 text-xs text-muted-foreground">
        This only records the account - connect its real credential as a Cloudflare Worker secret yourself (never typed into this app).
      </div>

      <ScrollArea className="flex-1 p-4">
        {accounts === null && <div className="text-sm text-muted-foreground">Loading…</div>}
        {accounts && accounts.length === 0 && <div className="text-sm text-muted-foreground">No accounts yet.</div>}
        {accounts && accounts.map((acc) => (
          <div key={acc.id} className="border border-border rounded-lg p-3 mb-3">
            <div className="font-medium">{acc.label} <span className="text-xs uppercase text-muted-foreground">({acc.channel})</span></div>
            <div className="text-xs text-muted-foreground">{acc.externalId}</div>
            <div className="text-xs text-muted-foreground mb-2">
              Worker secret name for this account:{' '}
              <code className="bg-muted px-1 rounded">
                {acc.channel === 'gmail' ? 'GMAIL_APP_PASSWORD_' + acc.id.toUpperCase() : 'id: ' + acc.id}
              </code>
            </div>
            <div className="text-xs font-semibold mb-1">Grant access to:</div>
            <div className="flex flex-wrap gap-2">
              {profiles.map((p) => {
                const grants = grantsByAccount[acc.id] || [];
                const g = grants.find((x) => x.userId === p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => toggleGrant(acc.id, p.id, g)}
                    className={'text-xs px-2 py-1 rounded-full border ' + (g ? 'bg-[var(--blue)] text-white border-transparent' : 'border-border')}
                  >
                    {p.displayName || p.email}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </ScrollArea>

      {error && (
        <div className="fixed bottom-4 right-4 bg-destructive text-white text-xs px-3 py-2 rounded-md shadow-lg max-w-sm">
          {error}
        </div>
      )}
    </div>
  );
}
