// Behavioural checks for the audit fixes: admin gating, review filters, veto privacy, token scoping,
// federation id/sender handling, setRel whitelist, fanout eligibility, freeform query, caps, homes, hours, app-only hints.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { buildContext } from '../core/context.js'
import { adminOk, devOk, mountAdmin } from '../core/admin.js'
import { inferHomes, makeDigest } from '../core/cron.js'
import { localHour } from '../core/geo.js'

const env = { ...process.env, ANTHROPIC_API_KEY: '', TELEGRAM_BOT_TOKEN: '', NODE_URL: 'http://node.test' }
const mk = async (extra = {}) => {
  const ctx = await buildContext({ ...env, ...extra }, { dbPath: ':memory:' })
  const jess = ctx.people.create({ displayName: 'Jess' }), eileen = ctx.people.create({ displayName: 'Eileen' })
  for (const p of [jess, eileen]) ctx.people.update(p.id, { onboarding: { step: 'done' }, policy: { quietHours: { start: 99, end: 99 } } })
  ctx.people.setRel(jess.id, eileen.id, { wantMore: true }); ctx.people.setRel(eileen.id, jess.id, { wantMore: true })
  return { ctx, jess, eileen }
}
const fakeReq = (query = {}, headers = {}) => ({ query, get: h => headers[h.toLowerCase()] })
const opp = (ctx, participants, primary, summary = 'x') => ctx.db.insert('opportunities', { id: `o${Math.random().toString(36).slice(2, 8)}`, trigger_id: 't', kind: 'nearby', participants, primary_id: primary, summary, evidence: [], status: 'judged', created_at: new Date().toISOString() })

test('1. adminOk needs a configured token; devOk opens dev routes outside production only', async () => {
  const { ctx } = await mk({ ADMIN_TOKEN: 'sekrit' })
  assert.equal(adminOk(ctx, fakeReq({ token: 'sekrit' })), true)
  assert.equal(adminOk(ctx, fakeReq({}, { 'x-admin-token': 'sekrit' })), true)
  assert.equal(adminOk(ctx, fakeReq({ token: 'nope' })), false)
  const { ctx: none } = await mk({ ADMIN_TOKEN: '' })
  assert.equal(adminOk(none, fakeReq({ token: '' })), false, 'empty token never matches')
  assert.equal(devOk(ctx, fakeReq()), true, 'not production: open')
  const { ctx: prod } = await mk({ ADMIN_TOKEN: 'sekrit', NODE_ENV: 'production' })
  assert.equal(devOk(prod, fakeReq()), false)
  assert.equal(devOk(prod, fakeReq({ token: 'sekrit' })), true)
})

test('7. admin.html is served from core/ only through the token check, not the /web static mount', async () => {
  const { ctx } = await mk({ ADMIN_TOKEN: 'sekrit' })
  const app = express()
  app.use('/web', express.static('web'))
  mountAdmin(app, ctx)
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)) })
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    assert.equal((await fetch(`${base}/web/admin.html`)).status, 404, 'not in the static dir any more')
    assert.equal((await fetch(`${base}/web/admin`)).status, 401)
    const ok = await fetch(`${base}/web/admin?token=sekrit`)
    assert.equal(ok.status, 200)
    assert.match(await ok.text(), /api\/admin\/overview/)
    assert.equal((await fetch(`${base}/api/admin/overview`)).status, 401)
    const ov = await fetch(`${base}/api/admin/overview`, { headers: { 'x-admin-token': 'sekrit' } }).then(r => r.json())
    assert.equal(typeof ov.people[0].decisions.c, 'number')
  } finally { server.close() }
})

test('2. reviewable/suppressedSince exclude relationship gates (no relationship, neither side wantMore); admin counts match', async () => {
  const { ctx, jess, eileen } = await mk()
  const o = opp(ctx, [jess.id, eileen.id], jess.id, 'Jess and Eileen are near')
  ctx.judge.record(jess.id, o, 'suppress', 'gate: neither side marked wantMore for Eileen')
  ctx.judge.record(jess.id, o, 'suppress', 'gate: no relationship with Eileen')
  const keep = ctx.judge.record(jess.id, o, 'suppress', 'gate: quiet hours')
  const nudge = ctx.judge.record(jess.id, o, 'nudge', 'worth it')
  const since = new Date(Date.now() - 3600e3).toISOString()
  assert.deepEqual(ctx.judge.suppressedSince(jess.id, since).map(d => d.id), [keep.id])
  assert.deepEqual(ctx.judge.reviewable(jess.id).map(d => d.id).sort(), [keep.id, nudge.id].sort())
  assert.equal(ctx.judge.reviewable(jess.id)[0].summary, 'Jess and Eileen are near')
  assert.equal(ctx.judge.reviewable(jess.id, null, { verdict: 'nudge' }).length, 1)
})

test('3. gate reasons name people, never ids', async () => {
  const { ctx, jess, eileen } = await mk()
  const stranger = ctx.people.create({ displayName: 'Sam' })
  assert.equal(ctx.judge.gate(ctx.people.get(jess.id), { kind: 'nearby', participants: [jess.id, stranger.id] }), 'no relationship with Sam')
  ctx.people.setRel(jess.id, eileen.id, { wantMore: false }); ctx.people.setRel(eileen.id, jess.id, { wantMore: false })
  assert.equal(ctx.judge.gate(ctx.people.get(jess.id), { kind: 'nearby', participants: [jess.id, eileen.id] }), 'neither side marked wantMore for Eileen')
})

test('18. daily cap counts only Judge nudges (decision_id set)', async () => {
  const { ctx, jess, eileen } = await mk()
  for (let i = 0; i < 8; i++) await ctx.nudges.send(jess.id, { text: `digest ${i}`, actions: [] })   // no decision
  assert.equal(ctx.judge.gate(ctx.people.get(jess.id), { kind: 'nearby', participants: [jess.id, eileen.id] }), null)
  const o = opp(ctx, [jess.id, eileen.id], jess.id)
  for (let i = 0; i < 6; i++) { const d = ctx.judge.record(jess.id, o, 'nudge', 'r'); await ctx.nudges.send(jess.id, { text: 'n', actions: [], decisionId: d.id }) }
  assert.equal(ctx.judge.gate(ctx.people.get(jess.id), { kind: 'nearby', participants: [jess.id, eileen.id] }), 'daily nudge cap')
})

test('25. an ask verdict with nobody to ask becomes a nudge', async () => {
  const { ctx, jess } = await mk({ JUDGE_STUB: 'ask' })
  const o = { ...opp(ctx, [jess.id], jess.id, 'Eileen from your contacts is on the guest list'), participants: [jess.id] }
  await ctx.judge.consider(o)
  const d = ctx.db.get('select * from decisions where person_id = ?', jess.id)
  assert.equal(d.verdict, 'nudge'); assert.match(d.reasoning, /nobody to ask/)
  const n = ctx.db.get('select * from nudges where person_id = ?', jess.id)
  assert.equal(n.text, 'Eileen from your contacts is on the guest list')
  assert.equal(n.decision_id, d.id)
  assert.equal(ctx.db.get('select count(*) c from query_log').c, 0, 'no query was attempted')
})

test('6. personForToken: manage tokens and the opportune app token only', async () => {
  const { ctx, jess } = await mk()
  const { personForToken, manageUrl } = await import('../web/routes.js')
  const t = new URL(manageUrl(ctx, jess.id)).searchParams.get('token')
  assert.equal(personForToken(ctx, t).id, jess.id)
  assert.equal(personForToken(ctx, ctx.sources.connect(jess.id, 'opportuneApp', {}).token).id, jess.id)
  assert.equal(personForToken(ctx, ctx.sources.connect(jess.id, 'locationPost', { app: 'OwnTracks' }).token), null)
  assert.equal(personForToken(ctx, ctx.sources.connect(jess.id, 'icsCalendar', { urls: [] }).token), null)
})

test('8. acceptIncoming refuses a joiner id that is a local person or a remote person with another key', async () => {
  const { ctx, jess, eileen } = await mk()
  const inv = () => ctx.people.invite(jess.id, { inviteeName: 'X' }).code
  const remote = ctx.people.create({ id: 'bob-remote', displayName: 'Bob', remote: true, nodeUrl: 'http://b.test', pubkey: 'KEY1' })
  assert.deepEqual(ctx.federation.acceptIncoming({ code: inv(), joiner: { id: eileen.id, displayName: 'Evil', pubkey: 'K', nodeUrl: 'http://x.test' } }), { error: 'id taken' })
  assert.deepEqual(ctx.federation.acceptIncoming({ code: inv(), joiner: { id: remote.id, displayName: 'Bob', pubkey: 'KEY2', nodeUrl: 'http://b.test' } }), { error: 'id taken' })
  assert.equal(ctx.people.get(remote.id).pubkey, 'KEY1')
  assert.equal(ctx.people.rel(jess.id, eileen.id).tier, 'friend', 'the invite did not touch the existing edge')
  const ok = ctx.federation.acceptIncoming({ code: inv(), joiner: { id: remote.id, displayName: 'Bob', pubkey: 'KEY1', nodeUrl: 'http://b.test' } })
  assert.equal(ok.inviter.id, jess.id, 'same remote person re-accepting with the same key is fine')
  assert.deepEqual(ctx.federation.acceptIncoming({ code: inv(), joiner: { id: 'new', displayName: 'N' } }), { error: 'joiner id and pubkey required' })
})

test('12. deliverNudge signs as the local `from` when given, else falls back to any local person', async () => {
  const { ctx, jess, eileen } = await mk()
  const bob = ctx.people.create({ id: 'bob', displayName: 'Bob', remote: true, nodeUrl: 'http://b.test', pubkey: 'K' })
  const posts = []
  ctx.federation.post = async (who, node, path, payload) => { posts.push({ who: who.id, node, path, payload }); return { ok: true } }
  await ctx.nudges.send(bob.id, { text: 'hi', actions: [] }, { from: eileen.id })
  assert.equal(posts[0].who, eileen.id); assert.equal(posts[0].path, '/nudge'); assert.equal(posts[0].payload.to, bob.id)
  await ctx.nudges.send(bob.id, { text: 'hi', actions: [] }, { from: bob.id })   // remote `from` cannot sign
  assert.equal(posts[1].who, jess.id, 'falls back to the first local person')
  await ctx.nudges.send(bob.id, { text: 'hi', actions: [] })
  assert.equal(posts[2].who, jess.id)
})

test('9. setRel only updates whitelisted columns; the agent tool keeps working for them', async () => {
  const { ctx, jess, eileen } = await mk()
  const before = ctx.db.get('select * from relationships where from_id = ? and to_id = ?', jess.id, eileen.id)
  const r = ctx.people.setRel(jess.id, eileen.id, { tier: 'trusted', wantMore: false, travel: 2, note: 'n', grants: { seePlans: false }, via: { tier: 'friend' }, vouch: true, created_at: 'hacked', from_id: eileen.id, 'tier = 1; --': 'x' })
  assert.equal(r.tier, 'trusted'); assert.equal(r.want_more, 0); assert.equal(r.travel, 2); assert.equal(r.note, 'n'); assert.equal(r.vouch, 1)
  assert.deepEqual(r.grants, { seePlans: false }); assert.deepEqual(r.via, { tier: 'friend' })
  assert.equal(r.created_at, before.created_at); assert.equal(r.from_id, jess.id)
  const tool = ctx.agent.tools(ctx.people.get(jess.id)).find(t => t.name === 'update_relationship')
  const r2 = tool.run({ friendId: eileen.id, wantMore: true, note: 'via llm', bogus: 1 })
  assert.equal(r2.want_more, 1); assert.equal(r2.note, 'via llm')
})

test('13. fanout skips shadow people and remote people with no edge back', async () => {
  const { ctx, jess, eileen } = await mk()
  const shadow = ctx.people.create({ displayName: 'Maps Person' }); ctx.people.update(shadow.id, { onboarding: { step: 'shadow' } })
  const remoteNoBack = ctx.people.create({ id: 'r1', displayName: 'R1', remote: true, nodeUrl: 'http://r.test', pubkey: 'K' })
  const remoteBack = ctx.people.create({ id: 'r2', displayName: 'R2', remote: true, nodeUrl: 'http://r.test', pubkey: 'K' })
  for (const p of [shadow, remoteNoBack, remoteBack]) ctx.people.setRel(jess.id, p.id, { wantMore: true })
  ctx.people.setRel(remoteBack.id, jess.id, {})
  const asked = []
  ctx.federation.ask = async (target) => { asked.push(target.id); return { answer: 'likely' } }
  ctx.sources.connect(eileen.id, 'icsCalendar', { urls: [] })
  const res = await ctx.query.fanout(jess.id, { kind: 'availability', text: 'free?' })
  assert.deepEqual(res.map(r => r.to).sort(), [eileen.id, remoteBack.id].sort())
  assert.deepEqual(asked, [remoteBack.id])
  const explicit = await ctx.query.fanout(jess.id, { kind: 'availability', text: 'free?', toIds: [shadow.id, eileen.id, 'nobody'] })
  assert.deepEqual(explicit.map(r => r.to), [eileen.id])
})

test('14. freeform query exists: grant-gated, unsupported without an LLM, logged under query:freeform', async () => {
  const { ctx, jess, eileen } = await mk()
  const q = ctx.plugins.queries.freeform
  assert.equal(q.kind, 'freeform'); assert.equal(q.sensitivity, 5); assert.equal(q.grant, 'askAvailability')
  const a = await ctx.query.ask({ from: jess.id, to: eileen.id, kind: 'freeform', text: 'up for a hike Saturday?' })
  assert.equal(a.answer, 'unsupported'); assert.match(a.reason, /LLM/)
  assert.equal(a.suggest, undefined, 'the node has the plugin; nothing to install')
  ctx.people.setRel(eileen.id, jess.id, { grants: { askAvailability: false } })
  assert.equal((await ctx.query.ask({ from: jess.id, to: eileen.id, kind: 'freeform', text: 'hi' })).reason, 'not permitted')
  // with an LLM: only tier-safe facts go to the model, tagged process query:freeform
  ctx.people.setRel(eileen.id, jess.id, { grants: {} })
  ctx.llm.enabled = true
  let seen
  ctx.llm.json = async (req, meta) => { seen = { req, meta }; return { answer: 'likely', confidence: 0.6, reason: 'free then' } }
  await ctx.observations.ingest(eileen.id, 'test', [{ kind: 'location', data: { lat: 1, lng: 2, placeName: 'Park' } }])
  const b = await ctx.query.ask({ from: jess.id, to: eileen.id, kind: 'freeform', text: 'hike?' })
  assert.equal(b.answer, 'likely')
  assert.deepEqual(seen.meta, { personId: eileen.id, process: 'query:freeform' })
  const payload = seen.req.messages[0].content
  assert.ok(payload.includes('"placeName":"Park"') && !payload.includes('"lat"'), 'place name yes, coordinates never')
})

test('15. suggestFor carries a repo link for every kind', async () => {
  const { ctx, jess, eileen } = await mk()
  const saved = { ...ctx.plugins.queries }
  for (const k of ['availability', 'plans', 'whereabouts', 'dropin']) delete ctx.plugins.queries[k]
  try {
    for (const k of ['availability', 'plans', 'whereabouts', 'dropin']) {
      const a = await ctx.query.ask({ from: jess.id, to: eileen.id, kind: k, text: 'x' })
      assert.equal(a.answer, 'unsupported')
      assert.equal(a.suggest.repo, `https://github.com/malcolmocean/opportune/tree/main/queries/${k}`)
    }
  } finally { Object.assign(ctx.plugins.queries, saved) }
})

test('4. a veto writes data.reason, not data.note; porchlight() does not surface it', async () => {
  const { ctx, jess, eileen } = await mk()
  await ctx.observations.ingest(eileen.id, 'dropin', [{ kind: 'status', until: new Date(Date.now() + 3600e3).toISOString(), data: { porchlight: 'closed', reason: 'vetoed a drop-in from Jess' } }])
  const { porchlight } = await import('../queries/dropin/porchlight.js')
  const l = porchlight(ctx, ctx.people.get(eileen.id))
  assert.equal(l.state, 'closed'); assert.equal(l.note, undefined)
  assert.ok(!JSON.stringify(l).includes('vetoed'))
})

test('20. addPlace(home) sets people.home_place_id and home() prefers it', async () => {
  const { ctx, jess } = await mk()
  const a = ctx.people.addPlace(jess.id, { name: 'home', lat: 1, lng: 1 })
  assert.equal(ctx.people.get(jess.id).home_place_id, a.id)
  assert.equal(ctx.people.home(jess.id).id, a.id)
  const b = ctx.people.addPlace(jess.id, { name: 'home', lat: 2, lng: 2 })
  assert.equal(ctx.people.get(jess.id).home_place_id, b.id)
  assert.equal(ctx.people.home(jess.id).lat, 2)
  ctx.people.addPlace(jess.id, { name: 'office', lat: 3, lng: 3 })
  assert.equal(ctx.people.home(jess.id).id, b.id)
  // legacy rows: no home_place_id → newest place named home
  ctx.db.run('update people set home_place_id = null where id = ?', jess.id)
  assert.equal(ctx.people.home(jess.id).id, b.id)
})

test('19. inferHomes only looks at people whose onboarding is done', async () => {
  const { ctx } = await mk()
  const p = ctx.people.create({ displayName: 'Mid' }); ctx.people.update(p.id, { onboarding: { step: 'sources' } })
  const at = (d, h) => { const t = new Date(); t.setDate(t.getDate() - d); return new Date(`${t.toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}:30:00-07:00`).toISOString() }
  await ctx.observations.ingest(p.id, 'test', [1, 2, 3, 4, 5, 6, 7].map(d => ({ kind: 'location', at: at(d, 3), data: { lat: 37.77, lng: -122.43 } })))
  assert.equal(inferHomes(ctx), 0)
  assert.equal(ctx.people.home(p.id), null)
  ctx.people.update(p.id, { onboarding: { step: 'done' } })
  assert.equal(inferHomes(ctx), 1)
  assert.ok(ctx.people.get(p.id).home_place_id)
})

test('21. localHour is 0 at midnight, never 24; digestHour 0 fires', async () => {
  assert.equal(localHour('UTC', new Date('2026-01-01T00:30:00Z')), 0)
  assert.equal(localHour('America/Los_Angeles', new Date('2026-01-01T08:10:00Z')), 0)
  assert.equal(localHour('UTC', new Date('2026-01-01T23:30:00Z')), 23)
  // pick a fixed-offset zone where it is currently 0h, so digestHour: 0 should fire right now
  const tz = [...Array(27)].map((_, i) => i - 12).map(n => `Etc/GMT${n <= 0 ? '+' : '-'}${Math.abs(n)}`).find(z => { try { return localHour(z) === 0 } catch { return false } })
  assert.ok(tz, 'some Etc/GMT zone is at midnight')
  const { ctx, jess } = await mk()
  ctx.people.update(jess.id, { tz, policy: { digestHour: 0 } })
  await ctx.observations.ingest(jess.id, 'test', [{ kind: 'event', at: new Date(Date.now() + 3600e3).toISOString(), data: { title: 'Brunch' } }])
  await makeDigest(ctx.db, ctx).tick()
  assert.equal(ctx.db.kvGet(`digest:${jess.id}`), new Date().toISOString().slice(0, 10))
  assert.match(ctx.db.get('select text from nudges where person_id = ?', jess.id).text, /Brunch/)
})

test('22. hints say /sources to Telegram people and the app Settings + manage URL to app-only people', async () => {
  const { ctx, jess, eileen } = await mk()
  ctx.people.bind(jess.id, 'telegram', '123')
  const emit = to => { ctx.events.emit('federation:suggest', { from: ctx.people.get(eileen.id), to: ctx.people.get(to), suggest: { plugin: 'sources/icsCalendar', setup: 'paste an ICS link' }, kind: 'availability', why: 'Eileen asked' }) }
  emit(jess.id); emit(eileen.id)
  await new Promise(r => setTimeout(r, 30))
  const tg = ctx.db.get('select text from nudges where person_id = ?', jess.id).text
  assert.match(tg, /with \/sources\./); assert.ok(!tg.includes('Settings'))
  const app = ctx.db.get('select text from nudges where person_id = ?', eileen.id).text
  assert.match(app, /in the app's Settings \(http:\/\/node\.test\/app\?token=[^)]*#settings\)/)
  assert.ok(!app.includes('/sources'))
})
