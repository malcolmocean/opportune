import { log } from './log.js'
const L = log('cron')

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
}

// Daily digest at the person's chosen hour: things worth knowing + what the judge suppressed.
export function makeDigest(db, ctx) {
  return {
    async tick() {
      for (const p of ctx.people.all()) {
        const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: p.tz }).format(new Date()))
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
      const actions = quiet.slice(0, 4).map((q, i) => ({ key: `wish:${q.id}`, label: `Should've told me #${i + 1}` }))
      await ctx.nudges.send(p.id, { text, actions })
    },
  }
}
