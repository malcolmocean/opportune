import { localHour } from './geo.js'
import { log } from './log.js'
const L = log('cron')

// Where a setting lives for this person: "with /home" if they have the Telegram bot, else the app's Settings + manage link.
export async function settingsHint(ctx, personId, command) {
  if (ctx.people.identities(personId).some(i => i.channel === 'telegram')) return `with ${command}`
  const { appUrl } = await import('../web/routes.js')
  return `in the app's Settings (${appUrl(ctx, personId, 'settings')})`
}

// Deliberately boring: setInterval ticks. Jobs: poll sources, run cron triggers,
// daily digest (incl. "I stayed quiet about..."), expire opportunities.
export function startCron(ctx) {
  const every = (ms, fn, name) => { const t = setInterval(() => fn().catch(e => L.error(name, e)), ms); t.unref(); fn().catch(e => L.error(name, e)) }
  every(60e3, () => ctx.sources.pollDue(), 'poll')
  every(5 * 60e3, async () => {
    for (const t of Object.values(ctx.plugins.triggers)) {
      if (!t.runCron) continue
      const last = ctx.db.kvGet(`cron:${t.id}`) || 0
      if (Date.now() - last < (t.intervalMin || 60) * 60e3) continue
      ctx.db.kvSet(`cron:${t.id}`, Date.now())
      const opps = await t.runCron(ctx)
      for (const o of opps || []) await ctx.opportunities.add(t.id, o)
    }
  }, 'cron-triggers')
  every(10 * 60e3, async () => ctx.digest.tick(), 'digest')
  every(6 * 3600e3, async () => inferHomes(ctx), 'infer-home')
}

// For people without a declared home: the median of overnight (1am–5am local) fixes over the last 14 days, if there are enough.
export function inferHomes(ctx) {
  let n = 0
  for (const p of ctx.people.all().filter(p => p.onboarding?.step === 'done')) {
    if (ctx.people.home(p.id)) continue
    const since = new Date(Date.now() - 14 * 864e5).toISOString()
    const pts = ctx.observations.recent(p.id, { kinds: ['location'], since, limit: 2000 }).filter(o => {
      const h = localHour(p.tz, new Date(o.at))
      return h >= 1 && h < 5 && o.data?.lat
    })
    if (pts.length < 5) continue
    const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
    const lat = med(pts.map(o => o.data.lat)), lng = med(pts.map(o => o.data.lng))
    const near = pts.filter(o => ctx.geo.distanceM({ lat, lng }, o.data) < 200).length
    if (near / pts.length < 0.6) continue   // sleeps in too many places; don't guess
    ctx.people.addPlace(p.id, { name: 'home', lat, lng, radiusM: 120 })
    n++
    settingsHint(ctx, p.id, '/home')
      .then(how => ctx.nudges.send(p.id, { text: `I think I've worked out where home is from where your phone sleeps. If that's wrong, set it ${how}.`, actions: [{ key: 'yes', label: 'Looks right' }] }))
      .catch(() => {})
  }
  return n
}

// Daily digest at the person's chosen hour: things worth knowing + what the judge suppressed.
export function makeDigest(db, ctx) {
  return {
    async tick() {
      for (const p of ctx.people.all().filter(p => p.onboarding?.step === 'done')) {
        const hour = localHour(p.tz)
        const want = p.policy?.digestHour ?? 9
        const key = `digest:${p.id}`, last = db.kvGet(key)
        const today = new Date().toISOString().slice(0, 10)
        if (hour !== want || last === today) continue
        db.kvSet(key, today)
        await this.sendFor(p)
      }
    },
    async sendFor(p) {
      const since = new Date(Date.now() - 864e5).toISOString()
      const quiet = ctx.judge.suppressedSince(p.id, since)
      const upcoming = ctx.observations.eventsIn(p.id, new Date().toISOString(), new Date(Date.now() + 3 * 864e5).toISOString()).slice(0, 5)
      if (!quiet.length && !upcoming.length) return
      let text = `Morning. `
      if (upcoming.length) text += `Coming up: ${upcoming.map(e => `${e.data.title} (${new Date(e.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', timeZone: p.tz })})`).join(', ')}. `
      if (quiet.length) text += `\n\nI stayed quiet about ${quiet.length} thing${quiet.length > 1 ? 's' : ''}:\n` + quiet.map((q, i) => `${i + 1}. ${q.summary}  (${q.reasoning?.replace(/^gate: /, '')})`).join('\n') + `\n\nTap one if I should have told you.`
      const actions = quiet.slice(0, 4).map((q, i) => ({ key: `wish:${q.id}`, label: `Should've told me #${i + 1}` }))   // wish:<id> → channel rates that suppress decision 'bad'
      await ctx.nudges.send(p.id, { text, actions })
    },
  }
}
