// Start (or reuse) a 1:1 with anyone on the Team - unlike group chats, this
// is self-serve for everyone (matches schema_v36.sql's insert policy:
// kind = 'direct' needs no admin/manager check).
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.jsx';
import * as messaging from '../../lib/messaging.js';

export default function NewDirectChatDialog({ open, onOpenChange, myUid, myTeamId, onStarted }) {
  const [members, setMembers] = useState([]);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    if (!open) return;
    messaging.listOtherTeamMembers(myUid, myTeamId).then(setMembers).catch((e) => setError(messaging.errMsg(e)));
  }, [open, myUid, myTeamId]);

  function handlePick(otherUserId) {
    setBusyId(otherUserId);
    messaging.startDirectChat(otherUserId, myUid, myTeamId)
      .then((conversationId) => { onStarted(conversationId); onOpenChange(false); })
      .catch((e) => setError(messaging.errMsg(e)))
      .finally(() => setBusyId(null));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>New message</DialogTitle></DialogHeader>
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {members.map((p) => (
            <button
              key={p.id}
              disabled={busyId === p.id}
              onClick={() => handlePick(p.id)}
              className="w-full text-left px-3 py-2 rounded-md hover:bg-muted text-sm disabled:opacity-50"
            >
              {p.displayName || p.email}
            </button>
          ))}
          {members.length === 0 && !error && <div className="text-xs text-muted-foreground px-3 py-2">No one else to message yet.</div>}
          {error && <div className="text-xs text-destructive px-3 py-2">{error}</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
