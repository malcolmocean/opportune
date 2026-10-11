// Deterministic "is this person in a vehicle?" from the phone's activity recognition (motion observations:
// still | walking | driving | transit) and the speed on location fixes. No LLM. Triggers use it so that a
// drive-by is not mistaken for someone out and about. Nothing here returns coordinates.

export const VEHICLE_STATES = new Set(['driving', 'transit'])
export const VEHICLE_SPEED_MPS = 5            // ~18 km/h: faster than a brisk walk or a jog, slower than most traffic
export const MOTION_FRESH_MS = 10 * 60e3      // a motion state older than this says nothing about a fix
export const RECENT_VEHICLE_MS = 10 * 60e3    // vehicle evidence this recent means "just parked": ask for a dwell before believing they stopped
export const LOOKBACK_MS = 20 * 60e3          // how far back the history for these checks goes

const ms = iso => new Date(iso).getTime()

// The motion state in force at `atIso`: the latest motion observation at or before it, no older than MOTION_FRESH_MS.
export function motionAt(motions, atIso) {
  const t = ms(atIso)
  const m = (motions || []).find(o => ms(o.at) <= t && t - ms(o.at) <= MOTION_FRESH_MS)   // recent() is newest-first
  return m?.data?.state || null
}

// Was this fix taken in a vehicle? Speed on the fix if it says so, else the motion state in force at that moment
// (activity recognition keeps saying "driving" at a red light, which is right).
export function inVehicle(fix, motions) {
  if (!fix) return false
  const speed = fix.data?.speed
  if (speed != null && speed >= VEHICLE_SPEED_MPS) return true
  return VEHICLE_STATES.has(motionAt(motions, fix.at))
}

// Recent history around a fix: motion observations and location fixes in the LOOKBACK_MS before it, newest first.
export function history(ctx, personId, fix) {
  const end = fix?.at || new Date().toISOString()
  const since = new Date(ms(end) - LOOKBACK_MS).toISOString()
  const upTo = o => ms(o.at) <= ms(end)
  return {
    motions: ctx.observations.recent(personId, { kinds: ['motion'], since, limit: 40 }).filter(upTo),
    fixes: ctx.observations.recent(personId, { kinds: ['location'], since, limit: 60 }).filter(upTo),
  }
}

// When was this person last in a vehicle before `fix`, within RECENT_VEHICLE_MS? ISO or null.
export function lastVehicleAt({ motions, fixes }, fix) {
  const t = ms(fix.at), floor = t - RECENT_VEHICLE_MS
  const times = [
    ...motions.filter(m => VEHICLE_STATES.has(m.data?.state)).map(m => m.at),
    ...fixes.filter(x => x.data?.speed != null && x.data.speed >= VEHICLE_SPEED_MPS).map(x => x.at),
  ].filter(at => ms(at) > floor && ms(at) <= t)
  return times.length ? times.reduce((a, b) => (ms(a) > ms(b) ? a : b)) : null
}
