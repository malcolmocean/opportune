import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'
import tweets, { normalizeHandle } from '../sources/tweets/index.js'
import { regexInfer, parseWindow } from '../sources/tweets/infer.js'
import inTown, { isoWeek } from '../triggers/inTown/index.js'
import { cityFor, matchesCity, CITIES } from '../triggers/inTown/cities.js'

const env = { ...process.env, ANTHROPIC_API_KEY: '' }   // force the regex path; no network for the LLM
const TZ = 'America/Los_Angeles'
const day = (iso, tz = TZ) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })
const inDays = n => new Date(Date.now() + n * 864e5).toISOString()

describe('sources/tweets inference (regex fallback)', () => {
  const TUE = '2026-10-06T18:00:00Z'   // Tue Oct 6, 11:00 PT
  test('"in SF this week" → San Francisco, window through Sunday', () => {
    const r = regexInfer('in SF this week, who wants coffee', TUE, TZ)
    assert.equal(r.place, 'San Francisco')
    assert.equal(day(r.window.start), 'Oct 6')
    assert.equal(day(r.window.end), 'Oct 11')
    assert.equal(r.kind, 'hangout')
  })
  test('"landing in NYC Thursday" → New York on Thursday, travel', () => {
    const r = regexInfer('landing in NYC Thursday, dms open', TUE, TZ)
    assert.equal(r.place, 'New York')
    assert.equal(day(r.window.start), 'Oct 8')
    assert.equal(day(r.window.end), 'Oct 8')
  })
  test('"anyone at the Vulfpeck show tonight?" → no place, event, window tonight', () => {
    const r = regexInfer('anyone at the Vulfpeck show tonight?', TUE, TZ)
    assert.equal(r.place, null)
    assert.equal(r.kind, 'event')
    assert.equal(day(r.window.start), 'Oct 6')
  })
  test('date ranges and weekends', () => {
    const w = parseWindow('SF Oct 14-18 for a conference', new Date(TUE), TZ)
    assert.equal(day(w.start), 'Oct 14'); assert.equal(day(w.end), 'Oct 18')
    const we = parseWindow('Austin this weekend', new Date(TUE), TZ)
    assert.equal(day(we.start), 'Oct 10'); assert.equal(day(we.end), 'Oct 11')
    const nw = parseWindow('Berlin next week', new Date(TUE), TZ)
    assert.equal(day(nw.start), 'Oct 12'); assert.equal(day(nw.end), 'Oct 18')
    const nwe = parseWindow('Denver next weekend', new Date(TUE), TZ)
    assert.equal(day(nwe.start), 'Oct 17'); assert.equal(day(nwe.end), 'Oct 18')
  })
  test('is conservative: a city mentioned abstractly or in lowercase "la" is not a place', () => {
    assert.equal(regexInfer('San Francisco rents are insane lol', TUE, TZ).place, null)
    assert.equal(regexInfer('la la land is a good movie', TUE, TZ).place, null)
    assert.equal(regexInfer('back in LA tomorrow', TUE, TZ).place, 'Los Angeles')
    assert.equal(regexInfer('@sf_person thanks!', TUE, TZ).place, null)
    assert.equal(regexInfer('wrote a guide to nyc', TUE, TZ).place, null, 'bare "to <City>" is not a whereabouts')
    assert.equal(regexInfer('flying to NYC tmrw', TUE, TZ).place, 'New York')
  })
  test('normalizeHandle', () => {
    assert.equal(normalizeHandle('@Alex_Dev'), 'Alex_Dev')
    assert.equal(normalizeHandle('https://x.com/alexdev?s=21'), 'alexdev')
    assert.equal(normalizeHandle('alex.dev,'), 'alexdev')
  })
})

describe('sources/tweets poll (mocked Community Archive)', () => {
  let ctx, alex, realFetch, calls
  before(async () => {
    ctx = await buildContext(env, { dbPath: ':memory:' })
    alex = ctx.people.create({ displayName: 'Alex', tz: TZ })
    realFetch = globalThis.fetch
    calls = []
    const rows = [
      { tweet_id: '1001', username: 'alex', created_at: new Date(Date.now() - 3600e3).toISOString(), full_text: 'landing in SF Thursday, who\'s around?', reply_to_username: null },
      { tweet_id: '1002', username: 'alex', created_at: new Date(Date.now() - 7200e3).toISOString(), full_text: 'RT @someone: in SF this week', reply_to_username: null },
      { tweet_id: '1003', username: 'alex', created_at: new Date(Date.now() - 9000e3).toISOString(), full_text: 'thinking about pipes and pure functions', reply_to_username: 'bob' },
    ]
    globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => rows, text: async () => '' } }
  })
  after(() => { globalThis.fetch = realFetch })

  test('emits mention observations with tweet id dedupeKey, skips retweets, queries the right endpoint', async () => {
    const obs = await tweets.poll(ctx, alex, { handle: '@Alex' }, null)
    assert.equal(calls.length, 1)
    const u = new URL(calls[0])
    assert.equal(u.pathname, '/rest/v1/enriched_tweets')
    assert.equal(u.searchParams.get('username'), 'ilike.Alex')
    assert.ok(u.searchParams.get('created_at').startsWith('gte.'))
    const since = new Date(u.searchParams.get('created_at').slice(4))
    assert.ok(Date.now() - since.getTime() > 6.9 * 864e5 && Date.now() - since.getTime() < 7.1 * 864e5, 'first run bounded to 7 days')

    assert.equal(obs.length, 2, 'RT dropped')
    assert.ok(obs.every(o => o.kind === 'mention' && o.data.provider === 'twitter'))
    assert.ok(new Date(obs[0].at) < new Date(obs[1].at), 'oldest first')
    const sf = obs.find(o => o.dedupeKey === '1001')
    assert.equal(sf.data.url, 'https://x.com/alex/status/1001')
    assert.equal(sf.data.inferredPlace, 'San Francisco')
    assert.ok(sf.data.inferredWindow?.start)
    assert.equal(sf.until, sf.data.inferredWindow.end)
    const bland = obs.find(o => o.dedupeKey === '1003')
    assert.equal(bland.data.inferredPlace, null)
    assert.equal(bland.data.inReplyTo, 'bob')
  })
  test('already-ingested tweets are not re-emitted; lastPollIso narrows the query', async () => {
    await ctx.observations.ingest(alex.id, 'tweets', await tweets.poll(ctx, alex, { handle: 'alex' }, null))
    const again = await tweets.poll(ctx, alex, { handle: 'alex' }, new Date(Date.now() - 3 * 3600e3).toISOString())
    assert.equal(again.length, 0)
    const since = new Date(new URL(calls.at(-1)).searchParams.get('created_at').slice(4))
    assert.ok(Date.now() - since.getTime() < 2 * 864e5, 'uses lastPollIso (minus overlap), not 7 days')
  })
})

describe('triggers/inTown', () => {
  let ctx, alex, jess, sam
  const SF = { lat: 37.7745, lng: -122.4365 }, AUSTIN = { lat: 30.27, lng: -97.74 }
  before(async () => {
    ctx = await buildContext(env, { dbPath: ':memory:' })
    alex = ctx.people.create({ displayName: 'Alex', tz: 'America/Chicago' })
    jess = ctx.people.create({ displayName: 'Jess', tz: TZ })
    sam = ctx.people.create({ displayName: 'Sam', tz: TZ })
    ctx.people.addPlace(alex.id, { name: 'home', ...AUSTIN })
    ctx.people.addPlace(jess.id, { name: 'home', ...SF })
    ctx.people.addPlace(sam.id, { name: 'home', ...SF })
    ctx.people.setRel(jess.id, alex.id, { wantMore: true })
    ctx.people.setRel(alex.id, jess.id, { wantMore: false })
    ctx.people.setRel(sam.id, alex.id, { wantMore: false })   // Sam is a friend but nobody wants more
    ctx.people.setRel(alex.id, sam.id, { wantMore: false })
  })
  const mention = (text, place, window, id = String(Math.random())) => ({
    kind: 'mention', at: new Date().toISOString(), dedupeKey: id, data: { text, provider: 'twitter', url: `https://x.com/alex/status/${id}`, inferredPlace: place, inferredWindow: window },
  })
  const opps = () => ctx.db.all(`select * from opportunities where kind = 'inTown' order by created_at`).map(r => ({ ...r, participants: JSON.parse(r.participants), evidence: JSON.parse(r.evidence) }))

  test('city table reverse lookup', () => {
    assert.equal(cityFor(SF, ctx.geo.distanceM).slug, 'san-francisco')
    assert.equal(cityFor({ lat: 37.87, lng: -122.27 }, ctx.geo.distanceM).slug, 'oakland', 'Berkeley → Oakland')
    assert.equal(cityFor({ lat: 0, lng: 0 }, ctx.geo.distanceM), null)
    const sf = CITIES.find(c => c.slug === 'san-francisco'), la = CITIES.find(c => c.slug === 'los-angeles')
    assert.ok(matchesCity('Mission, San Francisco', sf))
    assert.ok(matchesCity('SF', sf))
    assert.ok(!matchesCity('La Jolla', la))
    assert.ok(matchesCity('LA', la))
    assert.ok(!matchesCity('Austin', sf))
  })
  test('emits inTown to the local friend who wants more, with window and dedupe', async () => {
    const window = { start: inDays(2), end: inDays(6) }
    await ctx.observations.ingest(alex.id, 'tweets', [mention('in SF next week for a conf', 'San Francisco', window, 't1')])
    const rows = opps()
    assert.equal(rows.length, 1, 'only Jess (Sam: nobody wants more)')
    const o = rows[0]
    assert.equal(o.primary_id, jess.id)
    assert.deepEqual(o.participants, [alex.id, jess.id])
    assert.match(o.summary, /^Alex tweeted they're in SF /)
    assert.match(o.summary, new RegExp(`${day(window.start)}–${day(window.end).replace(/^\w+ /, '')}|${day(window.start)}–${day(window.end)}`))
    assert.match(o.summary, /Jess \(SF\) wants to see more of Alex\./)
    assert.equal(o.expires_at, new Date(window.end).toISOString())
    assert.equal(o.dedupe_key, `intown:${alex.id}:${jess.id}:san-francisco:${isoWeek(window.start)}`)
    assert.equal(o.evidence[0].tweetUrl, 'https://x.com/alex/status/t1')
    // a second tweet about the same visit the same week is one occurrence
    await ctx.observations.ingest(alex.id, 'tweets', [mention('SF people, who is around?', 'SF', window, 't2')])
    assert.equal(opps().length, 1)
  })
  test('no window → expires in ~7 days; mentions without a place or already-past are ignored', async () => {
    await ctx.observations.ingest(alex.id, 'tweets', [mention('heading to Berlin', 'Berlin', null, 't3')])   // nobody lives there
    await ctx.observations.ingest(alex.id, 'tweets', [mention('nice weather', null, null, 't4')])
    await ctx.observations.ingest(alex.id, 'tweets', [mention('was in SF last month', 'San Francisco', { start: inDays(-30), end: inDays(-25) }, 't5')])
    assert.equal(opps().length, 1)
    const ctx2 = await buildContext(env, { dbPath: ':memory:' })
    const a = ctx2.people.create({ displayName: 'Alex' }), j = ctx2.people.create({ displayName: 'Jess' })
    ctx2.people.addPlace(j.id, { name: 'home', ...SF })
    ctx2.people.setRel(a.id, j.id, { wantMore: true })   // only A wants more; still fine
    const [opp] = inTown.run(ctx2, { observation: { ...mention('in SF!', 'San Francisco', null), person_id: a.id }, person: a })
    assert.ok(opp)
    const ttl = new Date(opp.expiresAt) - Date.now()
    assert.ok(ttl > 6.9 * 864e5 && ttl < 7.1 * 864e5)
    assert.match(opp.summary, /Alex wants to see more of Jess \(SF\)\./)
  })
  test('a local who lives in the same city as the tweeter is not told', async () => {
    const ctx2 = await buildContext(env, { dbPath: ':memory:' })
    const a = ctx2.people.create({ displayName: 'Alex' }), j = ctx2.people.create({ displayName: 'Jess' })
    ctx2.people.addPlace(a.id, { name: 'home', lat: 37.79, lng: -122.41 })
    ctx2.people.addPlace(j.id, { name: 'home', ...SF })
    ctx2.people.setRel(j.id, a.id, { wantMore: true })
    assert.deepEqual(inTown.run(ctx2, { observation: mention('back in SF', 'San Francisco', null), person: a }), [])
  })
  test('bonus: mentions a party the local is hosting in the window', async () => {
    const window = { start: inDays(9), end: inDays(13) }
    const party = new Date(Date.now() + 10 * 864e5)
    await ctx.observations.ingest(jess.id, 'manual', [{ kind: 'event', at: party.toISOString(), until: new Date(party.getTime() + 3 * 3600e3).toISOString(), dedupeKey: 'hw', data: { title: 'Housewarming!', provider: 'seed', attendees: [] } }])
    await ctx.observations.ingest(alex.id, 'tweets', [mention(`SF ${day(window.start)}-${day(window.end)}`, 'San Francisco', window, 't6')])
    const o = opps().at(-1)
    assert.match(o.summary, new RegExp(`Jess is hosting "Housewarming!" on ${party.toLocaleDateString('en-US', { weekday: 'short', timeZone: TZ })} — invite them\\?`))
    assert.equal(o.evidence[1].kind, 'event')
  })
})
