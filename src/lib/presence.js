// Online/offline presence via Supabase Realtime's Presence feature - no
// extra table needed, purely ephemeral (a browser refresh or app close and
// you drop off automatically, exactly what "online/offline" should mean).
import { supabase } from './supabaseClient.js';

let channel = null;
let currentState = {};
const listeners = new Set();

function notify() {
  listeners.forEach((cb) => { try { cb(currentState); } catch (e) {} });
}

export function startPresence(uid, meta) {
  if (channel) return;
  channel = supabase.channel('presence:blue-kite-ops', { config: { presence: { key: uid } } });
  channel
    .on('presence', { event: 'sync' }, () => {
      currentState = channel.presenceState();
      notify();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track(Object.assign({ online_at: new Date().toISOString() }, meta || {}));
      }
    });
}

export function stopPresence() {
  if (channel) { supabase.removeChannel(channel); channel = null; }
  currentState = {};
}

// Returns { [userId]: true/false } snapshot of who's currently online.
export function isOnline(uid) {
  return !!(currentState && currentState[uid] && currentState[uid].length);
}

export function onPresenceChange(cb) {
  listeners.add(cb);
  cb(currentState);
  return () => listeners.delete(cb);
}
