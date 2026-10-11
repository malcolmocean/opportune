// Two people on the system are physically close and both recent. Deterministic; the Judge decides if it's worth a buzz.
// One opportunity per recipient: the other person's place name appears in a recipient's summary/evidence only when
// that person grants the recipient askWhereabouts (their edge toward the recipient). Distance alone is always fine.
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
    for (const f of ctx.people.connections(person.id)) {   // either direction, so a shadow (Maps contact) moving near me counts too
      const theirs = ctx.observations.latest(f.id, 'location', { within: FRESH_MS })
      if (!theirs?.data?.lat) continue
      const d = ctx.geo.distanceM(me, theirs.data)
      if (d > this.radiusM) continue
      // someone at home + the other nearby is porchlightProximity's job (drop-in flow); both home is not news
      if (me.placeName === 'home' || theirs.data.placeName === 'home') continue
      const hourKey = new Date().toISOString().slice(0, 13)
      const sides = [{ p: person, loc: { at: o.at, data: me } }, { p: f, loc: theirs }]
      for (const [i, side] of sides.entries()) {
        const other = sides[1 - i]
        const canSeePlace = !!ctx.people.rel(other.p.id, side.p.id)?.effectiveGrants?.askWhereabouts
        const otherPlace = canSeePlace ? other.loc.data.placeName || null : null
        const myPlace = side.loc.data.placeName || null
        out.push({
          kind: 'nearby', participants: [side.p.id, other.p.id], primary: side.p.id,
          summary: `${side.p.display_name} and ${other.p.display_name} are ${ctx.geo.fmtDistance(d)} apart right now${otherPlace ? ` (${other.p.display_name} is at ${otherPlace})` : ''}${myPlace ? ` (${side.p.display_name} is at ${myPlace})` : ''}.`,
          evidence: [
            { kind: 'location', who: side.p.id, at: side.loc.at, placeName: myPlace, ageMin: ctx.geo.minutesAgo(side.loc.at) },
            { kind: 'location', who: other.p.id, at: other.loc.at, placeName: otherPlace, ageMin: ctx.geo.minutesAgo(other.loc.at) },
          ],
          dedupeKey: `nearby:${[person.id, f.id].sort().join(':')}:${side.p.id}:${hourKey}`,
          expiresAt: new Date(Date.now() + 45 * 60e3).toISOString(),
        })
      }
    }
    return out
  },
}
