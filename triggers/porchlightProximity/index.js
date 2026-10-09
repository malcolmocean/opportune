// A is out and about within a block of F's home, F is home. Emits a 'dropin' opportunity with
// F's current porchlight in evidence; the Judge typically answers "ask" → queries/dropin.
// Two entry points: A's location moves (on 'location'), or F flips porchlight (on 'status').
// Deterministic. Evidence never carries coordinates, only distance, place names and ages.
import { porchlight, presence, atHome, homePlace, HOME_FRESH_MS } from '../../queries/dropin/porchlight.js'

const RADIUS_M = 400
const EXPIRES_MS = 40 * 60e3
const BUCKET_MS = 2 * 3600e3

export default {
  id: 'porchlightProximity',
  name: 'Friend a block from your place while you are home',
  on: ['location', 'status'],
  radiusM: RADIUS_M,

  run(ctx, { observation: o, person }) {
    if (!person) return []
    if (o.kind === 'location') return onLocation(ctx, person, o)
    if (o.kind === 'status') return onStatus(ctx, person, o)
    return []
  },
}

// A moved: for each wantMore friend F with a home within RADIUS_M of A, who is home → opportunity (primary A).
function onLocation(ctx, a, o) {
  const here = o.data
  if (here?.lat == null) return []
  if (atHome(ctx, a.id, o)) return []          // A at their own home is not a drop-in
  const out = []
  for (const f of wantMoreFriends(ctx, a.id)) {
    const home = homePlace(ctx, f.id)
    if (!home) continue
    const d = ctx.geo.distanceM(here, home)
    if (d > RADIUS_M) continue
    const opp = build(ctx, { a, aLoc: o, f, home, distanceM: d })
    if (opp) out.push(opp)
  }
  return out
}

// F flipped porchlight (not to closed): which wantMore friends are within RADIUS_M of F's home right now?
function onStatus(ctx, f, o) {
  if (!o.data?.porchlight || o.data.porchlight === 'closed') return []
  if (o.until && o.until < new Date().toISOString()) return []
  const home = homePlace(ctx, f.id)
  if (!home) return []
  const out = []
  for (const a of wantMoreFriends(ctx, f.id)) {
    const aLoc = ctx.observations.latest(a.id, 'location', { within: HOME_FRESH_MS })
    if (aLoc?.data?.lat == null) continue
    if (atHome(ctx, a.id, aLoc)) continue
    const d = ctx.geo.distanceM(aLoc.data, home)
    if (d > RADIUS_M) continue
    const opp = build(ctx, { a, aLoc, f, home, distanceM: d })
    if (opp) out.push(opp)
  }
  return out
}

// Common tail: F must be home (fresh location at home). Returns the opportunity or null.
function build(ctx, { a, aLoc, f, home, distanceM }) {
  const fp = presence(ctx, f.id)
  if (!fp.isHome) return null
  const light = porchlight(ctx, f)
  const where = aLoc.data.placeName ? ` (at ${aLoc.data.placeName})` : ''
  const bucket = Math.floor(Date.now() / BUCKET_MS)
  return {
    kind: 'dropin',
    participants: [a.id, f.id],
    primary: a.id,
    summary: `${a.display_name} is ${ctx.geo.fmtDistance(distanceM)} from ${f.display_name}'s place${where} and ${f.display_name} is home. ${f.display_name}'s porchlight is ${light.state}${light.source === 'status' ? '' : ` (${light.source})`}.`,
    evidence: [
      { kind: 'location', who: a.id, at: aLoc.at, placeName: aLoc.data.placeName || null, distanceToHomeM: Math.round(distanceM), ageMin: ctx.geo.minutesAgo(aLoc.at) },
      { kind: 'location', who: f.id, at: fp.loc.at, placeName: 'home', ageMin: ctx.geo.minutesAgo(fp.loc.at) },
      { kind: 'porchlight', who: f.id, state: light.state, source: light.source, until: light.until || null },
    ],
    dedupeKey: `dropin:${[a.id, f.id].sort().join(':')}:${bucket}`,
    expiresAt: new Date(Date.now() + EXPIRES_MS).toISOString(),
  }
}

// Friends in either direction where at least one side marked wantMore.
function wantMoreFriends(ctx, personId) {
  const seen = new Map()
  for (const f of ctx.people.friendsOf(personId)) {
    if (f.want_more || ctx.people.rel(f.id, personId)?.want_more) seen.set(f.id, f)
  }
  // edges pointing at us where we have no edge back (they want more of us; still a drop-in candidate)
  for (const r of ctx.db.all('select from_id from relationships where to_id = ? and want_more = 1', personId)) {
    if (!seen.has(r.from_id)) { const p = ctx.people.get(r.from_id); if (p) seen.set(p.id, p) }
  }
  return [...seen.values()]
}
