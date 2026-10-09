import ical from 'node-ical'

// Calendar via ICS URL(s). No OAuth. Google: Settings → your calendar → "Secret address in iCal format".
export default {
  id: 'icsCalendar',
  name: 'Calendar (ICS link)',
  description: 'Reads your calendar from one or more secret ICS URLs. Events feed availability, plans, co-attendance.',
  repo: 'https://github.com/malcolmocean/opportune/tree/main/sources/icsCalendar',
  kinds: ['event'],
  intervalMin: 15,
  setup: [
    { key: 'urls', type: 'text', label: 'Paste your calendar\'s secret ICS address (Google: calendar settings → "Secret address in iCal format"). Several? Separate with spaces.', parse: v => v.split(/\s+/).filter(Boolean) },
  ],
  async poll(ctx, person, config) {
    const out = []
    const lo = Date.now() - 30 * 864e5, hi = Date.now() + 60 * 864e5
    for (const url of config.urls || []) {
      const data = await ical.async.fromURL(url)
      for (const ev of Object.values(data)) {
        if (ev.type !== 'VEVENT') continue
        const instances = expand(ev, lo, hi)
        for (const { start, end } of instances) {
          out.push({
            kind: 'event', at: start.toISOString(), until: end?.toISOString(),
            dedupeKey: `${ev.uid}@${start.toISOString()}`,
            data: {
              title: ev.summary || '(untitled)', location: ev.location || null, description: (ev.description || '').slice(0, 500),
              url: ev.url || firstUrl(ev.description) || null, provider: 'ics',
              attendees: attendees(ev), status: ev.status || null, busy: ev.transparency !== 'TRANSPARENT',
            },
          })
        }
      }
    }
    return out
  },
}

function expand(ev, lo, hi) {
  const dur = (ev.end?.getTime() || ev.start.getTime() + 3600e3) - ev.start.getTime()
  if (ev.rrule) {
    return ev.rrule.between(new Date(lo), new Date(hi), true).map(d => {
      // rrule returns dates in the event's tz; node-ical gives local JS dates
      const start = new Date(d)
      const key = start.toISOString().slice(0, 10)
      if (ev.exdate && Object.keys(ev.exdate).some(k => k.startsWith(key))) return null
      return { start, end: new Date(start.getTime() + dur) }
    }).filter(Boolean)
  }
  const s = ev.start.getTime()
  if (s < lo || s > hi) return []
  return [{ start: ev.start, end: ev.end || new Date(s + dur) }]
}
const attendees = ev => {
  const a = ev.attendee ? (Array.isArray(ev.attendee) ? ev.attendee : [ev.attendee]) : []
  return a.map(x => ({ name: x.params?.CN || null, email: (x.val || '').replace(/^mailto:/i, '') || null })).filter(x => x.name || x.email)
}
const firstUrl = s => (s || '').match(/https?:\/\/\S+/)?.[0] || null
