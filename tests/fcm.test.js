import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'
import fcm, { handleAppPayload } from '../channels/fcm/index.js'

const setup = async () => {
  const ctx = await buildContext({ ...process.env, FIREBASE_SERVICE_ACCOUNT_JSON: '' }, { dbPath: ':memory:' })
  const p = ctx.people.create({ displayName: 'Jess' })
  const sc = ctx.sources.connect(p.id, 'opportuneApp', {})
  return { ctx, p, sc }
}

test('plugins load: fcm channel and opportuneApp source', async () => {
  const { ctx } = await setup()
  assert.equal(ctx.plugins.channels.fcm.id, 'fcm')
  assert.equal(ctx.plugins.sources.opportuneApp.id, 'opportuneApp')
  assert.deepEqual(ctx.plugins.sources.opportuneApp.kinds, ['location', 'motion', 'status'])
  assert.equal(ctx.plugins.sources.opportuneApp.setup[0].type, 'install-app')
})

test('start without creds warns and leaves send() throwing so nudges fall through', async () => {
  const { ctx, p } = await setup()
  const warns = []
  const log = ctx.log
  ctx.log = n => ({ ...log(n), warn: (...a) => warns.push(a.join(' ')) })
  await fcm.start(ctx)
  assert.ok(warns.some(w => w.includes('FIREBASE_SERVICE_ACCOUNT_JSON')))
  fcm.__setMessaging(null)
  await assert.rejects(() => fcm.send(ctx, p, { external_id: 'tok' }, { id: 'n1', text: 'hi', actions: [] }), /not started/)
})

test('ingest URL is /ingest/opportuneApp/<token>', async () => {
  const { ctx, sc } = await setup()
  assert.match(ctx.sources.ingestUrl(sc), /\/ingest\/opportuneApp\/[A-Za-z0-9_-]+$/)
})

test('{ fcmToken } binds an fcm identity with device meta', async () => {
  const { ctx, p, sc } = await setup()
  const inserted = await ctx.sources.ingest('opportuneApp', sc.token, { fcmToken: 'tok-123', device: { model: 'Pixel 8', android: 14 } })
  assert.equal(inserted.length, 0)
  const ids = ctx.people.identities(p.id)
  assert.deepEqual(ids.map(i => [i.channel, i.external_id]), [['fcm', 'tok-123']])
  assert.equal(ids[0].meta.device.model, 'Pixel 8')
  assert.equal(ctx.people.identify('fcm', 'tok-123').id, p.id)
})

test('location batches normalize like locationPost (location + motion)', async () => {
  const { ctx, p, sc } = await setup()
  ctx.people.addPlace(p.id, { name: 'home', lat: 37.7745, lng: -122.4365, radiusM: 120 })
  const at = '2026-10-08T20:00:00.000Z'
  const inserted = await ctx.sources.ingest('opportuneApp', sc.token, [
    { lat: 37.7745, lng: -122.4365, acc: 12, speed: 0, at, battery: 0.8, motion: 'still' },
    { lat: 37.76, lng: -122.43, acc: 30, at: '2026-10-08T20:05:00.000Z' },
  ])
  assert.equal(inserted.length, 3)
  const loc = inserted.find(o => o.kind === 'location' && o.at === at)
  assert.equal(loc.data.placeName, 'home')
  assert.equal(loc.data.battery, 0.8)
  assert.deepEqual(inserted.find(o => o.kind === 'motion').data, { state: 'still' })
  assert.equal(ctx.observations.latest(p.id, 'location').source_id, 'opportuneApp')
  // single object works too
  assert.equal((await ctx.sources.ingest('opportuneApp', sc.token, { lat: 1, lng: 2 })).length, 1)
})

test('{ status: { porchlight } } → status observation valid ~6h', async () => {
  const { ctx, p, sc } = await setup()
  const before = Date.now()
  const inserted = await ctx.sources.ingest('opportuneApp', sc.token, { status: { porchlight: 'open' } })
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].kind, 'status')
  assert.deepEqual(inserted[0].data, { porchlight: 'open', note: null })
  const until = new Date(inserted[0].until).getTime() - before
  assert.ok(until > 5.9 * 3600e3 && until < 6.1 * 3600e3)
  assert.equal(ctx.observations.latest(p.id, 'status').data.porchlight, 'open')
  // junk values are ignored
  assert.equal((await ctx.sources.ingest('opportuneApp', sc.token, { status: { porchlight: 'party' } })).length, 0)
})

test('{ nudgeResponse } records the response and rates the decision', async () => {
  const { ctx, p, sc } = await setup()
  const n = await ctx.nudges.send(p.id, { text: 'Eileen is home and open, a block away. Drop in?', actions: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] })
  assert.equal(n.channel, null)   // no channel bound yet
  const events = []
  ctx.events.on('nudge:response', e => events.push(e))
  const inserted = await ctx.sources.ingest('opportuneApp', sc.token, { nudgeResponse: { nudgeId: n.id, key: 'yes' } })
  assert.equal(inserted.length, 0)
  assert.equal(ctx.nudges.get(n.id).response, 'yes')
  assert.equal(events[0].actionKey, 'yes')
  // unknown nudge ids are a no-op, not an error
  assert.equal((await ctx.sources.ingest('opportuneApp', sc.token, { nudgeResponse: { nudgeId: 'nope', key: 'yes' } })).length, 0)
})

test('wish:<decisionId> ("should have told me") rates the suppression bad', async () => {
  const { ctx, p } = await setup()
  const rated = []
  ctx.judge.rate = (id, r, note) => rated.push([id, r, note])
  await handleAppPayload(ctx, p, { nudgeResponse: { nudgeId: 'x', key: 'wish:dec1' } })
  assert.deepEqual(rated[0].slice(0, 2), ['dec1', 'bad'])
  assert.match(rated[0][2], /should have nudged/)
})

test('{ contacts } → ctx.people.addContacts', async () => {
  const { ctx, p, sc } = await setup()
  const inserted = await ctx.sources.ingest('opportuneApp', sc.token, { contacts: [{ name: 'Eileen', emails: ['Eileen@Example.com'], phones: ['(415) 555-0100'] }, { name: 'Nobody' }] })
  assert.equal(inserted.length, 0)
  assert.equal(ctx.people.contactName(p.id, { email: 'eileen@example.com' }), 'Eileen')
  assert.equal(ctx.people.ownersWithContact('email', 'eileen@example.com')[0].ownerId, p.id)
})

test('nudges.send prefers fcm once bound and sends a data message', async () => {
  const { ctx, p, sc } = await setup()
  await ctx.sources.ingest('opportuneApp', sc.token, { fcmToken: 'tok-abc' })
  const sent = []
  fcm.__setMessaging({ async send(m) { sent.push(m); return 'projects/x/messages/123' } })
  try {
    const n = await ctx.nudges.send(p.id, { text: 'Jess is at Grocery Outlet', actions: [{ key: 'yes', label: 'Go say hi' }, { key: 'no', label: 'Not now' }] })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].token, 'tok-abc')
    assert.equal(sent[0].data.nudgeId, n.id)
    assert.equal(sent[0].data.text, 'Jess is at Grocery Outlet')
    const actions = JSON.parse(sent[0].data.actions)
    assert.deepEqual(actions.map(a => a.key), ['yes', 'no', 'bad'])   // core appends the "shouldn't have bugged me" action
    assert.ok(actions.every(a => typeof a.label === 'string'))
    assert.equal(sent[0].android.priority, 'high')
    const row = ctx.nudges.get(n.id)
    assert.equal(row.channel, 'fcm')
    assert.equal(row.external_id, 'projects/x/messages/123')
  } finally { fcm.__setMessaging(null) }
})

test('a dead token is unbound so later nudges skip fcm', async () => {
  const { ctx, p, sc } = await setup()
  await ctx.sources.ingest('opportuneApp', sc.token, { fcmToken: 'tok-dead' })
  fcm.__setMessaging({ async send() { throw Object.assign(new Error('gone'), { code: 'messaging/registration-token-not-registered' }) } })
  try {
    const n = await ctx.nudges.send(p.id, { text: 'x', actions: [] })
    assert.equal(ctx.nudges.get(n.id).channel, null)
    assert.equal(ctx.people.identities(p.id).length, 0)
  } finally { fcm.__setMessaging(null) }
})
