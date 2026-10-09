// sources/matrix against a scripted fake homeserver (globalThis.fetch is replaced for this
// process; node --test runs each file in its own process).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'

const HS = 'https://matrix.example.org'
const ME = '@malcolm:example.org'
const TOKEN = 'syt_test_token'
const now = Date.now()
const min = n => now - n * 60e3

const msg = (eventId, sender, body, ts, extra = {}) => ({ type: 'm.room.message', event_id: eventId, sender, origin_server_ts: ts, content: { msgtype: 'm.text', body, ...extra } })
const member = (id, displayname) => ({ type: 'm.room.member', state_key: id, sender: id, content: { membership: 'join', displayname } })
const long = 'x'.repeat(900)

// Rooms: a 2-person DM with a name, a Beeper-style bridged DM (3 members incl. bot, no name,
// heroes), a group chat (8 members), a room whose summary is missing (needs /joined_members),
// and a DM whose only message is old.
const initialSync = {
  next_batch: 's1',
  rooms: { join: {
    '!dm:example.org': {
      summary: { 'm.joined_member_count': 2, 'm.heroes': ['@jess:example.org'] },
      state: { events: [member('@jess:example.org', 'Jess'), { type: 'm.room.name', content: { name: 'Jess' } }] },
      timeline: { events: [
        msg('$e1', '@jess:example.org', "I'll be in Oakland Saturday, around?", min(5)),
        msg('$e2', ME, 'yes! come by', min(4)),
        msg('$e3', '@jess:example.org', long, min(3)),
        msg('$e12', ME, "I'll be in Oakland Saturday too, coffee?", min(3)),
        { type: 'm.room.message', event_id: '$e4', sender: '@jess:example.org', origin_server_ts: min(2), content: { msgtype: 'm.image', body: 'photo.jpg', url: 'mxc://x/y' } },
        { type: 'm.room.message', event_id: '$e5', sender: '@jess:example.org', origin_server_ts: min(2), content: { msgtype: 'm.notice', body: 'bridge notice' } },
        { type: 'm.room.encrypted', event_id: '$enc1', sender: '@jess:example.org', origin_server_ts: min(1), content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'AwgA…', session_id: 's', sender_key: 'k', device_id: 'D' } },
      ] },
    },
    '!bridged:beeper.local': {
      summary: { 'm.joined_member_count': 3, 'm.heroes': ['@whatsapp_15551234567:beeper.local', '@whatsappbot:beeper.local'] },
      state: { events: [member('@whatsapp_15551234567:beeper.local', 'Eileen'), member('@whatsappbot:beeper.local', 'WhatsApp bridge bot')] },
      timeline: { events: [msg('$e6', '@whatsapp_15551234567:beeper.local', "hey I'm near your place, can I drop in?", min(1))] },
    },
    '!group:example.org': {
      summary: { 'm.joined_member_count': 8 },
      state: { events: [{ type: 'm.room.name', content: { name: 'Climbing crew' } }] },
      timeline: { events: [msg('$e7', '@sam:example.org', 'anyone want to grab dinner now?', min(1))] },
    },
    '!nosummary:example.org': {
      state: { events: [member('@kai:example.org', 'Kai')] },
      timeline: { events: [msg('$e8', '@kai:example.org', 'flying to NYC next week btw', min(10))] },
    },
    '!old:example.org': {
      summary: { 'm.joined_member_count': 2 },
      timeline: { events: [msg('$e9', '@old:example.org', 'from three hours ago', min(180))] },
    },
  } },
}
const incrementalSync = {
  next_batch: 's2',
  rooms: { join: {
    '!dm:example.org': {   // no summary this time (unchanged); an edit of $e1 and a new message
      timeline: { events: [
        msg('$e1edit', '@jess:example.org', "* I'll be in Oakland Sunday, around?", min(0), { 'm.new_content': { msgtype: 'm.text', body: "I'll be in Oakland Sunday, around?" }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$e1' } }),
        msg('$e10', '@jess:example.org', 'ok see you then', min(0)),
      ] },
    },
    '!group:example.org': { timeline: { events: [msg('$e11', '@sam:example.org', 'pizza?', min(0))] } },
  } },
}

const calls = []
const realFetch = globalThis.fetch
let syncQueue = []
function fakeFetch(input, init = {}) {
  const u = new URL(String(input))
  calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), auth: init.headers?.authorization })
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (u.origin !== HS) return json(404, { errcode: 'M_NOT_FOUND' })
  if (init.headers?.authorization !== `Bearer ${TOKEN}`) return json(401, { errcode: 'M_UNKNOWN_TOKEN' })
  if (u.pathname === '/_matrix/client/v3/account/whoami') return json(200, { user_id: ME })
  if (u.pathname === '/_matrix/client/v3/sync') return json(200, syncQueue.shift() || { next_batch: 'sN', rooms: { join: {} } })
  const jm = u.pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/joined_members$/)
  if (jm) {
    const id = decodeURIComponent(jm[1])
    const joined = id === '!nosummary:example.org' ? { [ME]: { display_name: 'Malcolm' }, '@kai:example.org': { display_name: 'Kai' } } : {}
    return json(200, { joined })
  }
  return json(404, { errcode: 'M_UNRECOGNIZED' })
}

let ctx, matrix, person
before(async () => {
  globalThis.fetch = fakeFetch
  ctx = await buildContext({}, { dbPath: ':memory:' })
  matrix = ctx.plugins.sources.matrix
  person = ctx.people.create({ displayName: 'Malcolm' })
})
after(() => { globalThis.fetch = realFetch })

const config = { homeserver: HS, accessToken: TOKEN }
const by = (obs, id) => obs.find(o => o.dedupeKey === id)

test('manifest: owner-only chat source with url/secret/text setup and a 5 minute poll', () => {
  assert.equal(matrix.id, 'matrix')
  assert.deepEqual(matrix.kinds, ['mention'])
  assert.equal(matrix.intervalMin, 5)
  assert.deepEqual(matrix.setup.map(s => [s.key, s.type]), [['homeserver', 'url'], ['accessToken', 'secret'], ['rooms', 'text']])
  assert.equal(matrix.setup[2].optional, true)
  assert.deepEqual(matrix.setup[2].parse(' !a:x, !b:y ,'), ['!a:x', '!b:y'])
  assert.equal(matrix.ingest, undefined, 'poll-only')
})

test('first poll (no stored token): initial /sync with filter + bearer token, DM-sized rooms only, last hour only', async () => {
  syncQueue = [structuredClone(initialSync)]
  calls.length = 0
  const obs = await matrix.poll(ctx, person, config, null)

  const sync = calls.find(c => c.path === '/_matrix/client/v3/sync')
  assert.ok(sync, 'called /sync')
  assert.equal(sync.auth, `Bearer ${TOKEN}`)
  assert.equal(sync.params.since, undefined, 'no since on first poll')
  assert.equal(sync.params.timeout, '0')
  assert.equal(sync.params.set_presence, 'offline', 'polling never marks the owner online')
  const filter = JSON.parse(sync.params.filter)
  assert.ok(filter.room.timeline.types.includes('m.room.message'))
  assert.equal(filter.room.state.lazy_load_members, true)
  assert.ok(calls.some(c => c.path === '/_matrix/client/v3/account/whoami'), 'learned own user id')
  assert.ok(calls.some(c => c.path.endsWith('/rooms/!nosummary%3Aexample.org/joined_members')), 'counted members of the room without a summary')
  assert.ok(!calls.some(c => c.path.includes('/rooms/!dm%3Aexample.org/')), 'did not re-count rooms the summary already described')

  assert.deepEqual(obs.map(o => o.dedupeKey).sort(), ['$e1', '$e2', '$e3', '$e6', '$e8', '$e12'].sort())
  for (const o of obs) {
    assert.equal(o.kind, 'mention')
    assert.equal(o.until, null)
    assert.equal(o.data.provider, 'matrix')
    assert.ok(o.data.text.length <= 500, `${o.dedupeKey} text clipped`)
    assert.equal(o.raw, undefined, 'raw bodies are never stored')
    assert.equal(o.data.urgent, undefined, 'no urgency without the LLM')
  }
  const e1 = by(obs, '$e1')
  assert.equal(e1.data.text, "I'll be in Oakland Saturday, around?")
  assert.equal(e1.data.sender, 'Jess')
  assert.equal(e1.data.room, 'Jess')
  assert.equal(e1.data.isFromMe, false)
  assert.equal(e1.at, new Date(min(5)).toISOString())
  assert.equal(by(obs, '$e2').data.isFromMe, true)
  assert.equal(by(obs, '$e3').data.text.length, 500)
  assert.ok(by(obs, '$e3').data.text.endsWith('…'))
  const e6 = by(obs, '$e6')
  assert.equal(e6.data.sender, 'Eileen', 'bridge puppet shown by display name')
  assert.equal(e6.data.room, 'Eileen, WhatsApp bridge bot', 'unnamed room labelled by heroes')
  assert.equal(by(obs, '$e8').data.sender, 'Kai')
  assert.equal(by(obs, '$e7'), undefined, 'group chat (8 members) skipped')
  assert.equal(by(obs, '$e9'), undefined, 'message older than an hour skipped on first sync')
  assert.equal(by(obs, '$e4'), undefined, 'image skipped')
  assert.equal(by(obs, '$e5'), undefined, 'm.notice skipped')
  assert.equal(by(obs, '$enc1'), undefined, 'encrypted event skipped (counted and warned about, never stored)')
  assert.ok(JSON.parse(sync.params.filter).room.timeline.types.includes('m.room.encrypted'), 'asks for encrypted events so it can warn about them')

  assert.equal(ctx.db.kvGet(`matrix:${person.id}:since`), 's1', 'next_batch stored in kv')
  assert.equal(ctx.db.kvGet(`matrix:${person.id}:userId`), ME)
  assert.equal(ctx.db.kvGet(`matrix:${person.id}:rooms`)['!nosummary:example.org'].members, 2)
  assert.equal(ctx.db.get('select count(*) c from opportunities').c, 0, 'no opportunity without the LLM')

  // what core does with the result: ingest dedupes on event id
  const ins = await ctx.observations.ingest(person.id, 'matrix', obs)
  assert.equal(ins.length, 6)
  assert.equal((await ctx.observations.ingest(person.id, 'matrix', obs)).length, 0, 'same events again: nothing new')
})

test('second poll: incremental /sync with since, edits follow back to the original event id, member counts remembered', async () => {
  syncQueue = [structuredClone(incrementalSync)]
  calls.length = 0
  const obs = await matrix.poll(ctx, person, config, new Date().toISOString())
  const sync = calls.find(c => c.path === '/_matrix/client/v3/sync')
  assert.equal(sync.params.since, 's1')
  assert.ok(!calls.some(c => c.path.endsWith('/whoami')), 'own user id cached')
  assert.ok(!calls.some(c => c.path.includes('/joined_members')), 'member counts cached across polls (summary absent this time)')
  assert.deepEqual(obs.map(o => o.dedupeKey).sort(), ['$e1', '$e10'])
  assert.equal(by(obs, '$e1').data.text, "I'll be in Oakland Sunday, around?", 'edit carries the new body, no "* " prefix')
  assert.equal(by(obs, '$e11'), undefined, 'group chat still skipped without a summary')
  assert.equal(ctx.db.kvGet(`matrix:${person.id}:since`), 's2')

  const ins = await ctx.observations.ingest(person.id, 'matrix', obs)
  assert.equal(ins.length, 2)
  assert.equal(ins.find(r => r.dedupe_key === '$e1').updated, true, 'the edited message updated the existing row in place')
  assert.equal(ctx.db.get('select count(*) c from observations where person_id = ? and source_id = ?', person.id, 'matrix').c, 7)
})

test('rooms restriction: listed rooms are watched regardless of size, everything else ignored', async () => {
  const p2 = ctx.people.create({ displayName: 'Other' })
  syncQueue = [structuredClone(initialSync)]
  const obs = await matrix.poll(ctx, p2, { ...config, rooms: '!group:example.org, !dm:example.org' }, null)
  assert.deepEqual(obs.map(o => o.dedupeKey).sort(), ['$e1', '$e2', '$e3', '$e7', '$e12'].sort())
  assert.equal(by(obs, '$e7').data.room, 'Climbing crew')
})

test('with the LLM on: one batched extraction call; plans annotate mentions, urgent asks become a messageElevation opportunity for the owner', async () => {
  const p3 = ctx.people.create({ displayName: 'Malcolm3' })
  const llmCalls = []
  const realLlm = ctx.llm
  const sat = new Date(now + 2 * 864e5).toISOString(), satEnd = new Date(now + 3 * 864e5).toISOString()
  ctx.llm = {
    enabled: true,
    async json(args) {
      if (!/chat messages/.test(args.system)) return { verdict: 'suppress', reasoning: 'stub judge' }   // the Judge also calls ctx.llm.json
      llmCalls.push(args)
      const messages = JSON.parse(args.messages[0].content).messages
      const idx = text => messages.find(m => m.text.startsWith(text))?.i
      return { items: [
        { i: idx("I'll be in Oakland Saturday, around"), inferredPlace: 'Oakland', inferredWindow: { start: null, end: null, label: 'Saturday' }, subject: 'contact', urgent: false },
        { i: idx("I'll be in Oakland Saturday too"), inferredPlace: 'Oakland', inferredWindow: { start: sat, end: satEnd, label: 'Saturday' }, subject: 'owner', urgent: false },
        { i: idx('flying to NYC'), inferredPlace: 'New York', inferredWindow: { label: 'next week' }, urgent: false },   // no subject: speaker's own plan
        { i: idx("hey I'm near your place"), urgent: true, summary: 'Eileen is nearby and wants to drop in now.' },
        { i: idx('yes! come by'), urgent: true, summary: 'should be ignored: from the owner' },
      ].filter(it => it.i !== undefined) }   // a later batch may hold only some of these messages
    },
  }
  try {
    syncQueue = [structuredClone(initialSync)]
    const obs = await matrix.poll(ctx, p3, config, null)
    assert.equal(llmCalls.length, 1, 'exactly one LLM call for the batch')
    const sent = JSON.parse(llmCalls[0].messages[0].content)
    assert.equal(sent.messages.length, 6)
    assert.equal(sent.tz, p3.tz)
    assert.ok(sent.messages.every(m => m.text.length <= 500))

    // a contact's plan is NOT written as the owner's whereabouts (inTown would announce the owner is in Oakland)
    const e1 = by(obs, '$e1')
    assert.equal(e1.data.inferredPlace, undefined)
    assert.deepEqual(e1.data.contactPlan, { who: 'Jess', place: 'Oakland', window: { start: null, end: null, label: 'Saturday' } })
    assert.equal(e1.data.urgent, undefined)
    assert.equal(e1.until, null)
    assert.deepEqual(by(obs, '$e8').data.contactPlan, { who: 'Kai', place: 'New York', window: { label: 'next week' } }, 'no subject from the model: the speaker\'s own plan')
    // the owner's own plan is interoperable with the tweets shape: inferredPlace/inferredWindow + until
    const e12 = by(obs, '$e12')
    assert.equal(e12.data.inferredPlace, 'Oakland')
    assert.equal(e12.data.inferredWindow.start, sat)
    assert.equal(e12.until, satEnd)
    assert.equal(e12.data.contactPlan, undefined)
    const e6 = by(obs, '$e6')
    assert.equal(e6.data.urgent, true)
    assert.equal(e6.data.summary, 'Eileen is nearby and wants to drop in now.')
    assert.equal(by(obs, '$e2').data.urgent, undefined, 'the owner\'s own messages are never urgent')

    const opps = ctx.db.all('select * from opportunities where trigger_id = ?', 'matrix')
    assert.equal(opps.length, 1, 'one elevation, not one for the owner\'s own message')
    const o = opps[0]
    assert.equal(o.kind, 'messageElevation')
    assert.deepEqual(JSON.parse(o.participants), [p3.id])
    assert.equal(o.primary_id, p3.id)
    assert.equal(o.dedupe_key, 'elev:$e6')
    assert.match(o.summary, /^Eileen just messaged: "hey I'm near your place, can I drop in\?" — this looks like a right-now coordination ask\./)
    const ev = JSON.parse(o.evidence)
    assert.deepEqual(ev.map(e => [e.room, e.sender, e.text]), [['Eileen, WhatsApp bridge bot', 'Eileen', "hey I'm near your place, can I drop in?"]])
    const ttl = new Date(o.expires_at).getTime() - Date.now()
    assert.ok(ttl > 44 * 60e3 && ttl <= 45 * 60e3, `expires in ~45 min (got ${Math.round(ttl / 60e3)})`)
    assert.ok(ctx.db.get('select 1 from decisions where opportunity_id = ?', o.id), 'the Judge saw it')

    // the same event seen again (e.g. an edit) is still flagged urgent but does not re-elevate
    syncQueue = [{ next_batch: 's3', rooms: { join: { '!bridged:beeper.local': { timeline: { events: [initialSync.rooms.join['!bridged:beeper.local'].timeline.events[0]] } } } } }]
    const again = await matrix.poll(ctx, p3, config, null)
    assert.equal(llmCalls.length, 2)
    assert.equal(again.length, 1)
    assert.equal(again[0].data.urgent, true)
    assert.equal(ctx.db.all('select * from opportunities where trigger_id = ?', 'matrix').length, 1, 'elev:<event_id> dedupe held')
  } finally { ctx.llm = realLlm }
})

test('LLM failure degrades to plain mentions instead of failing the poll', async () => {
  const p4 = ctx.people.create({ displayName: 'Malcolm4' })
  const realLlm = ctx.llm
  ctx.llm = { enabled: true, async json() { throw new Error('model down') } }
  try {
    syncQueue = [structuredClone(initialSync)]
    const obs = await matrix.poll(ctx, p4, config, null)
    assert.equal(obs.length, 6)
    assert.ok(obs.every(o => o.data.urgent === undefined && o.data.inferredPlace === undefined))
  } finally { ctx.llm = realLlm }
})

test('bad token → poll throws a clear error (recorded by core as last_error); nothing stored', async () => {
  const p5 = ctx.people.create({ displayName: 'Malcolm5' })
  await assert.rejects(matrix.poll(ctx, p5, { homeserver: HS, accessToken: 'nope' }, null), /401 M_UNKNOWN_TOKEN.*access token rejected/)
  assert.equal(ctx.db.kvGet(`matrix:${p5.id}:since`), undefined)
  await assert.rejects(matrix.poll(ctx, p5, { homeserver: '', accessToken: TOKEN }, null), /homeserver URL missing/)
  // bare host is accepted and upgraded to https
  syncQueue = [{ next_batch: 'z', rooms: { join: {} } }]
  calls.length = 0
  await matrix.poll(ctx, p5, { homeserver: 'matrix.example.org/', accessToken: TOKEN }, null)
  assert.ok(calls.length >= 1)
})
