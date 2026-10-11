// "Would X be up for a hike Saturday?" An open question answered by the LLM from the same tier-safe facts the
// availability query uses: calendar in the window (titles only matter for trusted), place name, status, recent
// intents, the answerer's note about the asker. Highest sensitivity because the question is unconstrained.
// Without an LLM there is nothing to answer with, so it says 'unsupported' rather than guess.
const WINDOW_MS = 4 * 3600e3
export default {
  id: 'freeform', kind: 'freeform', sensitivity: 5, grant: 'askAvailability',
  description: 'Open question answered by the LLM from calendar, rough place, status and intents under the tier rules. Never exact location or private notes.',
  async answer(ctx, { from, to, relationship, text, window, context }) {
    if (!text?.trim()) return { answer: 'unsupported', confidence: 0, reason: 'no question' }
    if (!ctx.llm.enabled) return { answer: 'unsupported', confidence: 0, reason: 'freeform questions need an LLM on this node' }
    const start = window?.start || new Date().toISOString()
    const end = window?.end || new Date(new Date(start).getTime() + WINDOW_MS).toISOString()
    const events = ctx.observations.eventsIn(to.id, start, end).filter(e => e.data.busy !== false)
    const loc = ctx.observations.latest(to.id, 'location', { within: 3 * 3600e3 })
    const status = ctx.observations.latest(to.id, 'status', { within: 12 * 3600e3 })
    const intents = ctx.observations.recent(to.id, { kinds: ['intent'], since: new Date(Date.now() - 7 * 864e5).toISOString(), limit: 5 })
    const out = await ctx.llm.json({
      system: `You answer a free-form question on behalf of ${to.display_name} to their friend ${from?.display_name || 'a friend'} (tier: ${relationship.tier}). Be honest about uncertainty; you are guessing from signals, not speaking for them.
Reveal only what the relationship allows: tier 'trusted' may hear event titles and current place; 'friend' may hear "has something on" and rough place type; 'acquaintance' only yes/no-ish. Never reveal exact location, coordinates, or private notes. Keep reason under 25 words, phrased for the asker.
Output: { "answer": "yes|likely|unlikely|no|unsupported", "confidence": 0-1, "reason": "...", "revealed": { what you chose to disclose } }`,
      messages: [{ role: 'user', content: JSON.stringify({ question: text, context, window: { start, end }, nowIso: new Date().toISOString(), tz: to.tz,
        calendarInWindow: events.map(e => ({ title: e.data.title, at: e.at, until: e.until, location: e.data.location })),
        latestLocation: loc ? { placeName: loc.data.placeName, ageMin: ctx.geo.minutesAgo(loc.at) } : null,
        status: status?.data, recentIntents: intents.map(i => i.data), relationshipNoteForAnswerer: relationship.note }) }],
    }, { personId: to.id, process: 'query:freeform' })
    return out?.answer ? out : { answer: 'unsupported', confidence: 0.3, reason: 'could not tell' }
  },
}
