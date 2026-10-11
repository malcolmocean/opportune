// What the node currently believes about a person, in words they can audit: where they are, whether they are
// moving, what their porchlight is doing, and what the calendar says. Each fact names its basis so the person
// can tell a stale fix from a missing source. Deterministic; the app shows it with a "wrong" button per fact and
// corrections land as 'correction' observations (see web/routes.js /api/app/corrections).
import { porchlight, presence } from '../queries/dropin/porchlight.js'
import { MOTION_FRESH_MS, VEHICLE_SPEED_MPS } from './motion.js'

const NEXT_EVENT_MS = 12 * 3600e3

export function belief(ctx, person) {
  const now = Date.now()
  const ago = iso => { const m = Math.round((now - new Date(iso)) / 60e3); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago` }
  const clock = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: person.tz })
  const facts = []

  // where
  const { loc, home, isHome } = presence(ctx, person.id)
  const anyFix = loc || ctx.observations.latest(person.id, 'location')
  facts.push({
    key: 'where',
    value: !home ? 'no home set' : isHome ? 'home' : loc ? 'out' : 'unknown',
    basis: !anyFix ? 'no location from your phone yet' : loc ? `phone fix ${ago(loc.at)}${loc.data.placeName ? `, near ${loc.data.placeName}` : ''}` : `last fix ${ago(anyFix.at)}, too old to trust`,
  })

  // moving
  const motion = ctx.observations.latest(person.id, 'motion', { within: MOTION_FRESH_MS })
  const speed = loc?.data?.speed
  const moving = motion?.data?.state || (speed == null ? null : speed >= VEHICLE_SPEED_MPS ? 'in a vehicle' : speed >= 0.5 ? 'walking' : 'still')
  facts.push({ key: 'moving', value: moving || 'unknown', basis: motion ? `phone activity ${ago(motion.at)}` : speed != null ? `from speed, ${ago(loc.at)}` : 'no fresh activity reading' })

  // porchlight
  const light = porchlight(ctx, person)
  facts.push({
    key: 'porchlight', value: light.state,
    basis: light.source === 'status' ? `you set it${light.until ? `, until ${clock(light.until)}` : ''}` : light.source === 'window' ? 'one of your drop-in windows' : 'your default when nothing else applies',
  })

  // calendar
  const hasCalendar = ctx.sources.forPerson(person.id).some(s => s.enabled && ctx.plugins.sources[s.source_id]?.kinds?.includes('event'))
  const nowIso = new Date(now).toISOString()
  const current = ctx.observations.eventsIn(person.id, nowIso, nowIso)[0]
  const next = current ? null : ctx.observations.eventsIn(person.id, nowIso, new Date(now + NEXT_EVENT_MS).toISOString()).find(e => new Date(e.at) > now)
  facts.push({
    key: 'calendar',
    value: current ? `at ${current.data?.title || 'an event'}${current.until ? ` until ${clock(current.until)}` : ''}` : next ? `free until ${next.data?.title || 'an event'} at ${clock(next.at)}` : hasCalendar ? 'free for the next 12h' : 'no calendar connected',
    basis: current || next ? 'from your calendar' : hasCalendar ? 'nothing on your calendar' : 'connect a calendar in Sources',
  })

  return { facts, at: nowIso }
}

// A person saying one of the facts above is wrong. Stored as an observation so the Review screen can show it
// and future judgement work can learn from it; `actually` is their free-text correction, optional.
export async function correct(ctx, person, { key, believed, actually }) {
  const data = { key: String(key).slice(0, 32), believed: String(believed ?? '').slice(0, 200), actually: actually ? String(actually).slice(0, 500) : null }
  const [row] = await ctx.observations.ingest(person.id, 'manual', [{ kind: 'correction', data }])
  return row
}
