// The user-facing app: GET /app, POST /api/app/session, POST /api/app/friends/:id/dropin (web/routes.js).
// /api/app/state and /app/register|claim live in server.js and are covered by their own tests.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import express from 'express'
import { buildContext } from '../core/context.js'
import { mountWeb, manageUrl } from '../web/routes.js'

let ctx, server, base, me, friend, stranger, token
const j = async (path, { method = 'GET', body, token: t = token, raw = false } = {}) => {
  const r = await fetch(`${base}${path}`, { method, headers: { ...(t ? { 'x-manage-token': t } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: raw ? await r.text() : await r.json() }
}
const HOME = { lat: 37.7745, lng: -122.4365 }

before(async () => {
  ctx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '', TELEGRAM_BOT_TOKEN: '', NODE_URL: 'http://node.test' }, { dbPath: ':memory:' })
  const app = express()
  app.use(express.json())
  app.use('/web', express.static('web'))
  await mountWeb(app, ctx)
  await new Promise(r => { server = app.listen(0, r) })
  base = `http://127.0.0.1:${server.address().port}`

  me = ctx.people.create({ displayName: 'Jess' })
  friend = ctx.people.create({ displayName: 'Eileen' })
  stranger = ctx.people.create({ displayName: 'Nobody' })
  for (const p of [me, friend, stranger]) ctx.people.update(p.id, { onboarding: { step: 'done' } })
  ctx.people.setRel(me.id, friend.id, { tier: 'friend', wantMore: true })
  ctx.people.setRel(friend.id, me.id, { tier: 'friend', wantMore: true })
  ctx.people.addPlace(friend.id, { name: 'home', ...HOME, radiusM: 120 })
  ctx.sources.connect(friend.id, 'locationPost', { app: 'OwnTracks' })
  await ctx.observations.ingest(friend.id, 'test', [{ kind: 'location', data: { ...HOME, placeName: 'home' } }])
  token = new URL(manageUrl(ctx, me.id)).searchParams.get('token')
})
after(() => server.close())

test('GET /app serves the app shell; its scripts parse', async () => {
  const r = await j('/app', { raw: true, token: null })
  assert.equal(r.status, 200)
  assert.match(r.body, /<title>opportune<\/title>/)
  assert.match(r.body, /\/web\/app\.webmanifest/)
  assert.match(r.body, /\/web\/app\.js/)
  assert.match(r.body, /theme-color" content="#090b22"/)
  for (const f of ['web/app.js', 'web/app/bridge.js', 'web/app/lantern.js']) execFileSync(process.execPath, ['--check', f])
  const manifest = JSON.parse(readFileSync('web/app.webmanifest', 'utf8'))
  assert.equal(manifest.start_url, '/app')
  assert.equal(manifest.theme_color, '#090b22')
  assert.ok(manifest.icons.some(i => i.src === '/web/icon.png'))
  assert.equal((await j('/web/app.css', { raw: true, token: null })).status, 200)
})

test('POST /api/app/session needs a token and gives the app its ingest URL (connecting the app source once)', async () => {
  assert.equal((await j('/api/app/session', { method: 'POST', token: null })).status, 401)
  assert.equal((await j('/api/app/session', { method: 'POST', token: 'nope' })).status, 401)
  assert.equal(ctx.sources.forPerson(me.id).filter(s => s.source_id === 'opportuneApp').length, 0, 'Telegram-first person has no app source yet')
  const r = await j('/api/app/session', { method: 'POST', body: { device: { model: 'test' } } })
  assert.equal(r.status, 200)
  assert.equal(r.body.me.id, me.id)
  assert.equal(r.body.me.displayName, 'Jess')
  assert.match(r.body.ingestUrl, /^http:\/\/node\.test\/ingest\/opportuneApp\/[A-Za-z0-9_-]+$/)
  assert.match(r.body.manageUrl, /^http:\/\/node\.test\/web\/manage\?token=/)
  assert.equal(r.body.telegramLinked, false)
  assert.equal(r.body.telegramLink, null, 'no bot configured in tests')
  assert.equal(r.body.pushBound, false)
  assert.equal(r.body.locationPostUrl, null)
  assert.equal(typeof r.body.contactsSynced, 'number')
  // idempotent: the same source, the same URL
  const again = await j('/api/app/session', { method: 'POST' })
  assert.equal(again.body.ingestUrl, r.body.ingestUrl)
  assert.equal(ctx.sources.forPerson(me.id).filter(s => s.source_id === 'opportuneApp').length, 1)
  // the source token (what the app keeps) authenticates the same person
  const srcToken = r.body.ingestUrl.split('/').pop()
  assert.equal((await j('/api/app/session', { method: 'POST', token: srcToken })).body.me.id, me.id)
  // a location source shows up as locationPostUrl, for Overland users
  ctx.sources.connect(me.id, 'locationPost', { app: 'Overland (iOS)' })
  assert.match((await j('/api/app/session', { method: 'POST' })).body.locationPostUrl, /\/ingest\/locationPost\//)
})

test('POST /api/app/friends/:id/dropin asks their agent and relays the structured answer', async () => {
  assert.equal((await j(`/api/app/friends/${friend.id}/dropin`, { method: 'POST', token: null })).status, 401)
  assert.equal((await j(`/api/app/friends/${stranger.id}/dropin`, { method: 'POST' })).status, 404)
  assert.equal((await j('/api/app/friends/nope/dropin', { method: 'POST' })).status, 404)

  const until = hours => new Date(Date.now() + hours * 3600e3).toISOString()
  await ctx.observations.ingest(friend.id, 'test', [{ kind: 'status', until: until(2), data: { porchlight: 'open', note: 'back door' } }])
  let r = await j(`/api/app/friends/${friend.id}/dropin`, { method: 'POST', body: { text: 'heading over now' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.friend.name, 'Eileen')
  assert.equal(r.body.answer, 'yes')
  assert.equal(r.body.reason, 'porchlight is open')
  assert.equal(r.body.revealed.presence, 'home')
  assert.ok(!JSON.stringify(r.body).includes('"lat"'), 'never leaks coordinates')
  const logged = ctx.db.get('select * from query_log where from_id = ? and to_id = ? order by created_at desc', me.id, friend.id)
  assert.equal(logged.kind, 'dropin')
  assert.equal(logged.text, 'heading over now')

  await ctx.observations.ingest(friend.id, 'test', [{ kind: 'status', until: until(2), data: { porchlight: 'closed' } }])
  r = await j(`/api/app/friends/${friend.id}/dropin`, { method: 'POST' })
  assert.equal(r.body.answer, 'no')

  // they revoke askDropin → their agent says no, and we say so without a 404 (still a friend)
  ctx.people.setRel(friend.id, me.id, { grants: { askDropin: false } })
  r = await j(`/api/app/friends/${friend.id}/dropin`, { method: 'POST' })
  assert.equal(r.status, 200)
  assert.equal(r.body.answer, 'no')
  assert.equal(r.body.reason, 'not permitted')
})
