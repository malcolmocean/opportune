// Location via HTTP POST. Accepts OwnTracks, Overland, and our own Android app payloads.
// Setup hands the person a URL+token; whichever app they install posts here.
export default {
  id: 'locationPost',
  name: 'Location (phone app)',
  description: 'Your phone posts location here. Works with Overland (iOS), OwnTracks (iOS/Android), or the opportune Android app.',
  repo: 'https://github.com/malcolmocean/opportune/tree/main/sources/locationPost',
  kinds: ['location', 'motion'],
  setup: [
    { key: 'app', type: 'choice', label: 'Which app?', choices: ['opportune Android app', 'Overland (iOS)', 'OwnTracks'], instructions: {
      'opportune Android app': 'Install the APK, open it, paste the URL below.',
      'Overland (iOS)': 'App Store → Overland. Settings → Receiver Endpoint = the URL below. Set "Tracking" on, "Significant location" mode is plenty.',
      'OwnTracks': 'Preferences → Mode: HTTP. URL = the URL below. Leave auth off (the token is in the URL).',
    } },
  ],
  ingest(ctx, person, config, body) {
    const pts = normalize(body)
    const places = ctx.people.places(person.id)
    return pts.map(p => {
      const near = places.find(pl => ctx.geo.distanceM(p, pl) <= (pl.radius_m || 150))
      const out = [{ kind: 'location', at: p.at, data: { lat: p.lat, lng: p.lng, acc: p.acc ?? null, speed: p.speed ?? null, placeId: near?.id || null, placeName: near?.name || null, battery: p.battery ?? null } }]
      if (p.motion) out.push({ kind: 'motion', at: p.at, data: { state: p.motion } })
      return out
    }).flat()
  },
}

// → [{ lat, lng, acc, speed, at, battery, motion }]
function normalize(body) {
  if (!body) return []
  // Overland: { locations: [ GeoJSON Feature { geometry: {coordinates:[lng,lat]}, properties: { timestamp, horizontal_accuracy, speed, motion: [...], battery_level } } ] }
  if (Array.isArray(body.locations)) {
    return body.locations.filter(f => f.geometry?.coordinates).map(f => ({
      lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], acc: f.properties?.horizontal_accuracy, speed: f.properties?.speed,
      at: f.properties?.timestamp || new Date().toISOString(), battery: f.properties?.battery_level,
      motion: motionFrom(f.properties?.motion),
    }))
  }
  // OwnTracks: { _type: 'location', lat, lon, acc, vel, tst (unix s), batt }
  if (body._type === 'location') {
    return [{ lat: body.lat, lng: body.lon, acc: body.acc, speed: body.vel, at: new Date((body.tst || Date.now() / 1000) * 1000).toISOString(), battery: body.batt }]
  }
  // ours / generic: { lat, lng|lon, acc, speed, at|timestamp, motion }
  const one = b => b.lat != null && (b.lng != null || b.lon != null) ? [{ lat: b.lat, lng: b.lng ?? b.lon, acc: b.acc ?? b.accuracy, speed: b.speed, at: b.at || b.timestamp || new Date().toISOString(), battery: b.battery, motion: b.motion }] : []
  return Array.isArray(body) ? body.flatMap(one) : one(body)
}
const motionFrom = arr => { if (!arr?.length) return null; if (arr.includes('driving')) return 'driving'; if (arr.includes('walking') || arr.includes('running')) return 'walking'; if (arr.includes('stationary')) return 'still'; return null }
