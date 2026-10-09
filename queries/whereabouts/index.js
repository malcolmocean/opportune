// "Where is X / is X near Y?" Reveals place name + distance band under askWhereabouts, exact coords only under seeLocationLive.
export default {
  id: 'whereabouts', kind: 'whereabouts', sensitivity: 4, grant: 'askWhereabouts',
  description: 'Rough whereabouts (named place, distance from asker). Exact coordinates only with seeLocationLive.',
  answer(ctx, { from, to, relationship, context }) {
    const loc = ctx.observations.latest(to.id, 'location', { within: 2 * 3600e3 })
    if (!loc) return { answer: 'unsupported', confidence: 0.3, reason: 'no recent location', suggest: { plugin: 'sources/locationPost', setup: 'install a location app' } }
    const mine = from ? ctx.observations.latest(from.id, 'location', { within: 2 * 3600e3 }) : null
    const d = mine ? ctx.geo.distanceM(mine.data, loc.data) : null
    const revealed = { placeName: loc.data.placeName || null, ageMin: ctx.geo.minutesAgo(loc.at), distanceBand: d == null ? null : d < 500 ? 'very close' : d < 2000 ? 'nearby' : d < 10000 ? 'same area' : 'far' }
    if (relationship.effectiveGrants.seeLocationLive) revealed.coords = { lat: loc.data.lat, lng: loc.data.lng, distanceM: d }
    return { answer: d != null && d < 2000 ? 'yes' : 'no', confidence: 0.8, reason: revealed.placeName ? `at ${revealed.placeName}` : revealed.distanceBand || 'known', revealed }
  },
}
