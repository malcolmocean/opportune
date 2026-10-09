// "Person I want more of would like this." P has an upcoming event; a friend F (wantMore on
// either side) who is NOT already going has a calendar history / stated intent that shares
// words with it. Cheap deterministic prefilter: token overlap only. The Judge does the taste
// reasoning on `summary` + `evidence`. No LLM calls here.
const DAYS_AHEAD = 14
const HISTORY_DAYS = 180
const MIN_MINUTES = 45
const MAX_PER_PERSON = 3
const NOISE = /standup|1:1|sync|meeting|dentist|call with/i
// generic words + calendar/address boilerplate that would otherwise match everything
const STOP = new Set(`the and for with from that this you your our are was were will have has had not but all any can into out about after before over under than then them they their its who what when where how via per each also just some more most very new old
http https www com org net event events ticket tickets rsvp doors show live night evening day time free join hosted presents featuring feat party meet meetup online zoom google calendar invite invitation reminder
street blvd boulevard ave avenue road suite floor usa united states`.split(/\s+/))

export default {
  id: 'eventInterest',
  name: 'A friend might like this event',
  intervalMin: 360,
  runCron(ctx) {
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const horizon = new Date(nowMs + DAYS_AHEAD * 864e5).toISOString()
    const since = new Date(nowMs - HISTORY_DAYS * 864e5).toISOString()
    const out = []
    for (const p of ctx.people.all()) {
      const events = ctx.observations.eventsIn(p.id, nowIso, horizon).filter(e => e.at >= nowIso && interesting(e))
      if (!events.length) continue
      const friends = ctx.people.friendsOf(p.id).filter(f => f.want_more || ctx.people.rel(f.id, p.id)?.want_more)
      if (!friends.length) continue
      const profiles = new Map(friends.map(f => [f.id, profile(ctx, f, since)]))
      const cands = []
      for (const e of events) {
        const eTokens = tokens(`${e.data.title} ${e.data.description || ''} ${e.data.location || ''}`)
        if (!eTokens.size) continue
        const alreadyGoing = new Set(ctx.observations.eventsMatching({ title: e.data.title, start: e.at, url: e.data.url }).map(m => m.person_id))
        for (const f of friends) {
          if (alreadyGoing.has(f.id)) continue   // coAttendance's job
          const s = score(eTokens, profiles.get(f.id))
          if (s.score < 1) continue
          cands.push({ e, f, ...s })
        }
      }
      cands.sort((a, b) => b.score - a.score || a.e.at.localeCompare(b.e.at))
      for (const c of cands.slice(0, MAX_PER_PERSON)) out.push(opp(p, c))
    }
    return out
  },
}

const interesting = e => {
  const d = e.data || {}
  if (!d.title || NOISE.test(d.title)) return false
  if (String(d.status || '').toUpperCase() === 'CANCELLED') return false
  if (e.until && (new Date(e.until) - new Date(e.at)) < MIN_MINUTES * 60e3) return false
  return true
}

// F's recent+future calendar (noise removed) and intents, tokenized once per run.
// Tokens that appear in >40% of F's events (when F has 5+) are treated as F-specific
// stopwords: "san francisco", "zoom", a weekly class name. Keeps the score about taste, not geography.
function profile(ctx, f, since) {
  const events = ctx.observations.recent(f.id, { kinds: ['event'], since, limit: 400 })
    .filter(interesting)
    .map(o => ({ title: o.data.title, at: o.at, tokens: tokens(`${o.data.title} ${o.data.description || ''}`) }))
    .filter(x => x.tokens.size)
  const df = new Map()
  for (const ev of events) for (const t of ev.tokens) df.set(t, (df.get(t) || 0) + 1)
  const common = new Set(events.length >= 5 ? [...df].filter(([, n]) => n / events.length > 0.4).map(([t]) => t) : [])
  const intents = ctx.observations.recent(f.id, { kinds: ['intent'], since, limit: 50 })
    .map(o => ({ text: o.data?.text || '', tokens: tokens(o.data?.text || '') }))
    .filter(x => x.tokens.size)
  return { events, intents, common }
}

function score(eTokens, pr) {
  const overlap = new Set()
  const matched = []
  for (const ev of pr.events) {
    const shared = [...eTokens].filter(t => ev.tokens.has(t) && !pr.common.has(t))
    if (!shared.length) continue
    for (const t of shared) overlap.add(t)
    matched.push({ title: ev.title, at: ev.at, n: shared.length })
  }
  let score = overlap.size
  let intent = null
  for (const it of pr.intents) {
    const shared = [...eTokens].filter(t => it.tokens.has(t))
    if (shared.length) { intent = { text: it.text, tokens: shared }; score += 1; break }
  }
  matched.sort((a, b) => b.n - a.n || b.at.localeCompare(a.at))
  return { score, overlap: [...overlap], matched, intent }
}

function opp(p, { e, f, score, overlap, matched, intent }) {
  const d = e.data
  const allDay = isAllDay(e, p.tz)
  const whenStr = when(e.at, p.tz, allDay)
  const parts = []
  if (matched.length) parts.push(`${f.display_name}'s calendar has had ${matched.length} event${matched.length === 1 ? '' : 's'} sharing words with it (${overlap.slice(0, 4).join(', ')}) incl. "${matched[0].title}"`)
  if (intent) parts.push(`${matched.length ? 'and they' : `${f.display_name}`} said "${intent.text}"`)
  return {
    kind: 'eventInterest',
    participants: [p.id, f.id],
    primary: p.id,
    summary: `${p.display_name} is going to "${d.title}" ${whenStr}${d.location ? ` (${d.location})` : ''}; ${parts.join(' ')} — worth inviting ${f.display_name}?`,
    evidence: {
      event: { title: d.title, at: e.at, until: e.until, location: d.location || null, url: d.url || null, description: (d.description || '').slice(0, 200) || null, allDay },
      overlappingTokens: overlap,
      fPastEventTitles: matched.slice(0, 5).map(m => m.title),
      fMatchedEventCount: matched.length,
      fIntent: intent?.text || null,
      score,
    },
    dedupeKey: `evint:${p.id}:${f.id}:${eventKey(e)}`,
    expiresAt: e.at,
  }
}

const eventKey = e => e.data.url || `${slug(e.data.title)}@${e.at.slice(0, 10)}`
const slug = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60)
const tokens = s => new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 3 && !/^\d+$/.test(t) && !STOP.has(t)))
const when = (iso, tz, allDay) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(allDay ? {} : { hour: 'numeric' }), timeZone: tz })
const isAllDay = (e, tz) => {
  if (!e.until) return false
  const ms = new Date(e.until) - new Date(e.at)
  if (ms < 23 * 3600e3) return false
  const hm = new Date(e.at).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
  return hm === '00:00' || hm === '24:00'
}
