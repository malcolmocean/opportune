// A new/changed event for me matches an event a friend has (same URL, or same title+day),
// or someone I know appears in my event's attendee list.
//
// N=1 promise (DESIGN.md pattern 1): guest-list matches must work for people who are NOT on
// the system. Attendees are matched, in order, against (1) friends on the system, (2) the
// owner's contacts (email or name), (3) people the owner has created invites for, (4) "shadow"
// people (e.g. Maps-sharing contacts). Matches 2-4 are emitted as single-participant
// opportunities addressed to the owner only, so the Judge's relationship gate passes.
import { normName } from '../../core/people.js'

const MAX_OFFSYSTEM_PER_EVENT = 5
const ABSENT = new Set(['declined', 'cancelled'])

export default {
  id: 'coAttendance',
  name: 'Both going to the same thing',
  on: ['event'],
  run(ctx, { observation: o, person }) {
    const ev = o.data
    if (!ev || new Date(o.at) < new Date()) return []
    const out = []
    // shadow people aren't on the system; they're handled as guest-list matches below
    const friends = ctx.people.friendsOf(person.id).filter(f => !isShadow(f))
    // 1. friend has the same event → both are on the system: tell both, direction-free key
    for (const m of ctx.observations.eventsMatching({ title: ev.title, start: o.at, url: ev.url })) {
      if (m.person_id === person.id) continue
      const f = friends.find(f => f.id === m.person_id)
      if (!f || out.some(x => x.participants.includes(f.id))) continue
      out.push(pairOpp(person, f, ev, o, { primary: null, why: 'both have it on their calendar' }))
    }
    // 2. someone on my attendee list
    const myEmails = new Set(ctx.people.identities(person.id).filter(i => i.channel === 'email').map(i => i.external_id.toLowerCase()))
    const shadows = ctx.people.connections(person.id).filter(isShadow)
    let offSystem = 0
    for (const a of ev.attendees || []) {
      if (!a || (!a.name && !a.email)) continue
      if (ABSENT.has(a.status)) continue
      const email = (a.email || '').trim().toLowerCase()
      if (sameName(person.display_name, a.name) || (email && myEmails.has(email))) continue   // that's me
      // 2a. a friend on the system (by name or bound email) → the match came from MY list: tell me
      const f = friends.find(f => sameName(f.display_name, a.name) || (email && ctx.people.identities(f.id).some(i => i.channel === 'email' && i.external_id.toLowerCase() === email)))
      if (f) {
        if (!out.some(x => x.participants.includes(f.id))) out.push(pairOpp(person, f, ev, o, { primary: person.id, why: 'they\'re on the guest list' }))
        continue
      }
      // 2b. someone I know who is NOT on the system
      if (offSystem >= MAX_OFFSYSTEM_PER_EVENT) continue
      const match = offSystemMatch(ctx, person, shadows, a, email)
      if (!match) continue
      const key = guestKey(person, ev, o, match.name)
      if (out.some(x => x.dedupeKey === key)) continue
      out.push(guestOpp(person, ev, o, a, match))
      offSystem++
    }
    return out
  },
}

// contacts (email, then name) → invites (name) → shadow people (name). → { name, via } | null
function offSystemMatch(ctx, person, shadows, a, email) {
  const contacts = ctx.people.contactsMatching(person.id, { email, name: a.name })
  if (contacts.length) return { name: contacts.find(c => c.name)?.name || a.name || email, via: 'contacts' }
  const n = normName(a.name)
  if (!n) return null
  const inv = ctx.db.all('select invitee_name from invites where inviter_id = ? and invitee_name is not null', person.id).find(r => normName(r.invitee_name) === n)
  if (inv) return { name: inv.invitee_name, via: 'invite' }
  const s = shadows.find(s => sameName(s.display_name, a.name))
  if (s) return { name: s.display_name, via: 'shadow', shadow: s }
  return null
}

const isShadow = p => p?.onboarding?.step === 'shadow'
const sameName = (a, b) => !!a && !!b && normName(a) === normName(b)
const when = (iso, tz) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', ...(tz ? { timeZone: tz } : {}) })
const eventKey = (ev, o) => `${ev.url || ev.title}:${o.at.slice(0, 10)}`
const eventEvidence = (ev, o, why) => ({ kind: 'event', title: ev.title, at: o.at, location: ev.location, url: ev.url, ...(why ? { why } : {}) })

// both on the system. primary null = tell both (the Judge decides each); primary = person when the match came from that person's guest list only.
const pairOpp = (person, f, ev, o, { primary, why }) => ({
  kind: 'coAttendance', participants: [person.id, f.id], primary,
  summary: `${person.display_name} and ${f.display_name} are both going to "${ev.title}" on ${when(o.at, person.tz)} (${why}).${ev.location ? ` It's at ${ev.location}.` : ''}`,
  evidence: [eventEvidence(ev, o, why)],
  dedupeKey: `coatt:${[person.id, f.id].sort().join(':')}:${eventKey(ev, o)}${primary ? `:guest:${primary}` : ''}`,
  expiresAt: o.at,
})

// someone I know who is not on the system is on my guest list. Only I am a participant.
const guestKey = (person, ev, o, name) => `coatt:${person.id}:${eventKey(ev, o)}:guest:${normName(name)}`
const guestOpp = (person, ev, o, a, match) => {
  const going = ['going', 'hosting', 'maybe'].includes(ev.rsvpStatus) || ev.rsvpStatus == null
  const theirs = a.role === 'host' || a.status === 'hosting' ? 'is hosting' : 'is on the guest list for'
  return {
    kind: 'coAttendance', participants: [person.id], primary: person.id,
    summary: `${match.name} (${VIA_LABEL[match.via](match)}) ${theirs} "${ev.title}" ${when(o.at, person.tz)} — ${going ? 'you\'re both going' : 'you\'re invited too'}.${ev.location ? ` It's at ${ev.location}.` : ''}`,
    evidence: [eventEvidence(ev, o), { kind: 'attendee', attendee: a, matchedVia: match.via }],
    dedupeKey: guestKey(person, ev, o, match.name),
    expiresAt: o.at,
  }
}
const VIA_LABEL = {
  contacts: () => 'from your contacts',
  invite: () => 'who you invited to Opportune',
  shadow: m => m.shadow?.onboarding?.via === 'mapsSharing' ? 'who shares their Maps location with you' : 'not on Opportune yet',
}
