// channels/email: magic-link sign-in (POST /app/email/request → /app/claim), address verification
// (POST /api/app/email → GET /app/email/verify/:code), nudges by mail, and the disabled state.
// /app/claim lives in server.js (which listens on boot), so its lookup is mirrored here as claim().
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { buildContext } from '../core/context.js'
import { manageUrl } from '../web/routes.js'
import emailChannel, { mountEmail, limiter } from '../channels/email/index.js'

const realFetch = globalThis.fetch
let ctx, server, base, mal, jess, sent
const api = async (path, { method = 'POST', body, token, redirect = 'manual' } = {}) => {
  const r = await realFetch(`${base}${path}`, { method, redirect, headers: { ...(token ? { 'x-manage-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let json = null; try { json = JSON.parse(text) } catch {}
  return { status: r.status, body: json, text, location: r.headers.get('location') }
}
// mirror of POST /app/claim in server.js: one use, expiry honoured, returns the person whose app credential the code unlocks
const claim = code => {
  const rec = ctx.db.kvGet(`applink:${code}`)
  const sc = rec && ctx.sources.get(rec.id)
  if (!sc || (rec.exp && rec.exp < Date.now())) return null
  ctx.db.kvSet(`applink:${code}`, null)
  return ctx.people.get(sc.person_id)
}
const codeIn = (text, re) => { const m = text.match(re); assert.ok(m, `no link in: ${text}`); return m[1] }

before(async () => {
  ctx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '', TELEGRAM_BOT_TOKEN: '', NODE_URL: 'http://node.test', RESEND_API_KEY: 're_test_123', EMAIL_FROM: 'opportune <hello@opportune.test>' }, { dbPath: ':memory:' })
  const app = express()
  app.use(express.json())
  mountEmail(app, ctx)
  await new Promise(r => { server = app.listen(0, r) })
  base = `http://127.0.0.1:${server.address().port}`
  mal = ctx.people.create({ displayName: 'Mal' })
  jess = ctx.people.create({ displayName: 'Jess' })
  for (const p of [mal, jess]) ctx.people.update(p.id, { onboarding: { step: 'done' } })
  ctx.people.bind(mal.id, 'email', 'Mal@Example.com')   // bound during Telegram onboarding; stored normalized
  // stub Resend: capture every call, answer like the API does
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.resend.com/')) return realFetch(url, init)
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ id: `em_${sent.length}` }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
})
after(() => { server.close(); globalThis.fetch = realFetch })
beforeEach(() => { sent = []; limiter.reset() })

test('manifest: a channel the loader picks up', () => {
  assert.equal(emailChannel.id, 'email')
  assert.equal(ctx.plugins.channels.email?.id, 'email')
  assert.equal(typeof emailChannel.start, 'function')
  assert.equal(typeof emailChannel.send, 'function')
})

test('unknown address: 200 and no email (no account enumeration)', async () => {
  const r = await api('/app/email/request', { body: { email: 'nobody@example.com' } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true })
  assert.equal(sent.length, 0)
  assert.equal((await api('/app/email/request', { body: { email: 'not an email' } })).status, 400)
  assert.equal((await api('/app/email/request', { body: {} })).status, 400)
})

test('known address: one email through Resend with a claim link that /app/claim accepts once', async () => {
  const r = await api('/app/email/request', { body: { email: '  MAL@example.com ' } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true })
  assert.equal(sent.length, 1)
  const m = sent[0]
  assert.equal(m.url, 'https://api.resend.com/emails')
  assert.equal(m.headers.authorization, 'Bearer re_test_123')
  assert.equal(m.body.from, 'opportune <hello@opportune.test>')
  assert.equal(m.body.to, 'mal@example.com')
  assert.equal(m.body.subject, 'Sign in to opportune')
  assert.match(m.body.text, /15 minutes/)
  assert.match(m.body.text, /didn't ask for this/)
  const code = codeIn(m.body.text, /http:\/\/node\.test\/app\?claim=([A-Z0-9]{6})\b/)
  assert.ok(m.body.html.includes(`http://node.test/app?claim=${code}`))
  assert.equal(m.body.text.match(/http/g).length, 1, 'one link')
  const sc = ctx.sources.forPerson(mal.id).find(s => s.source_id === 'opportuneApp')
  assert.ok(sc, 'an opportuneApp source was connected for the Telegram-first person')
  assert.ok(!m.body.text.includes(sc.token) && !m.body.html.includes(sc.token), 'the long-lived ingest token never goes in an email')
  const rec = ctx.db.kvGet(`applink:${code}`)
  assert.equal(rec.id, sc.id)
  assert.ok(rec.exp > Date.now() + 14 * 60e3 && rec.exp <= Date.now() + 15 * 60e3)
  assert.equal(claim(code)?.id, mal.id)
  assert.equal(claim(code), null, 'one use')
})

test('a second sign-in reuses the same app source, so the credential does not multiply', async () => {
  await api('/app/email/request', { body: { email: 'mal@example.com' } })
  assert.equal(ctx.sources.forPerson(mal.id).filter(s => s.source_id === 'opportuneApp').length, 1)
})

test('expired code: /app/claim rejects it', async () => {
  await api('/app/email/request', { body: { email: 'mal@example.com' } })
  const code = codeIn(sent[0].body.text, /claim=([A-Z0-9]{6})/)
  ctx.db.kvSet(`applink:${code}`, { ...ctx.db.kvGet(`applink:${code}`), exp: Date.now() - 1 })
  assert.equal(claim(code), null)
})

test('rate limit: 3 per address per 10 minutes, then 429 whether or not the address is known', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await api('/app/email/request', { body: { email: 'mal@example.com' } })).status, 200)
  const r = await api('/app/email/request', { body: { email: 'mal@example.com' } })
  assert.equal(r.status, 429)
  assert.equal(sent.length, 3)
  for (let i = 0; i < 3; i++) assert.equal((await api('/app/email/request', { body: { email: 'ghost@example.com' } })).status, 200)
  assert.equal((await api('/app/email/request', { body: { email: 'ghost@example.com' } })).status, 429)
  assert.equal(sent.length, 3)
})

test('verification: token-authed request emails a verify link; following it binds the identity and redirects to the claim URL', async () => {
  const token = new URL(manageUrl(ctx, jess.id)).searchParams.get('token')
  assert.equal((await api('/api/app/email', { body: { email: 'jess@example.com' } })).status, 401)
  assert.equal((await api('/api/app/email', { body: { email: 'jess@example.com' }, token: 'nope' })).status, 401)
  assert.equal((await api('/api/app/email', { body: { email: 'nope' }, token })).status, 400)
  const r = await api('/api/app/email', { body: { email: 'Jess@Example.com' }, token })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.to, 'jess@example.com')
  assert.equal(sent[0].body.subject, 'Confirm your email for opportune')
  assert.match(sent[0].body.text, /15 minutes/)
  const code = codeIn(sent[0].body.text, /http:\/\/node\.test\/app\/email\/verify\/([A-Z0-9]{6})\b/)
  assert.deepEqual(ctx.db.kvGet(`emailverify:${code}`).email, 'jess@example.com')
  assert.equal(ctx.db.kvGet(`applink:${code}`).verifyEmail, 'jess@example.com')
  assert.equal(ctx.people.identify('email', 'jess@example.com'), null, 'not bound until the link is opened')

  const v = await api(`/app/email/verify/${code.toLowerCase()}`, { method: 'GET' })
  assert.equal(v.status, 302)
  assert.equal(v.location, `/app?claim=${code}`)
  const ident = ctx.people.identities(jess.id).find(i => i.channel === 'email')
  assert.equal(ident.external_id, 'jess@example.com')
  assert.ok(ident.meta.verifiedAt)
  assert.equal(ctx.people.identify('email', 'jess@example.com').id, jess.id)
  assert.equal(ctx.db.kvGet(`emailverify:${code}`), null, 'verify link is one use')
  assert.equal(claim(code)?.id, jess.id, 'and the claim it redirects to signs her in')
  assert.equal((await api(`/app/email/verify/${code}`, { method: 'GET' })).status, 410)

  // now she can sign in by email like anyone else
  const s = await api('/app/email/request', { body: { email: 'jess@example.com' } })
  assert.equal(s.status, 200)
  assert.equal(sent.length, 2)
  // and asking to verify an address that is already hers sends nothing
  const again = await api('/api/app/email', { body: { email: 'jess@example.com' }, token })
  assert.equal(again.status, 200)
  assert.equal(sent.length, 2)
})

test('verification: an address that belongs to someone else is 409 at request time and at the link', async () => {
  const token = new URL(manageUrl(ctx, jess.id)).searchParams.get('token')
  const r = await api('/api/app/email', { body: { email: 'mal@example.com' }, token })
  assert.equal(r.status, 409)
  assert.equal(sent.length, 0)
  // raced: the link was issued, then the address got bound elsewhere before it was opened
  const other = ctx.people.create({ displayName: 'Other' })
  const t2 = new URL(manageUrl(ctx, other.id)).searchParams.get('token')
  assert.equal((await api('/api/app/email', { body: { email: 'race@example.com' }, token: t2 })).status, 200)
  const code = codeIn(sent[0].body.text, /verify\/([A-Z0-9]{6})/)
  ctx.people.bind(jess.id, 'email', 'race@example.com')
  assert.equal((await api(`/app/email/verify/${code}`, { method: 'GET' })).status, 409)
  assert.equal(ctx.people.identify('email', 'race@example.com').id, jess.id)
})

test('verification: expired link is 410 and binds nothing', async () => {
  const token = new URL(manageUrl(ctx, jess.id)).searchParams.get('token')
  assert.equal((await api('/api/app/email', { body: { email: 'late@example.com' }, token })).status, 200)
  const code = codeIn(sent[0].body.text, /verify\/([A-Z0-9]{6})/)
  ctx.db.kvSet(`emailverify:${code}`, { ...ctx.db.kvGet(`emailverify:${code}`), exp: Date.now() - 1 })
  assert.equal((await api(`/app/email/verify/${code}`, { method: 'GET' })).status, 410)
  assert.equal(ctx.people.identify('email', 'late@example.com'), null)
  assert.equal((await api('/app/email/verify/ZZZZZZ', { method: 'GET' })).status, 410)
})

test('send: a nudge to an email-only person goes out as plain text with a link to the app', async () => {
  const solo = ctx.people.create({ displayName: 'Solo' })
  ctx.people.update(solo.id, { onboarding: { step: 'done' } })
  ctx.people.bind(solo.id, 'email', 'solo@example.com')
  const n = await ctx.nudges.send(solo.id, { text: 'Eileen is a block away and her porchlight is on.', actions: [{ key: 'yes', label: 'Go say hi' }, { key: 'no', label: 'Not now' }] })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.to, 'solo@example.com')
  assert.match(sent[0].body.text, /Eileen is a block away/)
  assert.match(sent[0].body.text, /Go say hi \/ Not now/)
  assert.match(sent[0].body.text, /http:\/\/node\.test\/app/)
  assert.ok(!/bad/i.test(sent[0].body.text), 'the built-in "bad" rating is not offered by mail')
  assert.equal(ctx.nudges.get(n.id).channel, 'email')
  assert.equal(ctx.nudges.get(n.id).external_id, 'em_1')
})

test('Resend failure: sign-in still answers 200 (no enumeration), verification answers 502', async () => {
  const good = globalThis.fetch
  globalThis.fetch = async () => new Response('nope', { status: 500 })
  try {
    assert.equal((await api('/app/email/request', { body: { email: 'mal@example.com' } })).status, 200)
    const token = new URL(manageUrl(ctx, jess.id)).searchParams.get('token')
    assert.equal((await api('/api/app/email', { body: { email: 'fail@example.com' }, token })).status, 502)
  } finally { globalThis.fetch = good }
})

test('disabled without RESEND_API_KEY: routes answer 503, send throws so nudges fall through', async () => {
  const off = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '', TELEGRAM_BOT_TOKEN: '', RESEND_API_KEY: '' }, { dbPath: ':memory:' })
  const app = express()
  app.use(express.json())
  mountEmail(app, off)
  const s = await new Promise(r => { const s = app.listen(0, () => r(s)) })
  const b = `http://127.0.0.1:${s.address().port}`
  try {
    for (const [method, path] of [['POST', '/app/email/request'], ['POST', '/api/app/email'], ['GET', '/app/email/verify/ABCDEF']]) {
      const r = await realFetch(`${b}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ email: 'mal@example.com' }) : undefined })
      assert.equal(r.status, 503, `${method} ${path}`)
      assert.deepEqual(await r.json(), { error: 'email sign-in is not set up on this node' })
    }
    await assert.rejects(emailChannel.send(off, { id: 'x' }, { external_id: 'a@b.co' }, { id: 'n', text: 'hi', actions: [] }), /not configured/)
    assert.equal(sent.length, 0)
  } finally { s.close() }
})
