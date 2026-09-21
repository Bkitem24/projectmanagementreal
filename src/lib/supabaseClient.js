import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey || url.includes('YOUR-PROJECT-REF')) {
  // Surfaced in the UI by main.js - don't throw here, so the app can still
  // render a helpful "not configured" screen instead of a blank white page.
  console.warn('[blue-kite-ops] Supabase is not configured yet - copy .env.example to .env and fill in your project values.');
}

export const supabaseConfigured = !!(url && anonKey && !url.includes('YOUR-PROJECT-REF'));

export const supabase = supabaseConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;
