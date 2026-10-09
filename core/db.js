import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const uid = () => randomUUID().replaceAll('-', '').slice(0, 20)
export const now = () => new Date().toISOString()

const SCHEMA = `
create table if not exists people (
  id text primary key,
  node_url text not null,
  remote integer not null default 0,
  display_name text,
  pubkey text,
  privkey text,
  tz text default 'America/Los_Angeles',
  home_place_id text,
  policy json not null default '{}',
  onboarding json not null default '{}',
  created_at text not null
);
create table if not exists identities (
  person_id text not null references people(id),
  channel text not null,            -- 'telegram' | 'fcm' | 'email'
  external_id text not null,
  meta json default '{}',
  primary key (channel, external_id)
);
create table if not exists source_configs (
  id text primary key,
  person_id text not null references people(id),
  source_id text not null,
  token text not null,
  config json not null default '{}',
  enabled integer not null default 1,
  last_poll_at text,
  last_error text,
  created_at text not null
);
create table if not exists observations (
  id text primary key,
  person_id text not null references people(id),
  source_id text not null,
  kind text not null,               -- location|event|status|intent|motion|mention
  at text not null,
  until text,
  data json not null,
  raw json,
  dedupe_key text,
  created_at text not null
);
create unique index if not exists obs_dedupe on observations(person_id, source_id, dedupe_key) where dedupe_key is not null;
create index if not exists obs_person_kind_at on observations(person_id, kind, at desc);
create table if not exists places (
  id text primary key,
  owner_id text references people(id),
  name text not null,
  lat real not null, lng real not null,
  radius_m real not null default 150,
  shared integer not null default 0,
  created_at text not null
);
create table if not exists relationships (
  from_id text not null references people(id),
  to_id text not null references people(id),
  tier text not null default 'friend',   -- acquaintance|friend|trusted
  want_more integer not null default 0,
  travel integer not null default 1,     -- 0..3, never revealed to to_id
  note text default '',
  grants json not null default '{}',
  via json not null default '{}',
  vouch integer not null default 0,
  created_at text not null,
  primary key (from_id, to_id)
);
create table if not exists invites (
  code text primary key,
  inviter_id text not null references people(id),
  invitee_name text,
  want_more integer not null default 1,
  tier text not null default 'friend',
  used_by text,
  expires_at text not null,
  created_at text not null
);
create table if not exists opportunities (
  id text primary key,
  trigger_id text not null,
  kind text not null,
  participants json not null,
  primary_id text,
  summary text not null,
  evidence json not null default '[]',
  dedupe_key text,
  expires_at text,
  status text not null default 'pending',  -- pending|judged|expired
  created_at text not null
);
create unique index if not exists opp_dedupe on opportunities(dedupe_key) where dedupe_key is not null;
create table if not exists decisions (
  id text primary key,
  person_id text not null references people(id),
  opportunity_id text references opportunities(id),
  verdict text not null,            -- suppress|nudge|ask
  reasoning text,
  nudge_id text,
  rating text,                      -- good|bad
  rating_note text,
  rated_at text,
  created_at text not null
);
create table if not exists nudges (
  id text primary key,
  person_id text not null references people(id),
  decision_id text references decisions(id),
  text text not null,
  actions json not null default '[]',
  channel text,
  external_id text,
  response text,                    -- action key chosen
  responded_at text,
  expires_at text,
  created_at text not null
);
create table if not exists query_log (
  id text primary key,
  from_id text not null, to_id text not null, kind text not null,
  text text, answer text, reason text,
  created_at text not null
);
create index if not exists ql_rate on query_log(from_id, to_id, kind, created_at);
create table if not exists chat_log (
  id text primary key,
  person_id text not null,
  role text not null,
  content json not null,
  created_at text not null
);
create table if not exists kv (k text primary key, v json);
`

export function openDb(path = process.env.DB_PATH || './data/opportune.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal')
  db.exec('pragma foreign_keys = on')
  db.exec(SCHEMA)
  return wrap(db)
}

// Small conveniences: JSON columns in/out, and row helpers.
function wrap(db) {
  const j = v => (v === undefined ? null : JSON.stringify(v))
  return {
    raw: db,
    j,
    run: (sql, ...p) => db.prepare(sql).run(...p),
    get: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    insert(table, row) {
      const keys = Object.keys(row)
      const vals = keys.map(k => {
        const v = row[k]
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v === undefined ? null : v
      })
      db.prepare(`insert into ${table} (${keys.join(',')}) values (${keys.map(() => '?').join(',')})`).run(...vals)
      return row
    },
    kvGet(k) { const r = db.prepare('select v from kv where k = ?').get(k); return r ? JSON.parse(r.v) : undefined },
    kvSet(k, v) { db.prepare('insert into kv (k, v) values (?, ?) on conflict(k) do update set v = excluded.v').run(k, JSON.stringify(v)) },
  }
}

export const parseRow = (row, jsonCols = []) => {
  if (!row) return row
  for (const c of jsonCols) if (typeof row[c] === 'string') { try { row[c] = JSON.parse(row[c]) } catch {} }
  return row
}
