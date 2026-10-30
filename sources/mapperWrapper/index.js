// Google Maps location sharing, pushed in by MapperWrapper (github.com/malcolmocean/mapperwrapper).
// Same data as sources/mapsSharing, but the Google session lives on the owner's own always-on
// machine (a residential IP, signed in through a real browser window) instead of pasted cookies
// on this node. MapperWrapper POSTs { source: 'mapperwrapper', profile, at, people[] } to this
// source's ingest URL every few minutes; the secret token in that URL is the only credential.
//
// Contacts go through mapsSharing's ingestContacts, so friend matching, shadow people and the
// google id → person map are shared: switching an owner from mapsSharing to this keeps their people.
import { ingestContacts, ownerObservations } from '../mapsSharing/index.js'

export const SOURCE_ID = 'mapperWrapper'

export default {
  id: SOURCE_ID,
  name: 'Google Maps location sharing (MapperWrapper)',
  description: 'Friends who already share their Google Maps location with you show up here with live location. Your own always-on computer runs MapperWrapper, signed into your Google account, and pushes to this node every 5 minutes. No cookies to paste.',
  repo: 'https://github.com/malcolmocean/opportune/tree/main/sources/mapperWrapper',
  kinds: ['location'],
  setup: [],

  async ingest(ctx, owner, config, body) {
    const people = Array.isArray(body?.people) ? body.people : []
    const contacts = people.map(toContact)
    const me = contacts.find(c => c.isSelf) || null
    const r = await ingestContacts(ctx, owner, contacts.filter(c => !c.isSelf), SOURCE_ID)
    const L = ctx.log(SOURCE_ID)
    if (r.created.length) L.info(`new shadow people for ${owner.display_name}: ${r.created.join(', ')}`)
    L.debug(`${owner.display_name}: ${people.length} people, ${r.ingested} new, ${r.skipped} unchanged`)
    return ownerObservations(ctx, owner, me)
  },
}

// MapperWrapper's person → the contact shape mapsSharing uses.
export function toContact(p) {
  return {
    id: p.id,
    isSelf: !!p.isSelf,
    fullName: p.fullName,
    nickname: p.nickname,
    pictureUrl: p.photoUrl ?? null,
    lat: p.latitude,
    lng: p.longitude,
    acc: p.accuracyMeters ?? null,
    timestamp: p.timestampMs ?? null,
    address: p.address ?? null,
    countryCode: p.countryCode ?? null,
    battery: p.batteryLevel ?? null,
    charging: p.batteryCharging ?? null,
  }
}
