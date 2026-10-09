// Someone who is in your phone contacts just joined (bound an email/phone identity).
// Event-driven rather than observation-driven: subscribes in init().
export default {
  id: 'contactJoined',
  name: 'Someone from your contacts joined',
  on: [],
  init(ctx) {
    ctx.events.on('identity:bound', async ({ personId, channel, externalId }) => {
      if (!['email', 'phone'].includes(channel)) return
      const joiner = ctx.people.get(personId)
      if (!joiner || joiner.remote) return
      for (const { ownerId, name } of ctx.people.ownersWithContact(channel, externalId)) {
        if (ownerId === personId) continue
        const owner = ctx.people.get(ownerId)
        if (!owner || ctx.people.rel(ownerId, personId)) continue   // already friends
        await ctx.opportunities.add('contactJoined', {
          kind: 'contactJoined', participants: [ownerId, personId], primary: ownerId,
          summary: `${joiner.display_name}${name && name !== joiner.display_name ? ` (${name} in ${owner.display_name}'s contacts)` : ''} just joined opportune. ${owner.display_name} has them in their contacts but hasn't linked with them.`,
          evidence: [{ kind: 'contact', channel, name }],
          dedupeKey: `contactjoined:${ownerId}:${personId}`,
          expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
        })
      }
    })
  },
}
