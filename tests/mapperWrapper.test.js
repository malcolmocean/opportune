import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'
import { SOURCE_ID, toContact } from '../sources/mapperWrapper/index.js'
import { resolveContact } from '../sources/mapsSharing/index.js'

const HOME = { lat: 37.7745, lng: -122.4365 }

async function setup() {
  const ctx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '' }, { dbPath: ':memory:' })
  const mal = ctx.people.create({ displayName: 'Malcolm' })
  ctx.people.update(mal.id, { onboarding: { step: 'done' } })
  ctx.people.addPlace(mal.id, { name: 'home', ...HOME, radiusM: 120 })
  const jess = ctx.people.create({ displayName: 'Jess' })
  ctx.people.setRel(mal.id, jess.id, { tier: 'friend', wantMore: true })
  const sc = ctx.sources.connect(mal.id, SOURCE_ID, {})
  return { ctx, mal, jess, sc }
}

// shaped like MapperWrapper's fetchLocations() people
const person = (id, fullName, pt, ts, extra = {}) => ({
  id, photoUrl: `https://example.com/${id}.jpg`, fullName, nickname: fullName.split(' ')[0], isSelf: false,
  latitude: pt.lat, longitude: pt.lng, timestampMs: ts, accuracyMeters: 15, address: '1 Some St', countryCode: 'US',
  batteryCharging: true, batteryLevel: 64, ...extra,
})
const self = (pt, ts) => ({ id: 'self', photoUrl: null, fullName: 'You', nickname: 'You', isSelf: true, latitude: pt.lat, longitude: pt.lng, timestampMs: ts, accuracyMeters: 10, batteryCharging: null, batteryLevel: null })
const body = people => ({ source: 'mapperwrapper', profile: 'default', at: new Date().toISOString(), people })

test('a push ingests contacts under their people and the self fix under the owner, deduped on repeat', async () => {
  const { ctx, mal, jess, sc } = await setup()
  const ts = Date.now() - 60e3
  const payload = body([self(HOME, ts), person('g1', 'Jess', HOME, ts), person('g2', 'Sam Who', { lat: 1, lng: 2 }, ts)])

  const inserted = await ctx.sources.ingest(SOURCE_ID, sc.token, payload)
  assert.equal(inserted.length, 1, 'the owner fix is what core ingests')
  const own = ctx.observations.latest(mal.id, 'location')
  assert.equal(own.source_id, SOURCE_ID)
  assert.equal(own.data.placeName, 'home')

  const j = ctx.observations.latest(jess.id, 'location')
  assert.equal(j.source_id, SOURCE_ID)
  assert.equal(j.data.battery, 64)
  assert.equal(j.data.charging, true)
  assert.equal(j.at, new Date(ts).toISOString())

  const sam = resolveContact(ctx, mal, { id: 'g2', fullName: 'Sam Who' })
  assert.equal(sam.created, false, 'shadow person made on first push, remembered by google id')
  assert.equal(ctx.observations.latest(sam.person.id, 'location').data.lat, 1)

  assert.equal((await ctx.sources.ingest(SOURCE_ID, sc.token, payload)).length, 0, 'same fix twice is skipped')
})

test('bad token is rejected; empty or odd bodies ingest nothing', async () => {
  const { ctx, sc } = await setup()
  await assert.rejects(ctx.sources.ingest(SOURCE_ID, 'nope', body([])), /bad token/)
  assert.equal((await ctx.sources.ingest(SOURCE_ID, sc.token, {})).length, 0)
  assert.equal((await ctx.sources.ingest(SOURCE_ID, sc.token, body([person('g3', 'No Fix', { lat: null, lng: null }, null)]))).length, 0)
})

test('toContact maps MapperWrapper fields to the mapsSharing contact shape', () => {
  const c = toContact(person('g1', 'Jess Q', HOME, 5))
  assert.deepEqual(
    { id: c.id, lat: c.lat, lng: c.lng, acc: c.acc, timestamp: c.timestamp, pictureUrl: c.pictureUrl, battery: c.battery, charging: c.charging, isSelf: c.isSelf },
    { id: 'g1', lat: HOME.lat, lng: HOME.lng, acc: 15, timestamp: 5, pictureUrl: 'https://example.com/g1.jpg', battery: 64, charging: true, isSelf: false },
  )
})
