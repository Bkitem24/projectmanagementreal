-- Blue Kite Ops - schema v17 (2026-09-28)
--
-- Run this in the Supabase SQL editor. Fixes a real bug in schema_v15.sql -
-- run this whether or not schema_v15.sql has already been applied; it's
-- written to work either way and is safe to re-run.
--
-- The bug: schema_v15.sql's "roles" table used "key" as its primary key
-- column. Every other table in this app is addressed through the
-- Firestore-style shim (src/lib/db.js's docRef()), which ALWAYS assumes
-- the underlying table has a real column literally named "id" - db.doc()'s
-- get()/set()/update()/delete() all filter or upsert on .eq('id', ...)
-- regardless of what's in the payload. "roles" was the only table in the
-- whole schema that didn't follow that convention, so every write against
-- it failed outright: "Could not find the 'id' column of 'roles' in the
-- schema cache" on create, "column roles.id does not exist" on edit -
-- confirmed by Humayun's real-world test, 2026-09-28.
--
-- Fix: add a real "id" column, backfill it from the existing "key" values
-- (so nothing already seeded/created is lost), and make IT the primary
-- key instead. "key" stays exactly as it was otherwise - nothing in the
-- app code needs to change, since src/main.js's role rows always set
-- key/id to the same value (db.doc('roles/'+key).set(...) already writes
-- an "id" field matching the path automatically, via the shim itself -
-- that part of round 13's code was already correct, only the schema
-- underneath it wasn't).

alter table public.roles add column if not exists id text;
update public.roles set id = key where id is null;
alter table public.roles alter column id set not null;

-- Swap the primary key from "key" to "id". schema_v15.sql's "key text
-- primary key" got Postgres's default constraint name (roles_pkey) since
-- it wasn't explicitly named - dropping/re-adding by that name is safe
-- whether or not this has already been run once (IF EXISTS on the drop).
alter table public.roles drop constraint if exists roles_pkey;
alter table public.roles add constraint roles_pkey primary key (id);

comment on column public.roles.id is
  'Added 2026-09-28 (schema_v17.sql) - the shim src/lib/db.js requires every table to have a real "id" column for its get/set/update/delete calls to work at all. Always kept equal to "key" by the app; "key" is what application logic actually reads/writes, "id" only exists to satisfy the shim.';
