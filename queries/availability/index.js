// "Free this evening?" Answered from calendar + location + stated intents, under policy.
// Returns structured answer so fan-outs can rank without an LLM; the LLM only phrases/judges.
export default {
  id: 'availability', kind: 'availability', sensitivity: 1, grant: 'askAvailability',
  description: 'Is this person plausibly free during a window? Answers yes/likely/unlikely/no with a short, policy-safe reason.',
  async answer(ctx, { from, to, relationship, text, window, context }) {
    const start = window?.start || new Date().toISOString()
    const end = window?.end || new Date(new Date(start).getTime() + 4 * 3600e3).toISOString()
    const events = ctx.observations.eventsIn(to.id, start, end).filter(e => e.data.busy !== false)
    const loc = ctx.observations.latest(to.id, 'location', { within: 3 * 3600e3 })
    const status = ctx.observations.latest(to.id, 'status', { within: 12 * 3600e3 })
    const intents = ctx.observations.recent(to.id, { kinds: ['intent'], since: new Date(Date.now() - 7 * 864e5).toISOString(), limit: 5 })
    const nothingKnown = !events.length && !loc && !status && !ctx.sources.forPerson(to.id).length
    if (nothingKnown) return { answer: 'unsupported', confidence: 0.2, reason: 'no sources connected', suggest: { plugin: 'sources/icsCalendar', setup: 'paste an ICS link' } }
    if (!ctx.llm.enabled) {
      const busy = events.length > 0
      return { answer: busy ? 'unlikely' : 'likely', confidence: 0.5, reason: busy ? `has ${events.length} thing(s) on` : 'nothing on the calendar', revealed: {} }
    }
    const out = await ctx.llm.json({
      system: `You answer on behalf of ${to.display_name} to their friend ${from?.display_name || 'a friend'} (tier: ${relationship.tier}). Decide if ${to.display_name} is plausibly available for what's asked, in the window. Be honest about uncertainty.
Reveal only what the relationship allows: tier 'trusted' may hear event titles and current place; 'friend' may hear "has something on" and rough place type; 'acquaintance' only yes/no-ish. Never reveal exact location or private notes. Keep reason under 20 words, phrased for the asker.
Output: { "answer": "yes|likely|unlikely|no", "confidence": 0-1, "reason": "...", "revealed": { what you chose to disclose } }`,
      messages: [{ role: 'user', content: JSON.stringify({ question: text, context, window: { start, end }, nowIso: new Date().toISOString(), tz: to.tz, calendarInWindow: events.map(e => ({ title: e.data.title, at: e.at, until: e.until, location: e.data.location })), latestLocation: loc ? { placeName: loc.data.placeName, ageMin: ctx.geo.minutesAgo(loc.at) } : null, status: status?.data, recentIntents: intents.map(i => i.data), relationshipNoteForAnswerer: relationship.note }) }],
    })
    return out?.answer ? out : { answer: 'unlikely', confidence: 0.3, reason: 'could not tell' }
  },
}
