// A thin shim over @supabase/supabase-js that mimics the small subset of a
// Firestore-style document-store API the app's view code was written
// against (db.collection(x).where().orderBy().limit().onSnapshot(), and
// db.doc(x).get()/set()/update()/onSnapshot()). This is what let the
// original artifact prototype's render functions carry over to this real
// backend with almost no changes - only this file and the boot sequence in
// main.js are backend-specific.
import { supabase } from './supabaseClient.js';

function randomId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function toSnapshot(row) {
  return { id: row.id, exists: true, data: () => row };
}

function applyFilters(q, filters) {
  filters.forEach((f) => {
    // Real, confirmed bug (2026-09-24): postgrest-js's .eq()/.neq() just
    // string-interpolate the value straight into the query
    // (`eq.${value}`) - .eq(field, null) sends the literal text "eq.null",
    // which PostgREST reads as comparing to the FOUR-CHARACTER STRING
    // "null", not SQL NULL. That matches nothing, ever, not even rows that
    // genuinely are null - confirmed by reading postgrest-js's own source,
    // which explicitly documents this for .neq() ("does not include rows
    // where column is NULL - use .is(column, null) instead") but the same
    // string-interpolation applies to .eq() too. Real-world impact: any
    // .where(field,'==',null) (e.g. inviting a host's whole team by
    // teamId, when the host has no team) silently matched zero rows -
    // reproduced live: an admin account with no team hosting an instant
    // meeting invited nobody at all, with no error anywhere.
    if (f.op === '==') q = f.value === null ? q.is(f.field, null) : q.eq(f.field, f.value);
    else if (f.op === '!=') q = f.value === null ? q.not(f.field, 'is', null) : q.neq(f.field, f.value);
    else if (f.op === '<') q = q.lt(f.field, f.value);
    else if (f.op === '<=') q = q.lte(f.field, f.value);
    else if (f.op === '>') q = q.gt(f.field, f.value);
    else if (f.op === '>=') q = q.gte(f.field, f.value);
    else if (f.op === 'in') q = q.in(f.field, f.value);
    // Array-column "does this row's array share any value with mine" -
    // added for multi-role tasks (tasks.roles, schema_v29.sql), e.g. My
    // Board finding tasks reachable via a secondary role.
    else if (f.op === 'overlaps') q = q.overlaps(f.field, f.value);
    else throw new Error('Unsupported filter operator: ' + f.op);
  });
  return q;
}

function buildCollection(table, filters, orderField, orderDir, limitN) {
  const self = {
    where(field, op, value) {
      return buildCollection(table, filters.concat([{ field, op, value }]), orderField, orderDir, limitN);
    },
    orderBy(field, dir) {
      return buildCollection(table, filters, field, dir || 'asc', limitN);
    },
    limit(n) {
      return buildCollection(table, filters, orderField, orderDir, n);
    },
    async get() {
      let q = supabase.from(table).select('*');
      q = applyFilters(q, filters);
      if (orderField) q = q.order(orderField, { ascending: orderDir !== 'desc' });
      if (limitN) q = q.limit(limitN);
      const { data, error } = await q;
      if (error) throw error;
      const rows = data || [];
      return { docs: rows.map(toSnapshot), size: rows.length, empty: rows.length === 0 };
    },
    onSnapshot(next, errCb) {
      let live = true;
      const emit = () => {
        self.get().then((snap) => { if (live) next(snap); }).catch((e) => { if (live && errCb) errCb(e); });
      };
      emit();
      const channel = supabase
        .channel('col_' + table + '_' + Math.random().toString(36).slice(2))
        .on('postgres_changes', { event: '*', schema: 'public', table }, emit)
        .subscribe();
      return () => { live = false; supabase.removeChannel(channel); };
    },
    async add(payload) {
      const id = payload.id || randomId();
      const row = Object.assign({}, payload, { id });
      const { data, error } = await supabase.from(table).insert(row).select().single();
      if (error) throw error;
      return { id: data.id };
    },
  };
  return self;
}

function docRef(table, id) {
  const self = {
    id,
    async get() {
      const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return { exists: !!data, data: () => data || undefined };
    },
    async set(payload) {
      const row = Object.assign({}, payload, { id });
      const { error } = await supabase.from(table).upsert(row, { onConflict: 'id' });
      if (error) throw error;
    },
    async update(payload) {
      const { error } = await supabase.from(table).update(payload).eq('id', id);
      if (error) throw error;
    },
    async delete() {
      const { error } = await supabase.from(table).delete().eq('id', id);
      if (error) throw error;
    },
    onSnapshot(next, errCb) {
      let live = true;
      const emit = () => {
        self.get().then((snap) => { if (live) next(snap); }).catch((e) => { if (live && errCb) errCb(e); });
      };
      emit();
      const channel = supabase
        .channel('doc_' + table + '_' + id + '_' + Math.random().toString(36).slice(2))
        .on('postgres_changes', { event: '*', schema: 'public', table, filter: 'id=eq.' + id }, emit)
        .subscribe();
      return () => { live = false; supabase.removeChannel(channel); };
    },
  };
  return self;
}

function splitPath(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length !== 2) {
    throw new Error('db.doc() path must be "table/id" - got "' + path + '"');
  }
  return parts;
}

export const db = {
  collection(table) {
    return buildCollection(table, [], null, 'asc', null);
  },
  doc(path) {
    const [table, id] = splitPath(path);
    return docRef(table, id);
  },
};

export { randomId };
