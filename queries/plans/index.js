// "What's X up to Saturday?" Higher sensitivity: needs seePlans (trusted by default). Deterministic: no LLM.
export default {
  id: 'plans', kind: 'plans', sensitivity: 3, grant: 'seePlans',
  description: 'Calendar events in a window, verbatim. Trusted tier only by default.',
  answer(ctx, { to, window }) {
    const start = window?.start || new Date().toISOString()
    const end = window?.end || new Date(new Date(start).getTime() + 2 * 864e5).toISOString()
    const events = ctx.observations.eventsIn(to.id, start, end)
    const intents = ctx.observations.recent(to.id, { kinds: ['intent'], since: new Date(Date.now() - 7 * 864e5).toISOString(), limit: 5 })
    return { answer: events.length ? 'yes' : 'no', confidence: 1, reason: `${events.length} event(s)`, revealed: { events: events.map(e => ({ title: e.data.title, at: e.at, until: e.until, location: e.data.location, url: e.data.url })), intents: intents.map(i => i.data) } }
  },
}
