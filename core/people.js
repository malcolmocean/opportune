import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { uid, now, parseRow } from './db.js'

export const TIER_DEFAULTS = {
  acquaintance: { askAvailability: true, askDropin: false, autoYesDropin: false, askWhereabouts: false, seeLocationLive: false, seePlans: false },
  friend:       { askAvailability: true, askDropin: true, autoYesDropin: false, askWhereabouts: true, seeLocationLive: false, seePlans: false },
  trusted:      { askAvailability: true, askDropin: true, autoYesDropin: true, askWhereabouts: true, seeLocationLive: true, seePlans: true },
}

export const POLICY_DEFAULTS = {
  quietHours: { start: 23, end: 8 },
  maxNudgesPerDay: 6,
  dropinDefault: 'ask',            // open|closed|ask
  dropinWindows: [],               // [{ days: [1,2,3,4,5], start: 18, end: 22 }]
  queryRate: { perHour: 6 },       // per (asker, kind)
  revealUnprompted: ['status'],    // observation kinds the agent may volunteer
}

export const STORY_MAX = 2000        // people.story: what I'm generally up for and when
export const DROPIN_NOTE_MAX = 500   // people.dropin_note: standing note shown to friends who might drop in

export function makePeople(db, env, events) {
  const nodeUrl = env.NODE_URL || 'http://localhost:3400'
  // Local people freeze node_url at creation; when NODE_URL changes (new domain) their rows follow it. Remote people keep theirs.
  db.run('update people set node_url = ? where remote = 0 and node_url != ?', nodeUrl, nodeUrl)
  const P = {
    nodeUrl,
    get(id) { return parseRow(db.get('select * from people where id = ?', id), ['policy', 'onboarding']) },
    all({ local = true } = {}) {
      return db.all(`select * from people where remote = ?`, local ? 0 : 1).map(r => parseRow(r, ['policy', 'onboarding']))
    },
    create({ displayName, tz, remote = false, nodeUrl: n, pubkey, id }) {
      const keys = remote ? {} : genKeys()
      const row = {
        id: id || uid(), node_url: n || nodeUrl, remote: remote ? 1 : 0, display_name: displayName || null,
        pubkey: pubkey || keys.pubkey || null, privkey: keys.privkey || null, tz: tz || 'America/Los_Angeles',
        policy: POLICY_DEFAULTS, onboarding: { step: 'name' }, created_at: now(),
      }
      db.insert('people', row)
      return P.get(row.id)
    },
    update(id, patch) {
      for (const [k, v] of Object.entries(patch)) {
        const col = k.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
        db.run(`update people set ${col} = ? where id = ?`, v !== null && typeof v === 'object' ? JSON.stringify(v) : v, id)
      }
      return P.get(id)
    },
    policy(id) { return { ...POLICY_DEFAULTS, ...(P.get(id)?.policy || {}) } },
    // profile text the person writes about themself: { story?, dropinNote? }. Strings only, trimmed and clamped; '' clears.
    // Returns the person, or null when nothing in the patch was a usable key.
    setProfile(id, { story, dropinNote } = {}) {
      const patch = {}
      if (typeof story === 'string') patch.story = story.trim().slice(0, STORY_MAX)
      if (typeof dropinNote === 'string') patch.dropinNote = dropinNote.trim().slice(0, DROPIN_NOTE_MAX)
      if (!Object.keys(patch).length) return null
      return P.update(id, patch)
    },

    // identities: how channels find a person
    identify(channel, externalId) {
      const r = db.get('select person_id from identities where channel = ? and external_id = ?', channel, String(externalId))
      return r ? P.get(r.person_id) : null
    },
    bind(personId, channel, externalId, meta = {}) {
      const ext = channel === 'email' ? normEmail(externalId) : channel === 'phone' ? normPhone(externalId) : String(externalId)
      const existed = db.get('select 1 from identities where channel = ? and external_id = ? and person_id = ?', channel, ext, personId)
      db.run('insert or replace into identities (person_id, channel, external_id, meta) values (?,?,?,?)', personId, channel, ext, JSON.stringify(meta))
      if (!existed) events?.emit('identity:bound', { personId, channel, externalId: ext })
    },

    // contacts: the owner's address book (from the phone app), owner-scoped, used to
    // (a) notice when someone in your contacts joins, (b) name guest-list emails.
    addContacts(ownerId, list) {
      let n = 0
      for (const c of list || []) {
        for (const e of c.emails || []) { const v = normEmail(e); if (v) { db.run('insert or ignore into contacts (owner_id, kind, value, name, created_at) values (?,?,?,?,?)', ownerId, 'email', v, c.name || null, now()); n++ } }
        for (const ph of c.phones || []) { const v = normPhone(ph); if (v) { db.run('insert or ignore into contacts (owner_id, kind, value, name, created_at) values (?,?,?,?,?)', ownerId, 'phone', v, c.name || null, now()); n++ } }
      }
      events?.emit('contacts:added', { ownerId, count: n })
      return n
    },
    contactName(ownerId, { email, phone }) {
      const r = email ? db.get('select name from contacts where owner_id = ? and kind = ? and value = ?', ownerId, 'email', normEmail(email))
        : phone ? db.get('select name from contacts where owner_id = ? and kind = ? and value = ?', ownerId, 'phone', normPhone(phone)) : null
      return r?.name || null
    },
    // the owner's contacts that match an email (exact, normalized) or a name (case/whitespace-insensitive) → [{ name, kind, value }]
    contactsMatching(ownerId, { email, name } = {}) {
      const out = [], seen = new Set()
      const push = r => { const k = `${r.kind}:${r.value}`; if (!seen.has(k)) { seen.add(k); out.push({ name: r.name || null, kind: r.kind, value: r.value }) } }
      const e = normEmail(email)
      if (e) for (const r of db.all('select name, kind, value from contacts where owner_id = ? and kind = ? and value = ?', ownerId, 'email', e)) push(r)
      const n = normName(name)
      if (n) for (const r of db.all('select name, kind, value from contacts where owner_id = ? and name is not null', ownerId)) if (normName(r.name) === n) push(r)
      return out
    },
    // who has this email/phone in their contacts? → [{ ownerId, name }]
    ownersWithContact(kind, value) {
      const v = kind === 'email' ? normEmail(value) : normPhone(value)
      return db.all('select owner_id, name from contacts where kind = ? and value = ?', kind, v).map(r => ({ ownerId: r.owner_id, name: r.name }))
    },
    identities(personId) { return db.all('select * from identities where person_id = ?', personId).map(r => parseRow(r, ['meta'])) },

    // relationships
    rel(fromId, toId) {
      const r = parseRow(db.get('select * from relationships where from_id = ? and to_id = ?', fromId, toId), ['grants', 'via'])
      if (!r) return null
      r.effectiveGrants = { ...TIER_DEFAULTS[r.tier], ...r.grants }
      return r
    },
    friendsOf(personId) {
      return db.all(`select p.*, r.tier, r.want_more, r.travel, r.note, r.grants, r.via, r.vouch
                     from relationships r join people p on p.id = r.to_id where r.from_id = ?`, personId)
        .map(r => parseRow(r, ['policy', 'onboarding', 'grants', 'via']))
    },
    // patch keys outside REL_COLUMNS (e.g. from an LLM tool call) are ignored, never interpolated into SQL.
    setRel(fromId, toId, patch = {}) {
      const ex = db.get('select 1 from relationships where from_id = ? and to_id = ?', fromId, toId)
      const wantMore = patch.wantMore ?? patch.want_more
      if (!ex) db.insert('relationships', { from_id: fromId, to_id: toId, tier: patch.tier || 'friend', want_more: wantMore ? 1 : 0, travel: patch.travel ?? 1, note: patch.note || '', grants: patch.grants || {}, via: patch.via || {}, vouch: patch.vouch ? 1 : 0, created_at: now() })
      else for (const [k, v] of Object.entries(patch)) {
        const col = REL_COLUMNS[k]
        if (!col || v === undefined) continue
        db.run(`update relationships set ${col} = ? where from_id = ? and to_id = ?`, typeof v === 'boolean' ? (v ? 1 : 0) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v, fromId, toId)
      }
      return P.rel(fromId, toId)
    },
    mutual(aId, bId) { return !!(P.rel(aId, bId) && P.rel(bId, aId)) },

    // invites: one-time codes
    invite(inviterId, { inviteeName, wantMore = true, tier = 'friend', days = 14 } = {}) {
      const code = randomBytes(6).toString('base64url')
      db.insert('invites', { code, inviter_id: inviterId, invitee_name: inviteeName || null, want_more: wantMore ? 1 : 0, tier, expires_at: new Date(Date.now() + days * 864e5).toISOString(), created_at: now() })
      return { code, url: `${nodeUrl}/i/${code}` }
    },
    peekInvite(code) {
      const r = db.get('select * from invites where code = ?', code)
      if (!r || r.used_by || r.expires_at < now()) return null
      return r
    },
    acceptInvite(code, joinerId) {
      const inv = P.peekInvite(code)
      if (!inv) return null
      db.run('update invites set used_by = ? where code = ?', joinerId, code)
      P.setRel(inv.inviter_id, joinerId, { tier: inv.tier, wantMore: !!inv.want_more })
      P.setRel(joinerId, inv.inviter_id, { tier: inv.tier, wantMore: false })
      return P.get(inv.inviter_id)
    },

    // places
    places(ownerId) { return db.all('select * from places where owner_id = ? or shared = 1', ownerId) },
    // the declared home: people.home_place_id first (set by addPlace), else the newest place named 'home'
    home(ownerId) {
      const hid = db.get('select home_place_id from people where id = ?', ownerId)?.home_place_id
      const byId = hid && db.get('select * from places where id = ? and owner_id = ?', hid, ownerId)
      return byId || db.get(`select * from places where owner_id = ? and name = 'home' order by created_at desc, rowid desc limit 1`, ownerId) || null
    },
    // friends in either direction: [{ ...person, outgoing: rel|null, incoming: rel|null }]
    connections(personId) {
      const ids = new Set([...db.all('select to_id id from relationships where from_id = ?', personId), ...db.all('select from_id id from relationships where to_id = ?', personId)].map(r => r.id))
      return [...ids].map(id => ({ ...P.get(id), outgoing: P.rel(personId, id), incoming: P.rel(id, personId) }))
    },
    addPlace(ownerId, { name, lat, lng, radiusM = 150, shared = false }) {
      const row = { id: uid(), owner_id: ownerId, name, lat, lng, radius_m: radiusM, shared: shared ? 1 : 0, created_at: now() }
      db.insert('places', row)
      if (name === 'home') db.run('update people set home_place_id = ? where id = ?', row.id, ownerId)
      return row
    },
  }
  return P
}

// relationship columns a caller may update through setRel (key → column)
const REL_COLUMNS = { tier: 'tier', wantMore: 'want_more', want_more: 'want_more', travel: 'travel', note: 'note', grants: 'grants', via: 'via', vouch: 'vouch' }

export const normEmail = e => (e || '').trim().toLowerCase() || null
export const normName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ') || null
export const normPhone = p => { const d = (p || '').replace(/[^\d+]/g, ''); if (!d) return null; const digits = d.replace(/\D/g, ''); return digits.length === 10 ? '+1' + digits : (d.startsWith('+') ? '+' : '+') + digits }

function genKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    pubkey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privkey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}
