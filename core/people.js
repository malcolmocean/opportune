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

export function makePeople(db, env) {
  const nodeUrl = env.NODE_URL || 'http://localhost:3400'
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

    // identities: how channels find a person
    identify(channel, externalId) {
      const r = db.get('select person_id from identities where channel = ? and external_id = ?', channel, String(externalId))
      return r ? P.get(r.person_id) : null
    },
    bind(personId, channel, externalId, meta = {}) {
      db.run('insert or replace into identities (person_id, channel, external_id, meta) values (?,?,?,?)', personId, channel, String(externalId), JSON.stringify(meta))
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
    setRel(fromId, toId, patch = {}) {
      const ex = db.get('select 1 from relationships where from_id = ? and to_id = ?', fromId, toId)
      if (!ex) db.insert('relationships', { from_id: fromId, to_id: toId, tier: patch.tier || 'friend', want_more: patch.wantMore ? 1 : 0, travel: patch.travel ?? 1, note: patch.note || '', grants: patch.grants || {}, via: patch.via || {}, vouch: patch.vouch ? 1 : 0, created_at: now() })
      else for (const [k, v] of Object.entries(patch)) {
        const col = { wantMore: 'want_more' }[k] || k
        db.run(`update relationships set ${col} = ? where from_id = ? and to_id = ?`, typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'object' ? JSON.stringify(v) : v, fromId, toId)
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
    addPlace(ownerId, { name, lat, lng, radiusM = 150, shared = false }) {
      const row = { id: uid(), owner_id: ownerId, name, lat, lng, radius_m: radiusM, shared: shared ? 1 : 0, created_at: now() }
      db.insert('places', row); return row
    },
  }
  return P
}

function genKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    pubkey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privkey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}
