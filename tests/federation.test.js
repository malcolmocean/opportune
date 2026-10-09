// Federation end-to-end: two real `node server.js` processes (A and B) with their own
// SQLite files and NODE_URLs. The test process opens the same two DB files through
// buildContext() so it can drive each node's ctx (invite, acceptRemoteInvite, ask,
// nudges.send); every cross-node hop still goes over HTTP to the other child process,
// signed with the person's ed25519 key and verified by the receiving server.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildContext } from '../core/context.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const base = 3500 + Math.floor(Math.random() * 400)
const nodes = {
  A: { port: base, url: `http://127.0.0.1:${base}` },
  B: { port: base + 1, url: `http://127.0.0.1:${base + 1}` },
}
const dir = mkdtempSync(join(tmpdir(), 'opportune-fed-'))
const children = []
let ctxA, ctxB, alice, bob, inviteCode

// Minimal env on purpose: no ANTHROPIC_API_KEY (LLM off), no TELEGRAM_BOT_TOKEN (channel disabled).
const envFor = n => ({ PATH: process.env.PATH, HOME: process.env.HOME, NODE_URL: n.url, PORT: String(n.port), DB_PATH: join(dir, `${n.port}.db`), NODE_NO_WARNINGS: '1' })

async function startNode(n) {
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: envFor(n), stdio: ['ignore', 'pipe', 'pipe'] })
  n.log = ''
  child.stdout.on('data', d => { n.log += d })
  child.stderr.on('data', d => { n.log += d })
  children.push(child)
  const deadline = Date.now() + 20e3
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`node ${n.url} exited ${child.exitCode}:\n${n.log}`)
    try { const r = await fetch(`${n.url}/api/health`); if (r.ok) return } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`node ${n.url} never came up:\n${n.log}`)
}

const post = (url, path, headers, body) => fetch(url + path, { method: 'POST', headers, body })
const tonight = () => {
  const start = new Date(Date.now() + 60 * 60e3), end = new Date(Date.now() + 3 * 3600e3)
  return { start: start.toISOString(), end: end.toISOString() }
}

before(async () => {
  // children first so schema creation never races the test process's connections
  await Promise.all([startNode(nodes.A), startNode(nodes.B)])
  ctxA = await buildContext({ NODE_URL: nodes.A.url }, { dbPath: envFor(nodes.A).DB_PATH })
  ctxB = await buildContext({ NODE_URL: nodes.B.url }, { dbPath: envFor(nodes.B).DB_PATH })
  alice = ctxA.people.create({ displayName: 'Alice' })
  bob = ctxB.people.create({ displayName: 'Bob' })
})

after(() => {
  for (const c of children) c.kill('SIGTERM')
  if (process.env.KEEP_FED_LOGS) console.log(nodes.A.log, nodes.B.log)
  rmSync(dir, { recursive: true, force: true })
})

test('both nodes are up and advertise capabilities at /.well-known/opportune', async () => {
  for (const n of Object.values(nodes)) {
    const wk = await fetch(`${n.url}/.well-known/opportune`).then(r => r.json())
    assert.equal(wk.node, n.url)
    assert.equal(wk.protocol, 'opportune/0.1')
    assert.ok(wk.capabilities.queries.some(q => q.kind === 'availability'), 'advertises availability query')
    assert.ok(wk.capabilities.sources.some(s => s.id === 'icsCalendar'), 'advertises icsCalendar source')
  }
})

test('Alice (A) invites, Bob (B) accepts over HTTP: both nodes store the other as a remote person with pubkey', async () => {
  const inv = ctxA.people.invite(alice.id, { inviteeName: 'Bob', wantMore: true })
  inviteCode = inv.code
  assert.ok(inv.url.startsWith(nodes.A.url + '/i/'))

  const res = await ctxB.federation.acceptRemoteInvite(bob, inv.url)
  assert.equal(res.inviter.id, alice.id)
  assert.ok(Array.isArray(res.capabilities?.queries), 'joiner learns inviter node capabilities')

  // B knows Alice as remote, with her pubkey and node
  const aliceOnB = ctxB.people.get(alice.id)
  assert.ok(aliceOnB, 'Alice exists on B')
  assert.equal(aliceOnB.remote, 1)
  assert.equal(aliceOnB.pubkey, alice.pubkey)
  assert.equal(aliceOnB.node_url, nodes.A.url)
  assert.equal(aliceOnB.privkey, null, 'B never holds Alice\'s private key')

  // A knows Bob as remote, with his pubkey and node
  const bobOnA = ctxA.people.get(bob.id)
  assert.ok(bobOnA, 'Bob exists on A')
  assert.equal(bobOnA.remote, 1)
  assert.equal(bobOnA.pubkey, bob.pubkey)
  assert.equal(bobOnA.node_url, nodes.B.url)
  assert.equal(bobOnA.privkey, null)

  // relationships both ways on both nodes; wantMore only on Alice→Bob
  for (const [name, ctx] of [['A', ctxA], ['B', ctxB]]) {
    const ab = ctx.people.rel(alice.id, bob.id), ba = ctx.people.rel(bob.id, alice.id)
    assert.ok(ab && ba, `${name}: edges both ways`)
    assert.equal(ab.tier, 'friend')
    assert.equal(ab.want_more, 1, `${name}: Alice wants more of Bob`)
    assert.equal(ba.want_more, 0, `${name}: Bob has not said so`)
    assert.equal(ab.effectiveGrants.askAvailability, true)
  }
})

test('a used invite code is dead: /friend/accept rejects it and acceptRemoteInvite throws', async () => {
  assert.equal(ctxA.people.peekInvite(inviteCode), null)
  const body = JSON.stringify({ code: inviteCode, joiner: { id: 'mallory', displayName: 'Mallory', pubkey: bob.pubkey, nodeUrl: nodes.B.url } })
  const r = await post(nodes.A.url, '/friend/accept', { 'content-type': 'application/json' }, body)
  const j = await r.json()
  assert.equal(j.error, 'invalid or used invite')
  assert.equal(ctxA.people.get('mallory'), undefined, 'no person created for the rejected joiner')
  const carol = ctxB.people.create({ displayName: 'Carol' })
  await assert.rejects(ctxB.federation.acceptRemoteInvite(carol, `${nodes.A.url}/i/${inviteCode}`), /invalid or used invite/)
})

test('availability ask with nothing known about Bob → unsupported + suggest; Bob\'s node is told via /suggest and nudges Bob', async () => {
  ctxB.people.update(bob.id, { onboarding: { step: 'done' } })
  const ans = await ctxA.query.ask({ from: alice.id, to: bob.id, kind: 'availability', text: 'free tonight?', window: tonight() })
  assert.equal(ans.answer, 'unsupported')
  assert.equal(ans.suggest?.plugin, 'sources/icsCalendar')
  // A forwards the suggestion to B (signed POST /suggest); B's listener nudges Bob once per plugin per week
  let row
  for (let i = 0; i < 20 && !row; i++) { await new Promise(r => setTimeout(r, 50)); row = ctxB.db.get(`select * from nudges where person_id = ? and text like '%Calendar%'`, bob.id) }
  assert.ok(row, 'Bob got a nudge suggesting the calendar source')
  assert.match(row.text, /Alice's agent asked about availability/)
  assert.equal(ctxA.db.get(`select count(*) c from nudges where person_id = ?`, alice.id).c, 0, 'nothing on the asking node')
})

test('Bob has an event tonight → Alice\'s availability ask round-trips signed over HTTP and answers "unlikely"', async () => {
  const w = tonight()
  const ins = await ctxB.observations.ingest(bob.id, 'manual', [{ kind: 'event', at: w.start, until: w.end, dedupeKey: 'test-tonight', data: { title: 'Dinner with Sam', location: 'Mission', provider: 'manual', busy: true } }])
  assert.equal(ins.length, 1)
  assert.equal(ctxA.observations.eventsIn(bob.id, w.start, w.end).length, 0, 'A never sees Bob\'s raw calendar')

  const ans = await ctxA.query.ask({ from: alice.id, to: bob.id, kind: 'availability', text: 'free tonight?', window: w })
  assert.equal(ans.answer, 'unlikely')
  assert.match(ans.reason, /1 thing\(s\) on/)
  assert.equal(ans.confidence, 0.5)
  assert.deepEqual(ans.revealed, {}, 'friend tier reveals no event detail without the LLM')

  // the answer was produced by B's server process (query_log lives in B's db, written by the child)
  const logged = ctxB.db.all('select * from query_log where from_id = ? and to_id = ? order by created_at', alice.id, bob.id)
  assert.equal(logged.length, 2, 'both asks so far are logged on B')
  assert.equal(logged.at(-1).answer, 'unlikely')
  assert.equal(logged.at(-1).text, 'free tonight?')
  assert.equal(ctxA.db.all('select * from query_log').length, 0, 'nothing logged on A: the ask was remote')
})

test('a kind the asker lacks the grant for → "no, not permitted" (kind is a permission class)', async () => {
  const ans = await ctxA.query.ask({ from: alice.id, to: bob.id, kind: 'plans', text: 'what are you up to?' })
  assert.equal(ans.answer, 'no')
  assert.equal(ans.reason, 'not permitted')
})

test('tampered signature → 401', async () => {
  const body = JSON.stringify({ to: bob.id, kind: 'availability', text: 'free tonight?' })
  const h = ctxA.federation.signHeaders(alice, 'POST', '/q', body)
  const sig = Buffer.from(h['x-opportune-sig'], 'base64'); sig[0] ^= 0xff
  const r = await post(nodes.B.url, '/q', { ...h, 'x-opportune-sig': sig.toString('base64') }, body)
  assert.equal(r.status, 401)
  assert.equal((await r.json()).error, 'bad signature')
  // signing a different body than what is sent also fails
  const h2 = ctxA.federation.signHeaders(alice, 'POST', '/q', body)
  const r2 = await post(nodes.B.url, '/q', h2, JSON.stringify({ to: bob.id, kind: 'plans', text: 'free tonight?' }))
  assert.equal(r2.status, 401)
  assert.equal((await r2.json()).error, 'bad signature')
})

test('replayed nonce → 401 (first delivery accepted, identical second one rejected)', async () => {
  const body = JSON.stringify({ to: bob.id, kind: 'availability', text: 'free tonight?', window: tonight() })
  const h = ctxA.federation.signHeaders(alice, 'POST', '/q', body)
  const r1 = await post(nodes.B.url, '/q', h, body)
  assert.equal(r1.status, 200)
  assert.equal((await r1.json()).answer, 'unlikely')
  const r2 = await post(nodes.B.url, '/q', h, body)
  assert.equal(r2.status, 401)
  assert.equal((await r2.json()).error, 'replay')
})

test('unsigned, stale, and unknown-sender requests → 401', async () => {
  const body = JSON.stringify({ to: bob.id, kind: 'availability', text: 'hi' })
  const r0 = await post(nodes.B.url, '/q', { 'content-type': 'application/json' }, body)
  assert.equal(r0.status, 401)
  assert.equal((await r0.json()).error, 'unsigned')

  const stale = ctxA.federation.signHeaders(alice, 'POST', '/q', body)
  stale['x-opportune-ts'] = String(Date.now() - 10 * 60e3)
  const r1 = await post(nodes.B.url, '/q', stale, body)
  assert.equal(r1.status, 401)
  assert.equal((await r1.json()).error, 'stale')

  const stranger = ctxA.people.create({ displayName: 'Stranger' })   // has keys on A, but B has never met them
  const r2 = await post(nodes.B.url, '/q', ctxA.federation.signHeaders(stranger, 'POST', '/q', body), body)
  assert.equal(r2.status, 401)
  assert.equal((await r2.json()).error, 'unknown sender')
})

test('a kind Bob\'s node has no plugin for → "unsupported"; no suggest, so no federation:suggest event', async () => {
  const emitted = []
  const on = e => emitted.push(e)
  ctxA.events.on('federation:suggest', on)
  const ans = await ctxA.query.ask({ from: alice.id, to: bob.id, kind: 'nonexistent', text: 'anything?' })
  ctxA.events.off('federation:suggest', on)
  assert.equal(ans.answer, 'unsupported')
  assert.match(ans.reason, /no "nonexistent" query/)
  // shape note: `suggest` is only present when core/query.js knows a plugin for the kind
  // (availability, plans, whereabouts, dropin). For an unknown kind it is absent, so the
  // asking node has nothing to promote and correctly stays silent.
  assert.equal(ans.suggest, undefined)
  assert.equal(emitted.length, 0)
  assert.equal(ctxB.db.get('select answer, reason from query_log where kind = ?', 'nonexistent').reason, 'no plugin')
})

test('ctx.nudges.send to a remote person goes through /nudge and lands as a nudge row on B', async () => {
  const before_ = ctxB.nudges.recent(bob.id).length
  const r = await ctxA.nudges.send(bob.id, { text: 'Alice asked if you are free tonight; I said unlikely. Veto?', actions: [{ key: 'yes', label: 'Fine' }, { key: 'no', label: 'Veto' }] })
  assert.equal(r.ok, true)
  assert.ok(r.id)
  const n = ctxB.nudges.get(r.id)
  assert.ok(n, 'nudge row exists on B')
  assert.equal(n.person_id, bob.id)
  assert.equal(n.text, 'Alice\'s node: Alice asked if you are free tonight; I said unlikely. Veto?')
  assert.deepEqual(n.actions.map(a => a.key), ['yes', 'no'])
  assert.equal(n.channel, null, 'no channel bound for Bob, row still recorded')
  assert.equal(ctxB.nudges.recent(bob.id).length, before_ + 1)
  assert.equal(ctxA.db.get('select count(*) c from nudges').c, 0, 'nothing stored on A')
})

test('/observe lets A push granted observations that land attributed to remote Alice on B', async () => {
  const r = await ctxA.federation.post(alice, nodes.B.url, '/observe', { observations: [{ kind: 'status', until: new Date(Date.now() + 3600e3).toISOString(), data: { porchlight: 'open', note: 'come by' } }] })
  assert.equal(r.inserted, 1)
  const s = ctxB.observations.latest(alice.id, 'status')
  assert.equal(s.data.porchlight, 'open')
  assert.equal(s.source_id, `remote:${nodes.A.url}`)
})

test('fanout from Alice ranks the remote answer like a local one', async () => {
  const res = await ctxA.query.fanout(alice.id, { kind: 'availability', text: 'free tonight?', window: tonight() })
  assert.equal(res.length, 1)
  assert.equal(res[0].to, bob.id)
  assert.equal(res[0].name, 'Bob')
  assert.equal(res[0].answer, 'unlikely')
})
