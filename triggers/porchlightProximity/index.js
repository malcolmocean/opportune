// A is out and about within a block of F's home, F is home. Emits a 'dropin' opportunity with
// F's current porchlight in evidence; the Judge typically answers "ask" → queries/dropin.
// Two entry points: A's location moves (on 'location'), or F flips porchlight (on 'status').
// Deterministic. Evidence never carries coordinates, only distance, place names and ages.
//
// Drive-by isn't drop-in, but cars exist. If A's latest fix says they are in a vehicle (speed or the phone's
// motion state) we do not fire on the first in-radius fix: a car passing F's block is nothing. We fire when
//   - A has been out of the vehicle within the radius for a short dwell (DWELL_FIXES fixes over DWELL_MS), i.e. parked, or
//   - A's private `travel` toward F is >= TRAVEL_WOULD_DRIVE: someone who would happily drive to F is plausibly doing so.
// Either way the evidence carries arrivedBy: 'car' so the Judge phrases it right and F's agent can weigh it.
// Walking/still with no recent vehicle evidence fires immediately, as before.
import { porchlight, presence, atHome, homePlace, HOME_FRESH_MS } from '../../queries/dropin/porchlight.js'
import { inVehicle, history, lastVehicleAt } from '../../core/motion.js'

const RADIUS_M = 400
const EXPIRES_MS = 40 * 60e3
const BUCKET_MS = 2 * 3600e3
export const DWELL_MS = 3 * 60e3          // parked: this long out of the vehicle inside the radius...
export const DWELL_FIXES = 2              // ...over at least this many fixes
export const TRAVEL_WOULD_DRIVE = 2       // A's travel toward F at or above this: a car near F's place is plausibly headed there

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
    const arr = arrival(ctx, { a, aLoc: o, f, home })
    if (!arr.ok) continue
    const opp = build(ctx, { a, aLoc: o, f, home, distanceM: d, arrival: arr })
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
    const arr = arrival(ctx, { a, aLoc, f, home })
    if (!arr.ok) continue
    const opp = build(ctx, { a, aLoc, f, home, distanceM: d, arrival: arr })
    if (opp) out.push(opp)
  }
  return out
}

// The drive-by rule (see top). → { ok, arrivedBy?: 'car', moving?: true }
function arrival(ctx, { a, aLoc, f, home }) {
  const h = history(ctx, a.id, aLoc)
  if (inVehicle(aLoc, h.motions)) {
    const travel = ctx.people.rel(a.id, f.id)?.travel ?? 1    // A's own number, never shown to F; it only decides whether we fire
    return travel >= TRAVEL_WOULD_DRIVE ? { ok: true, arrivedBy: 'car', moving: true } : { ok: false }
  }
  const parkedAt = lastVehicleAt(h, aLoc)
  if (!parkedAt) return { ok: true }                             // on foot, no recent vehicle: unchanged behaviour
  const dwell = h.fixes.filter(x => x.at > parkedAt && !inVehicle(x, h.motions) && x.data?.lat != null && ctx.geo.distanceM(x.data, home) <= RADIUS_M)
  const first = dwell.at(-1)                                      // newest first, so the last is the earliest
  if (dwell.length >= DWELL_FIXES && new Date(aLoc.at) - new Date(first.at) >= DWELL_MS) return { ok: true, arrivedBy: 'car' }
  return { ok: false }
}

// Common tail: F must be home (fresh location at home). Returns the opportunity or null.
function build(ctx, { a, aLoc, f, home, distanceM, arrival: { arrivedBy, moving } = {} }) {
  const fp = presence(ctx, f.id)
  if (!fp.isHome) return null
  const light = porchlight(ctx, f)
  const where = aLoc.data.placeName ? ` (at ${aLoc.data.placeName})` : ''
  const car = arrivedBy === 'car' ? (moving ? ', in a car,' : ', just parked,') : ''
  const bucket = Math.floor(Date.now() / BUCKET_MS)
  return {
    kind: 'dropin',
    participants: [a.id, f.id],
    primary: a.id,
    summary: `${a.display_name} is ${ctx.geo.fmtDistance(distanceM)} from ${f.display_name}'s place${where}${car} and ${f.display_name} is home. ${f.display_name}'s porchlight is ${light.state}${light.source === 'status' ? (light.until ? ` for another ${Math.max(0, Math.round((new Date(light.until) - Date.now()) / 60000))} min` : '') : ` (${light.source})`}.`,
    evidence: [
      { kind: 'location', who: a.id, at: aLoc.at, placeName: aLoc.data.placeName || null, distanceToHomeM: Math.round(distanceM), ageMin: ctx.geo.minutesAgo(aLoc.at), ...(arrivedBy ? { arrivedBy } : {}) },
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
