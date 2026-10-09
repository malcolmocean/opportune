// A new/changed event for me matches an event a friend has (same URL, or same title+day),
// or a friend's name/email appears in my event's attendee list.
export default {
  id: 'coAttendance',
  name: 'Both going to the same thing',
  on: ['event'],
  run(ctx, { observation: o, person }) {
    const ev = o.data
    if (!ev || new Date(o.at) < new Date()) return []
    const out = []
    const friends = ctx.people.friendsOf(person.id)
    // 1. friend has the same event
    for (const m of ctx.observations.eventsMatching({ title: ev.title, start: o.at, url: ev.url })) {
      if (m.person_id === person.id) continue
      const f = friends.find(f => f.id === m.person_id)
      if (!f) continue
      out.push(opp(person, f, ev, o, 'both have it on their calendar'))
    }
    // 2. friend is in my attendee list (name or email), even if they're not on the system yet → still useful to me
    for (const a of ev.attendees || []) {
      const f = friends.find(f => sameName(f.display_name, a.name) || ctx.people.identities(f.id).some(i => i.channel === 'email' && i.external_id.toLowerCase() === (a.email || '').toLowerCase()))
      if (f && !out.some(x => x.participants.includes(f.id))) out.push(opp(person, f, ev, o, 'they\'re on the guest list'))
    }
    return out
  },
}
const when = iso => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' })
const opp = (person, f, ev, o, why) => ({
  kind: 'coAttendance', participants: [person.id, f.id], primary: person.id,
  summary: `${person.display_name} and ${f.display_name} are both going to "${ev.title}" on ${when(o.at)} (${why}).${ev.location ? ` It's at ${ev.location}.` : ''}`,
  evidence: [{ kind: 'event', title: ev.title, at: o.at, location: ev.location, url: ev.url, why }],
  dedupeKey: `coatt:${[person.id, f.id].sort().join(':')}:${ev.url || ev.title}:${o.at.slice(0, 10)}`,
  expiresAt: o.at,
})
const sameName = (a, b) => a && b && a.trim().toLowerCase() === b.trim().toLowerCase()
