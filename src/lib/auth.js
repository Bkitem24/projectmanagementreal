import { supabase } from './supabaseClient.js';

// inviteCode is required for everyone except the very first account ever
// created on a fresh project (see the handle_new_user() bootstrap logic in
// supabase/schema_v2.sql) — the server enforces this regardless of what the
// UI does, so an invalid/missing code here surfaces as a normal signUp
// error rather than silently doing the wrong thing.
export async function signUp(email, password, displayName, inviteCode) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName || email, invite_code: inviteCode || '' } },
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// Changing your own email/password, for the "Edit profile" modal in
// main.js. Email changes go through Supabase Auth's own confirmation flow
// (it emails both the old and new address before the change actually takes
// effect) — that's Supabase's behavior, not something this app controls, so
// the UI just tells the person to check their inbox.
export async function updateEmail(newEmail) {
  const { error } = await supabase.auth.updateUser({ email: newEmail });
  if (error) throw error;
}

export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthStateChange(cb) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}

// Resolves a batch of profile rows by id, mirroring the small subset of the
// original artifact's `user.profiles(ids)` call that main.js relies on.
// Returns { [id]: { id, name, initial, color } }.
const PALETTE = ['#c9862e', '#3f6b8a', '#7a5ea8', '#4f8f6b', '#b8567a', '#a15c2f', '#55606e'];
function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export async function fetchProfiles(ids) {
  const unique = Array.from(new Set(ids)).filter(Boolean);
  const out = {};
  if (!unique.length) return out;
  const { data, error } = await supabase.from('profiles').select('id, displayName, email, avatarUrl').in('id', unique);
  if (error) throw error;
  const byId = {};
  (data || []).forEach((row) => { byId[row.id] = row; });
  unique.forEach((id) => {
    const row = byId[id];
    const name = (row && (row.displayName || row.email)) || '';
    out[id] = {
      id,
      name,
      initial: name ? name.trim()[0].toUpperCase() : '?',
      color: colorFor(id),
      avatarUrl: (row && row.avatarUrl) || '',
    };
  });
  return out;
}
