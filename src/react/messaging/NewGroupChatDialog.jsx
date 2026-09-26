// Admin/manager-only: create a custom group chat (2026-09-25 roadmap
// requirement - "custom group chats (admin/manager create only)"). RLS
// enforces this too (schema_v36.sql), this dialog just isn't shown to
// anyone else.
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.jsx';
import { Button } from '../../components/ui/button.jsx';
import { Input } from '../../components/ui/input.jsx';
import * as messaging from '../../lib/messaging.js';

export default function NewGroupChatDialog({ open, onOpenChange, myUid, myTeamId, onCreated }) {
  const [name, setName] = useState('');
  const [profiles, setProfiles] = useState([]);
  const [selected, setSelected] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    messaging.listOtherTeamMembers(myUid, myTeamId).then(setProfiles).catch((e) => setError(messaging.errMsg(e)));
  }, [open, myTeamId, myUid]);

  function toggle(id) { setSelected((prev) => Object.assign({}, prev, { [id]: !prev[id] })); }

  function handleCreate() {
    const participantIds = Object.keys(selected).filter((id) => selected[id]);
    if (!name.trim() || !participantIds.length) { setError('Pick a name and at least one person.'); return; }
    setBusy(true);
    messaging.createGroupChat(name.trim(), participantIds, myUid, myTeamId)
      .then((conversationId) => { onCreated(conversationId); onOpenChange(false); setName(''); setSelected({}); })
      .catch((e) => setError(messaging.errMsg(e)))
      .finally(() => setBusy(false));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>New group chat</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Group name" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="text-xs font-semibold">Add people:</div>
          <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto">
            {profiles.map((p) => (
              <button
                key={p.id}
                onClick={() => toggle(p.id)}
                className={'text-xs px-2 py-1 rounded-full border ' + (selected[p.id] ? 'bg-[var(--blue)] text-white border-transparent' : 'border-border')}
              >
                {p.displayName || p.email}
              </button>
            ))}
          </div>
          {error && <div className="text-xs text-destructive">{error}</div>}
          <Button className="bg-[var(--blue)] hover:opacity-90 w-full" disabled={busy} onClick={handleCreate}>Create</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
