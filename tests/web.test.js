import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { buildContext } from '../core/context.js'
import { mountWeb, manageUrl, appUrl, manageToken, personForToken } from '../web/routes.js'

let ctx, server, base, me, friend, shadow, remote, token
const j = async (path, { method = 'GET', body, token: t = token, raw = false } = {}) => {
  const r = await fetch(`${base}${path}`, { method, headers: { ...(t ? { 'x-manage-token': t } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: raw ? await r.text() : await r.json() }
}

before(async () => {
  ctx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '', TELEGRAM_BOT_TOKEN: '', NODE_URL: 'http://node.test' }, { dbPath: ':memory:' })
  const app = express()
  app.use(express.json())
  await mountWeb(app, ctx)
  await new Promise(r => { server = app.listen(0, r) })
  base = `http://127.0.0.1:${server.address().port}`

  me = ctx.people.create({ displayName: 'Jess' })
  friend = ctx.people.create({ displayName: 'Eileen' })
  shadow = ctx.people.create({ displayName: 'Maps Person' })
  remote = ctx.people.create({ displayName: 'Far Away', remote: true, nodeUrl: 'http://other.test' })
  for (const p of [me, friend]) ctx.people.update(p.id, { onboarding: { step: 'done' } })
  ctx.people.update(shadow.id, { onboarding: { step: 'shadow' } })
  ctx.people.setRel(me.id, friend.id, { tier: 'friend', wantMore: true, note: 'lives near GO' })
  ctx.people.setRel(friend.id, me.id, { tier: 'trusted', wantMore: false })
  ctx.people.setRel(me.id, shadow.id, { tier: 'acquaintance', wantMore: true })
  ctx.people.setRel(me.id, remote.id, { tier: 'friend' })
  token = new URL(manageUrl(ctx, me.id)).searchParams.get('token')
})
after(() => server.close())

test('appUrl / manageUrl share one token per person; appUrl takes a screen hash', () => {
  const url = manageUrl(ctx, me.id)
  assert.match(url, /^http:\/\/node\.test\/web\/manage\?token=/)
  assert.equal(manageUrl(ctx, me.id), url)
  assert.equal(manageToken(ctx, me.id), token)
  assert.equal(appUrl(ctx, me.id), `http://node.test/app?token=${token}`)
  assert.equal(appUrl(ctx, me.id, 'review'), `http://node.test/app?token=${token}#review`)
  assert.equal(personForToken(ctx, token).id, me.id)
})

test('the old manage page redirects into the app with the token; the map page is served on app.css', async () => {
  const r = await fetch(`${base}/web/manage?token=${token}`, { redirect: 'manual' })
  assert.equal(r.status, 302)
  assert.equal(r.headers.get('location'), `/app?token=${token}`)
  const bare = await fetch(`${base}/web/manage`, { redirect: 'manual' })
  assert.equal(bare.headers.get('location'), '/app')
  const m = await j('/web/map', { raw: true, token: null })
  assert.equal(m.status, 200)
  assert.match(m.body, /map\.js/)
  assert.match(m.body, /\/web\/app\.css/)
  assert.ok(!m.body.includes('/web/manage'), 'no links back to the removed page')
})

test('api requires a valid token; shadow and remote tokens are refused', async () => {
  assert.equal((await j('/api/manage/me', { token: null })).status, 401)
  assert.equal((await j('/api/manage/me', { token: 'nope' })).status, 401)
  const st = new URL(manageUrl(ctx, shadow.id)).searchParams.get('token')
  assert.equal((await j('/api/manage/me', { token: st })).status, 401)
  const rt = new URL(manageUrl(ctx, remote.id)).searchParams.get('token')
  assert.equal((await j('/api/manage/me', { token: rt })).status, 401)
  // ?token= query also works
  const r = await fetch(`${base}/api/manage/me?token=${token}`)
  assert.equal(r.status, 200)
})

test('the opportune app\'s ingest token authenticates; other sources\' ingest tokens do not', async () => {
  const sc = ctx.sources.connect(me.id, 'opportuneApp', { device: {} })
  const r = await j('/api/manage/me', { token: sc.token })
  assert.equal(r.status, 200)
  assert.equal(r.body.person.id, me.id)
  const other = ctx.sources.connect(me.id, 'locationPost', { app: 'OwnTracks' })
  assert.equal((await j('/api/manage/me', { token: other.token })).status, 401, 'a third-party app token is not manage auth')
  assert.equal(personForToken(ctx, other.token), null)
})

test('GET /me returns friends with both directions, shadow flag, sources, decisions, nudges', async () => {
  const { status, body } = await j('/api/manage/me')
  assert.equal(status, 200)
  assert.equal(body.person.displayName, 'Jess')
  assert.equal(typeof body.person.contactsSynced, 'number')
  assert.equal(body.policy.maxNudgesPerDay, 6)
  const e = body.friends.find(f => f.id === friend.id)
  assert.equal(e.rel.tier, 'friend')
  assert.equal(e.rel.wantMore, true)
  assert.equal(e.rel.note, 'lives near GO')
  assert.equal(e.rel.effectiveGrants.askDropin, true)
  assert.equal(e.theirs.tier, 'trusted')
  assert.equal(e.theirs.effectiveGrants.seeLocationLive, true)
  assert.equal(e.theirs.travel, undefined, 'never leak their travel')
  assert.equal(e.theirs.note, undefined, 'never leak their note')
  assert.equal(e.shadow, false)
  assert.equal(body.friends.find(f => f.id === shadow.id).shadow, true)
  assert.equal(body.friends.find(f => f.id === remote.id).remote, true)
  assert.ok(body.sources.available.some(s => s.id === 'locationPost' && s.setup.length))
  assert.ok(body.sources.connected.some(s => s.sourceId === 'locationPost' && s.ingestUrl.includes('/ingest/locationPost/')))
  assert.ok(Array.isArray(body.decisions) && Array.isArray(body.nudges))
})

test('last location age shows only when they grant seeLocationLive to me', async () => {
  ctx.observations.insert(friend.id, 'test', { kind: 'location', at: new Date(Date.now() - 10 * 60e3).toISOString(), data: { lat: 37.77, lng: -122.43 } })
  ctx.observations.insert(shadow.id, 'test', { kind: 'location', data: { lat: 37.77, lng: -122.43 } })
  const { body } = await j('/api/manage/me')
  const e = body.friends.find(f => f.id === friend.id)
  assert.ok(e.lastLocationAgeMin >= 9 && e.lastLocationAgeMin <= 11)
  assert.equal(body.friends.find(f => f.id === shadow.id).lastLocationAgeMin, null)
})

test('PATCH friend updates tier, wantMore, travel, note, grants, via, vouch', async () => {
  let r = await j(`/api/manage/friends/${friend.id}`, { method: 'PATCH', body: { tier: 'trusted', wantMore: false, travel: 3, note: 'hi', vouch: true, via: { tier: 'friend', openToIntro: true } } })
  assert.equal(r.status, 200)
  assert.equal(r.body.friend.rel.tier, 'trusted')
  assert.equal(r.body.friend.rel.wantMore, false)
  assert.equal(r.body.friend.rel.travel, 3)
  assert.equal(r.body.friend.rel.note, 'hi')
  assert.equal(r.body.friend.rel.vouch, true)
  assert.deepEqual(r.body.friend.rel.via, { tier: 'friend', openToIntro: true })
  assert.equal(r.body.friend.rel.effectiveGrants.seeLocationLive, true)
  // override a grant below the tier default, then reset it with null
  r = await j(`/api/manage/friends/${friend.id}`, { method: 'PATCH', body: { grants: { seeLocationLive: false } } })
  assert.equal(r.body.friend.rel.effectiveGrants.seeLocationLive, false)
  assert.equal(ctx.people.rel(me.id, friend.id).effectiveGrants.seeLocationLive, false)
  r = await j(`/api/manage/friends/${friend.id}`, { method: 'PATCH', body: { grants: { seeLocationLive: null } } })
  assert.equal(r.body.friend.rel.effectiveGrants.seeLocationLive, true)
  assert.deepEqual(r.body.friend.rel.grants, {})
  // the other direction is untouched
  assert.equal(ctx.people.rel(friend.id, me.id).tier, 'trusted')
  assert.equal(ctx.people.rel(friend.id, me.id).want_more, 0)
})

test('PATCH friend validates and scopes', async () => {
  assert.equal((await j(`/api/manage/friends/${friend.id}`, { method: 'PATCH', body: { tier: 'bestie' } })).status, 400)
  assert.equal((await j(`/api/manage/friends/${friend.id}`, { method: 'PATCH', body: { travel: 7 } })).status, 400)
  assert.equal((await j(`/api/manage/friends/${friend.id}`, { method: 'PATCH', body: { grants: { root: true } } })).status, 400)
  assert.equal((await j(`/api/manage/friends/${friend.id}`, { method: 'PATCH', body: {} })).status, 400)
  const stranger = ctx.people.create({ displayName: 'Stranger' })
  assert.equal((await j(`/api/manage/friends/${stranger.id}`, { method: 'PATCH', body: { tier: 'trusted' } })).status, 404)
  assert.equal(ctx.people.rel(me.id, stranger.id), null)
})

test('invite link for a shadow friend', async () => {
  const r = await j(`/api/manage/friends/${shadow.id}/invite-link`, { method: 'POST' })
  assert.equal(r.status, 200)
  assert.match(r.body.url, /^http:\/\/node\.test\/i\//)
  const inv = ctx.people.peekInvite(r.body.code)
  assert.equal(inv.inviter_id, me.id)
  assert.equal(inv.invitee_name, 'Maps Person')
  assert.equal(inv.want_more, 1)
})

test('rate a decision, only my own', async () => {
  const opp = { id: 'opp1', trigger_id: 'test', kind: 'nearby', participants: [me.id, friend.id], primary_id: me.id, summary: 'Jess and Eileen are both near GO', evidence: [], status: 'judged', created_at: new Date().toISOString() }
  ctx.db.insert('opportunities', opp)
  const mine = ctx.judge.record(me.id, opp, 'suppress', 'gate: quiet hours')
  const theirs = ctx.judge.record(friend.id, opp, 'nudge', 'worth it')
  let r = await j(`/api/manage/decisions/${mine.id}/rate`, { method: 'POST', body: { rating: 'good', note: 'yep' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.decision.rating, 'good')
  assert.equal(r.body.decision.ratingNote, 'yep')
  assert.equal(r.body.decision.opportunity.summary, opp.summary)
  assert.equal((await j(`/api/manage/decisions/${theirs.id}/rate`, { method: 'POST', body: { rating: 'bad' } })).status, 404)
  assert.equal((await j(`/api/manage/decisions/${mine.id}/rate`, { method: 'POST', body: { rating: 'meh' } })).status, 400)
  const { body } = await j('/api/manage/me')
  assert.equal(body.decisions[0].id, mine.id)
  assert.equal(body.decisions[0].verdict, 'suppress')
  assert.equal(body.decisions.length, 1)
})

test('PATCH policy merges and validates', async () => {
  let r = await j('/api/manage/policy', { method: 'PATCH', body: { quietHours: { start: 22, end: 7 }, maxNudgesPerDay: 3, dropinDefault: 'open', dropinWindows: [{ days: [1, 2, 2], start: 18, end: 22 }], digestHour: 8 } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.policy.quietHours, { start: 22, end: 7 })
  assert.equal(r.body.policy.maxNudgesPerDay, 3)
  assert.deepEqual(r.body.policy.dropinWindows, [{ days: [1, 2], start: 18, end: 22 }])
  assert.deepEqual(r.body.policy.revealUnprompted, ['status'], 'untouched defaults survive')
  assert.equal(ctx.people.policy(me.id).digestHour, 8)
  assert.equal((await j('/api/manage/policy', { method: 'PATCH', body: { dropinDefault: 'maybe' } })).status, 400)
  assert.equal((await j('/api/manage/policy', { method: 'PATCH', body: { queryRate: { perHour: 999 } } })).status, 400)
  assert.equal((await j('/api/manage/policy', { method: 'PATCH', body: { quietHours: { start: 25, end: 7 } } })).status, 400)
})

test('POST sources connects and returns the ingest url; setup parse() is applied', async () => {
  let r = await j('/api/manage/sources', { method: 'POST', body: { sourceId: 'icsCalendar', config: { urls: 'https://a.test/x.ics https://b.test/y.ics' } } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.config.urls, ['https://a.test/x.ics', 'https://b.test/y.ics'])
  assert.equal(r.body.ingestUrl, null)
  r = await j('/api/manage/sources', { method: 'POST', body: { sourceId: 'locationPost', config: { app: 'Overland (iOS)' } } })
  assert.equal(r.status, 200)
  assert.match(r.body.ingestUrl, /^http:\/\/node\.test\/ingest\/locationPost\//)
  assert.equal((await j('/api/manage/sources', { method: 'POST', body: { sourceId: 'locationPost', config: { app: 'Pigeon' } } })).status, 400)
  assert.equal((await j('/api/manage/sources', { method: 'POST', body: { sourceId: 'nope' } })).status, 404)
})

test('POST sources again with a blank secret keeps the stored one (the form shows "unchanged"); other fields are replaced', async () => {
  let r = await j('/api/manage/sources', { method: 'POST', body: { sourceId: 'gmailRsvp', config: { email: 'jess@gmail.com', appPassword: 'abcd efgh', since: '10' } } })
  assert.equal(r.status, 200)
  assert.equal(r.body.config.appPassword, '••••••', 'redacted on the way out')
  const stored = () => ctx.sources.forPerson(me.id).find(s => s.source_id === 'gmailRsvp').config
  assert.equal(stored().appPassword, 'abcdefgh')
  r = await j('/api/manage/sources', { method: 'POST', body: { sourceId: 'gmailRsvp', config: { email: 'jess2@gmail.com', appPassword: '' } } })
  assert.equal(r.status, 200)
  assert.equal(stored().appPassword, 'abcdefgh', 'blank secret = unchanged')
  assert.equal(stored().email, 'jess2@gmail.com')
  assert.equal(stored().since, undefined, 'a blank optional non-secret is cleared')
  r = await j('/api/manage/sources', { method: 'POST', body: { sourceId: 'gmailRsvp', config: { email: 'jess2@gmail.com', appPassword: 'new one' } } })
  assert.equal(stored().appPassword, 'newone')
})

test('GET /map lists only friends who grant seeLocationLive to me, with fresh locations', async () => {
  ctx.observations.insert(me.id, 'test', { kind: 'location', data: { lat: 37.76, lng: -122.42 } })
  let { body } = await j('/api/manage/map')
  assert.equal(body.me.location.lat, 37.76)
  assert.deepEqual(body.friends.map(f => f.id), [friend.id])
  assert.equal(body.friends[0].displayName, 'Eileen')
  assert.ok(body.friends[0].ageMin >= 9)
  // they drop me to 'friend' → no live location grant → gone from the map
  ctx.people.setRel(friend.id, me.id, { tier: 'friend' })
  body = (await j('/api/manage/map')).body
  assert.deepEqual(body.friends, [])
  // stale location (> 3h) is not shown even with the grant
  ctx.people.setRel(friend.id, me.id, { tier: 'trusted' })
  ctx.db.run('update observations set at = ? where person_id = ?', new Date(Date.now() - 4 * 3600e3).toISOString(), friend.id)
  body = (await j('/api/manage/map')).body
  assert.deepEqual(body.friends, [])
})
