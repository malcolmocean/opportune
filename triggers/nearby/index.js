// Two people on the system are physically close and both recent. Deterministic; the Judge decides if it's worth a buzz.
const FRESH_MS = 40 * 60e3
export default {
  id: 'nearby',
  name: 'Friend nearby',
  on: ['location'],
  radiusM: 600,
  run(ctx, { observation: o, person }) {
    const me = o.data
    if (!me?.lat) return []
    const out = []
    for (const f of ctx.people.friendsOf(person.id)) {
      const theirs = ctx.observations.latest(f.id, 'location', { within: FRESH_MS })
      if (!theirs?.data?.lat) continue
      const d = ctx.geo.distanceM(me, theirs.data)
      if (d > this.radiusM) continue
      // someone at home + the other nearby is porchlightProximity's job (drop-in flow); both home is not news
      if (me.placeName === 'home' || theirs.data.placeName === 'home') continue
      const hourKey = new Date().toISOString().slice(0, 13)
      out.push({
        kind: 'nearby', participants: [person.id, f.id], primary: null,   // tell both; judge decides each side
        summary: `${person.display_name} and ${f.display_name} are ${ctx.geo.fmtDistance(d)} apart right now${theirs.data.placeName ? ` (${f.display_name} is at ${theirs.data.placeName})` : ''}${me.placeName ? ` (${person.display_name} is at ${me.placeName})` : ''}.`,
        evidence: [{ kind: 'location', who: person.id, at: o.at, placeName: me.placeName }, { kind: 'location', who: f.id, at: theirs.at, placeName: theirs.data.placeName, ageMin: ctx.geo.minutesAgo(theirs.at) }],
        dedupeKey: `nearby:${[person.id, f.id].sort().join(':')}:${hourKey}`,
        expiresAt: new Date(Date.now() + 45 * 60e3).toISOString(),
      })
    }
    return out
  },
}
