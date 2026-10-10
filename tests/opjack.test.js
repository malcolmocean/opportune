// sources/opjack against a scripted fake opjack server (globalThis.fetch is replaced for this
// process; node --test runs each file in its own process). The live API is never called.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'

const BASE = 'https://client.opjack.com'
const ENV_BASE = 'https://opjack.example.org'
const TOKEN = 'opj_test_read_token'
const ENV_TOKEN = 'opj_env_token'
const ME = '@malcolm:opjack.example'
const now = Date.now()
const min = n => now - n * 60e3
const iso = ms => new Date(ms).toISOString()
const long = 'x'.repeat(900)

// Real /v1/activity shape (field names observed against the live server, 2026-10-10):
// { chats: [{ chat: { id, accountID, network, type, bridged, title, participants: { items: [{ id,
//   fullName, username, isSelf, isNetworkBot, isBridgePuppet }], total, hasMore }, unreadCount,
//   lastActivity, lastReadMessageID, preview, isArchived, isMuted, isLowPriority, isEncrypted,
//   remoteID?, membersComplete }, messages: [{ id, chatID, accountID, senderID, senderName,
//   sortKey, timestamp, text, formatted, type, attachments, isSender, replyToID, reactions,
//   editedTimestamp, isDeleted, seen, matrixType }] }], hasMore, newestTimestamp }
const part = (id, fullName, extra = {}) => ({ id, fullName, username: null, isSelf: id === ME, isNetworkBot: false, isBridgePuppet: false, ...extra })
const chat = (id, network, type, title, people, extra = {}) => ({
  id, accountID: network, network, type, bridged: true, title,
  participants: { items: [part(ME, 'Malcolm'), ...people], total: people.length + 1, hasMore: false },
  unreadCount: 0, lastActivity: iso(now), lastReadMessageID: null, preview: null,
  isArchived: false, isMuted: false, isLowPriority: false, isEncrypted: false, membersComplete: true, ...extra,
})
const msg = (id, chatID, senderID, senderName, text, ts, extra = {}) => ({
  id, chatID, accountID: 'whatsapp', senderID, senderName, sortKey: `${String(ts).padStart(13, '0')}:${id}`, timestamp: iso(ts),
  text, formatted: null, type: 'text', attachments: [], isSender: senderID === ME, replyToID: null, reactions: [],
  editedTimestamp: null, isDeleted: false, seen: {}, matrixType: 'm.room.message', ...extra,
})

const JESS = '@whatsapp_1:opjack.example', EILEEN = '@signal_2:opjack.example', SAM = '@telegram_3:opjack.example', KAI = '@whatsapp_4:opjack.example', BOT = '@whatsappbot:opjack.example'
const chats = {
  jess: chat('!jess', 'whatsapp', 'single', 'Jess', [part(JESS, 'Jess'), part(BOT, 'WhatsApp bridge bot', { isNetworkBot: true })]),   // 3 participants incl. bot, like the real thing
  eileen: chat('!eileen', 'signal', 'single', 'Eileen', [part(EILEEN, 'Eileen')]),
  group: chat('!group', 'telegram', 'group', 'Climbing crew', [part(SAM, 'Sam'), part('@a', 'A'), part('@b', 'B'), part('@c', 'C'), part('@d', 'D')]),
  trio: chat('!trio', 'whatsapp', 'group', 'Kai + Malcolm', [part(KAI, 'Kai')]),      // a "group" of 2: DM-ish by size
  self: chat('!self', 'whatsapp', 'self', 'Malcolm (you)', []),
  mgmt: chat('!mgmt', 'whatsapp', 'bridge-mgmt', 'WhatsApp bridge bot', [part(BOT, 'WhatsApp bridge bot', { isNetworkBot: true })]),
  enc: chat('!enc', 'signal', 'single', 'Secret', [part('@signal_9:opjack.example', 'Nine')], { isEncrypted: true }),
}
const page1 = {
  chats: [
    { chat: chats.jess, messages: [
      msg('m1', '!jess', JESS, 'Jess', "I'll be in Oakland Saturday, around?", min(50)),
      msg('m2', '!jess', ME, 'Malcolm', 'yes! come by', min(49)),
      msg('m3', '!jess', JESS, 'Jess', long, min(48)),
      msg('m12', '!jess', ME, 'Malcolm', "I'll be in Oakland Saturday too, coffee?", min(47)),
      msg('m4', '!jess', JESS, 'Jess', 'photo.jpg', min(46), { type: 'image', attachments: [{ type: 'image', url: 'mxc://x/y', mimeType: 'image/jpeg', fileName: 'photo.jpg', size: 1, width: 1, height: 1, durationMs: null }] }),
      msg('m5', '!jess', BOT, 'WhatsApp bridge bot', 'bridge notice', min(45), { type: 'notice', matrixType: 'm.room.message' }),
      msg('m13', '!jess', JESS, 'Jess', 'deleted', min(44), { isDeleted: true, text: '' }),
    ] },
    { chat: chats.group, messages: [msg('m7', '!group', SAM, 'Sam', 'anyone want to grab dinner now?', min(40))] },
    { chat: chats.trio, messages: [msg('m8', '!trio', KAI, null, 'flying to NYC next week btw', min(30))] },   // senderName missing: fall back to participant fullName
    { chat: chats.self, messages: [msg('m14', '!self', ME, 'Malcolm', 'note to self', min(29))] },
    { chat: chats.mgmt, messages: [msg('m15', '!mgmt', BOT, 'WhatsApp bridge bot', 'ping', min(28), { type: 'notice' })] },
    { chat: chats.enc, messages: [msg('m16', '!enc', '@signal_9:opjack.example', 'Nine', '(encrypted message)', min(27), { type: 'unknown', matrixType: 'm.room.encrypted' })] },
  ],
  hasMore: true,
  newestTimestamp: iso(min(27)),
}
const page2 = {
  chats: [{ chat: chats.eileen, messages: [msg('m6', '!eileen', EILEEN, 'Eileen', "hey I'm near your place, can I drop in?", min(1))] }],
  hasMore: false,
  newestTimestamp: iso(min(1)),
}
const incremental = {
  chats: [{ chat: chats.jess, messages: [msg('m10', '!jess', JESS, 'Jess', 'ok see you then', min(0))] }, { chat: chats.group, messages: [msg('m11', '!group', SAM, 'Sam', 'pizza?', min(0))] }],
  hasMore: false,
  newestTimestamp: iso(min(0)),
}
const empty = { chats: [], hasMore: false, newestTimestamp: null }

const calls = []
const realFetch = globalThis.fetch
let queue = []
function fakeFetch(input, init = {}) {
  const u = new URL(String(input))
  calls.push({ origin: u.origin, path: u.pathname, params: Object.fromEntries(u.searchParams), auth: init.headers?.authorization })
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (u.origin !== BASE && u.origin !== ENV_BASE) return json(404, { code: 'not_found', message: 'no such host' })
  if (![`Bearer ${TOKEN}`, `Bearer ${ENV_TOKEN}`].includes(init.headers?.authorization)) return json(401, { code: 'unauthorized', message: 'missing or unknown bearer token' })
  if (u.pathname === '/v1/activity') {
    if (!u.searchParams.get('since')) return json(400, { code: 'bad_request', message: 'missing field since' })
    return json(200, queue.shift() || empty)
  }
  return json(404, { code: 'not_found', message: 'no such route' })
}

let ctx, opjack, person
before(async () => {
  globalThis.fetch = fakeFetch
  ctx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '', OPJACK_TOKEN: '', OPJACK_URL: '' }, { dbPath: ':memory:' })
  opjack = ctx.plugins.sources.opjack
  person = ctx.people.create({ displayName: 'Malcolm' })
})
after(() => { globalThis.fetch = realFetch })

const config = { url: BASE, token: TOKEN }
const by = (obs, id) => obs.find(o => o.dedupeKey === id)
const activityCalls = () => calls.filter(c => c.path === '/v1/activity')

test('manifest: owner-only chat source with url/secret/text setup and a 3 minute poll', () => {
  assert.equal(opjack.id, 'opjack')
  assert.equal(opjack.name, 'Chats (opjack)')
  assert.deepEqual(opjack.kinds, ['mention'])
  assert.equal(opjack.intervalMin, 3)
  assert.deepEqual(opjack.setup.map(s => [s.key, s.type]), [['url', 'url'], ['token', 'secret'], ['networks', 'text']])
  assert.equal(opjack.setup[0].default, BASE)
  assert.match(opjack.setup[1].label, /client\.opjack\.com\/account/)
  assert.equal(opjack.setup[2].optional, true)
  assert.deepEqual(opjack.setup[2].parse(' whatsapp, signal ,'), ['whatsapp', 'signal'])
  assert.equal(opjack.setup[2].parse(''), null)
  assert.equal(opjack.ingest, undefined, 'poll-only')
})

test('first poll (no cursor): since = last hour, pages while hasMore, DM-ish chats only, text only', async () => {
  queue = [structuredClone(page1), structuredClone(page2)]
  calls.length = 0
  const obs = await opjack.poll(ctx, person, config, null)

  const a = activityCalls()
  assert.equal(a.length, 2, 'two pages')
  assert.ok(a.every(c => c.auth === `Bearer ${TOKEN}` && c.origin === BASE))
  assert.equal(a[0].params.limit, '200')
  const since0 = new Date(a[0].params.since).getTime()
  assert.ok(now - since0 >= 59 * 60e3 && now - since0 <= 61 * 60e3, 'first poll looks back one hour')
  assert.equal(a[1].params.since, page1.newestTimestamp, 'second page starts at the first page\'s newestTimestamp')

  assert.deepEqual(obs.map(o => o.dedupeKey).sort(), ['m1', 'm2', 'm3', 'm12', 'm8', 'm6'].sort())
  for (const o of obs) {
    assert.equal(o.kind, 'mention')
    assert.equal(o.until, null)
    assert.equal(o.data.provider, 'opjack')
    assert.ok(o.data.text.length <= 500, `${o.dedupeKey} text clipped`)
    assert.equal(o.raw, undefined, 'raw bodies are never stored')
    assert.equal(o.data.urgent, undefined, 'no urgency without the LLM')
  }
  const m1 = by(obs, 'm1')
  assert.equal(m1.data.text, "I'll be in Oakland Saturday, around?")
  assert.equal(m1.data.sender, 'Jess')
  assert.equal(m1.data.chat, 'Jess')
  assert.equal(m1.data.network, 'whatsapp')
  assert.equal(m1.data.isFromMe, false)
  assert.equal(m1.at, iso(min(50)))
  assert.equal(by(obs, 'm2').data.isFromMe, true, 'own messages kept as mentions with isFromMe')
  assert.equal(by(obs, 'm3').data.text.length, 500)
  assert.ok(by(obs, 'm3').data.text.endsWith('…'))
  assert.equal(by(obs, 'm8').data.sender, 'Kai', 'missing senderName falls back to the participant\'s fullName')
  assert.equal(by(obs, 'm8').data.chat, 'Kai + Malcolm', '2-person "group" counts as a DM by size')
  assert.equal(by(obs, 'm6').data.network, 'signal')
  assert.equal(by(obs, 'm7'), undefined, 'group chat (6 participants) skipped')
  assert.equal(by(obs, 'm4'), undefined, 'image skipped')
  assert.equal(by(obs, 'm5'), undefined, 'bridge notice skipped')
  assert.equal(by(obs, 'm13'), undefined, 'deleted message skipped')
  assert.equal(by(obs, 'm14'), undefined, 'self chat skipped')
  assert.equal(by(obs, 'm15'), undefined, 'bridge management room skipped')
  assert.equal(by(obs, 'm16'), undefined, 'encrypted chat skipped (counted and warned about, never stored)')

  assert.equal(ctx.db.kvGet(`opjack:${person.id}:since`), page2.newestTimestamp, 'newest timestamp stored in kv')
  assert.equal(ctx.db.get('select count(*) c from opportunities').c, 0, 'no opportunity without the LLM')

  // what core does with the result: ingest dedupes on message id
  const ins = await ctx.observations.ingest(person.id, 'opjack', obs)
  assert.equal(ins.length, 6)
  assert.equal((await ctx.observations.ingest(person.id, 'opjack', obs)).length, 0, 'same messages again: nothing new')
})

test('second poll: since = stored cursor (not lastPollIso), cursor advances', async () => {
  queue = [structuredClone(incremental)]
  calls.length = 0
  const obs = await opjack.poll(ctx, person, config, iso(min(3)))
  const a = activityCalls()
  assert.equal(a.length, 1)
  assert.equal(a[0].params.since, page2.newestTimestamp)
  assert.deepEqual(obs.map(o => o.dedupeKey), ['m10'])
  assert.equal(by(obs, 'm11'), undefined, 'group chat still skipped')
  assert.equal(ctx.db.kvGet(`opjack:${person.id}:since`), incremental.newestTimestamp)

  // an empty poll leaves the cursor where it was
  queue = [structuredClone(empty)]
  assert.deepEqual(await opjack.poll(ctx, person, config, iso(min(0))), [])
  assert.equal(ctx.db.kvGet(`opjack:${person.id}:since`), incremental.newestTimestamp)
})

test('no cursor but a lastPollIso from core: start there instead of an hour ago', async () => {
  const p = ctx.people.create({ displayName: 'Resumer' })
  queue = [structuredClone(empty)]
  calls.length = 0
  await opjack.poll(ctx, p, config, iso(min(20)))
  assert.equal(activityCalls()[0].params.since, iso(min(20)))
  assert.equal(ctx.db.kvGet(`opjack:${p.id}:since`), iso(min(20)), 'remembers where it started looking even with no messages')
})

test('networks filter: only listed networks, case-insensitive', async () => {
  const p2 = ctx.people.create({ displayName: 'Other' })
  queue = [structuredClone(page1), structuredClone(page2)]
  const obs = await opjack.poll(ctx, p2, { ...config, networks: 'Signal, telegram' }, null)
  assert.deepEqual(obs.map(o => o.dedupeKey), ['m6'], 'whatsapp DMs dropped, telegram group still too big, signal DM kept')
})

test('blank url and token fall back to OPJACK_URL / OPJACK_TOKEN from the node env', async () => {
  const envCtx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '', OPJACK_TOKEN: ENV_TOKEN, OPJACK_URL: ENV_BASE }, { dbPath: ':memory:' })
  const p = envCtx.people.create({ displayName: 'Envy' })
  queue = [structuredClone(page2)]
  calls.length = 0
  const obs = await envCtx.plugins.sources.opjack.poll(envCtx, p, { url: '', token: '' }, null)
  assert.equal(obs.length, 1)
  assert.equal(activityCalls()[0].origin, ENV_BASE)
  assert.equal(activityCalls()[0].auth, `Bearer ${ENV_TOKEN}`)

  // no url anywhere: the public default; a bare host is upgraded to https
  const plainCtx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '', OPJACK_TOKEN: '', OPJACK_URL: '' }, { dbPath: ':memory:' })
  const q = plainCtx.people.create({ displayName: 'Plain' })
  queue = [structuredClone(empty), structuredClone(empty)]
  calls.length = 0
  await plainCtx.plugins.sources.opjack.poll(plainCtx, q, { token: TOKEN }, null)
  assert.equal(activityCalls()[0].origin, BASE)
  await plainCtx.plugins.sources.opjack.poll(plainCtx, q, { url: 'client.opjack.com/', token: TOKEN }, null)
  assert.equal(activityCalls()[1].origin, BASE)
})

test('with the LLM on: one batched extraction call; plans annotate mentions, urgent asks become a messageElevation opportunity for the owner', async () => {
  const p3 = ctx.people.create({ displayName: 'Malcolm3' })
  const llmCalls = []
  const realLlm = ctx.llm
  const sat = iso(now + 2 * 864e5), satEnd = iso(now + 3 * 864e5)
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
      ].filter(it => it.i !== undefined) }
    },
  }
  try {
    queue = [structuredClone(page1), structuredClone(page2)]
    const obs = await opjack.poll(ctx, p3, config, null)
    assert.equal(llmCalls.length, 1, 'exactly one LLM call for the batch, across pages')
    const sent = JSON.parse(llmCalls[0].messages[0].content)
    assert.equal(sent.messages.length, 6)
    assert.equal(sent.tz, p3.tz)
    assert.ok(sent.messages.every(m => m.text.length <= 500))
    assert.ok(sent.messages.every(m => 'network' in m && 'chat' in m && 'isFromMe' in m))

    // a contact's plan is NOT written as the owner's whereabouts (inTown would announce the owner is in Oakland)
    const m1 = by(obs, 'm1')
    assert.equal(m1.data.inferredPlace, undefined)
    assert.deepEqual(m1.data.contactPlan, { who: 'Jess', place: 'Oakland', window: { start: null, end: null, label: 'Saturday' } })
    assert.equal(m1.data.urgent, undefined)
    assert.equal(m1.until, null)
    assert.deepEqual(by(obs, 'm8').data.contactPlan, { who: 'Kai', place: 'New York', window: { label: 'next week' } }, 'no subject from the model: the speaker\'s own plan')
    // the owner's own plan is interoperable with the tweets shape: inferredPlace/inferredWindow + until
    const m12 = by(obs, 'm12')
    assert.equal(m12.data.inferredPlace, 'Oakland')
    assert.equal(m12.data.inferredWindow.start, sat)
    assert.equal(m12.until, satEnd)
    assert.equal(m12.data.contactPlan, undefined)
    const m6 = by(obs, 'm6')
    assert.equal(m6.data.urgent, true)
    assert.equal(m6.data.summary, 'Eileen is nearby and wants to drop in now.')
    assert.equal(by(obs, 'm2').data.urgent, undefined, 'the owner\'s own messages are never urgent')

    const opps = ctx.db.all('select * from opportunities where trigger_id = ?', 'opjack')
    assert.equal(opps.length, 1, 'one elevation, not one for the owner\'s own message')
    const o = opps[0]
    assert.equal(o.kind, 'messageElevation')
    assert.deepEqual(JSON.parse(o.participants), [p3.id])
    assert.equal(o.primary_id, p3.id)
    assert.equal(o.dedupe_key, 'elev:m6')
    assert.match(o.summary, /^Eileen just messaged \(signal\): "hey I'm near your place, can I drop in\?" — this looks like a right-now coordination ask\. Eileen is nearby/)
    const ev = JSON.parse(o.evidence)
    assert.deepEqual(ev, [{ chat: 'Eileen', sender: 'Eileen', text: "hey I'm near your place, can I drop in?", at: iso(min(1)), network: 'signal' }])
    const ttl = new Date(o.expires_at).getTime() - Date.now()
    assert.ok(ttl > 44 * 60e3 && ttl <= 45 * 60e3, `expires in ~45 min (got ${Math.round(ttl / 60e3)})`)
    assert.ok(ctx.db.get('select 1 from decisions where opportunity_id = ?', o.id), 'the Judge saw it')

    // the same message seen again is still flagged urgent but does not re-elevate
    queue = [structuredClone(page2)]
    const again = await opjack.poll(ctx, p3, config, null)
    assert.equal(llmCalls.length, 2)
    assert.equal(again.length, 1)
    assert.equal(again[0].data.urgent, true)
    assert.equal(ctx.db.all('select * from opportunities where trigger_id = ?', 'opjack').length, 1, 'elev:<message id> dedupe held')
  } finally { ctx.llm = realLlm }
})

test('LLM failure degrades to plain mentions instead of failing the poll', async () => {
  const p4 = ctx.people.create({ displayName: 'Malcolm4' })
  const realLlm = ctx.llm
  ctx.llm = { enabled: true, async json() { throw new Error('model down') } }
  try {
    queue = [structuredClone(page1), structuredClone(page2)]
    const obs = await opjack.poll(ctx, p4, config, null)
    assert.equal(obs.length, 6)
    assert.ok(obs.every(o => o.data.urgent === undefined && o.data.inferredPlace === undefined))
  } finally { ctx.llm = realLlm }
})

test('bad token → error with code bad_token (lands in source_configs.last_error); nothing stored', async () => {
  const p5 = ctx.people.create({ displayName: 'Malcolm5' })
  await assert.rejects(opjack.poll(ctx, p5, { url: BASE, token: 'nope' }, null), e => {
    assert.equal(e.code, 'bad_token')
    assert.equal(e.status, 401)
    assert.match(e.message, /401 unauthorized.*token rejected.*\/account/)
    return true
  })
  assert.equal(ctx.db.kvGet(`opjack:${p5.id}:since`), undefined)
  await assert.rejects(opjack.poll(ctx, p5, { url: BASE, token: '' }, null), e => e.code === 'bad_token' && /no token/.test(e.message))

  // core records it: pollDue stores e.message as last_error and keeps going
  ctx.sources.connect(p5.id, 'opjack', { url: BASE, token: 'nope' })
  await ctx.sources.pollDue()
  const sc = ctx.sources.forPerson(p5.id).find(s => s.source_id === 'opjack')
  assert.match(sc.last_error, /token rejected/)

  // other server errors are not bad_token
  globalThis.fetch = () => new Response(JSON.stringify({ code: 'internal', message: 'boom' }), { status: 500 })
  try {
    await assert.rejects(opjack.poll(ctx, p5, config, null), e => e.code === undefined && e.status === 500 && /500 internal/.test(e.message))
  } finally { globalThis.fetch = fakeFetch }
})
