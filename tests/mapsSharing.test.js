import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildContext } from '../core/context.js'
import mapsSharing, { normalizeCookies, validateCookies, fetchShared, resolveContact, ingestContacts, toObservation, SOURCE_ID } from '../sources/mapsSharing/index.js'

const COOKIES = [
  '# Netscape HTTP Cookie File',
  '.google.com\tTRUE\t/\tTRUE\t1790000000\tSID\tabc',
  '#HttpOnly_.google.com\tTRUE\t/\tTRUE\t1790000000\t__Secure-1PSID\tsecret1',
  '.google.com\tTRUE\t/\tTRUE\t1790000000\t__Secure-3PSID\tsecret3',
  '.youtube.com\tTRUE\t/\tTRUE\t1790000000\tVISITOR_INFO1_LIVE\tzzz',
].join('\r\n')

const HOME = { lat: 37.7745, lng: -122.4365 }
const OFFICE = { lat: 37.7700, lng: -122.4200 }
const nowMs = () => Date.now() - 60e3
const contact = (id, fullName, pt, extra = {}) => ({ id, fullName, nickname: fullName.split(' ')[0], lat: pt.lat, lng: pt.lng, acc: 20, timestamp: nowMs(), address: '1 Some St', battery: 77, charging: false, ...extra })

async function setup() {
  const ctx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '' }, { dbPath: ':memory:' })
  const mal = ctx.people.create({ displayName: 'Malcolm' })
  ctx.people.update(mal.id, { onboarding: { step: 'done' } })
  ctx.people.addPlace(mal.id, { name: 'home', ...HOME, radiusM: 120 })
  ctx.people.addPlace(mal.id, { name: 'office', ...OFFICE, radiusM: 150 })
  const jess = ctx.people.create({ displayName: 'Jess' })
  ctx.people.update(jess.id, { onboarding: { step: 'done' } })
  ctx.people.setRel(mal.id, jess.id, { tier: 'friend', wantMore: true })
  ctx.people.setRel(jess.id, mal.id, { tier: 'friend', wantMore: true })
  ctx.sources.connect(mal.id, SOURCE_ID, { email: 'malcolm@example.com', cookies: normalizeCookies(COOKIES) })
  return { ctx, mal, jess }
}
const resetPoll = ctx => ctx.db.run('update source_configs set last_poll_at = null')
const locs = (ctx, personId) => ctx.observations.recent(personId, { kinds: ['location'], limit: 100 }).filter(o => o.source_id === SOURCE_ID)

test('normalizeCookies keeps google.com lines, uncomments #HttpOnly_, drops the rest; validateCookies needs a PSID', () => {
  const c = normalizeCookies(COOKIES)
  assert.ok(!c.includes('\r'))
  assert.ok(!c.includes('youtube'))
  assert.ok(!c.includes('# Netscape'))
  assert.ok(!c.includes('#HttpOnly_'))
  assert.equal(c.split('\n').filter(Boolean).length, 3)
  assert.deepEqual(validateCookies(c).sort(), ['SID', '__Secure-1PSID', '__Secure-3PSID'])
  assert.throws(() => validateCookies('.google.com\tTRUE\t/\tTRUE\t1\tSID\tabc\n'), /__Secure-1PSID/)
  assert.throws(() => validateCookies(''), /__Secure-1PSID/)
})

test('fetchShared writes cookies to a temp file, parses JSON, maps error exits, cleans up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maps-test-'))
  // stub "python" = node; the stub echoes back what it was given so we can check the cookie file contents
  const ok = join(dir, 'ok.js')
  writeFileSync(ok, `import { readFileSync } from 'node:fs'
const a = process.argv; const cookies = readFileSync(a[a.indexOf('--cookies') + 1], 'utf8'); const email = a[a.indexOf('--email') + 1]
console.log(JSON.stringify({ me: { lat: 1, lng: 2, timestamp: 1000, email, cookieLines: cookies.trim().split('\\n').length }, contacts: [] }))`)
  const bad = join(dir, 'bad.js')
  writeFileSync(bad, `console.log(JSON.stringify({ error: 'invalid_cookies', message: 'Does not seem we have a valid session.' })); process.exit(2)`)
  const config = { email: 'x@y.z', cookies: normalizeCookies(COOKIES) }
  const out = await fetchShared(config, { python: process.execPath, script: ok })
  assert.equal(out.me.email, 'x@y.z')
  assert.equal(out.me.cookieLines, 3)
  await assert.rejects(fetchShared(config, { python: process.execPath, script: bad }), e => e.code === 'invalid_cookies' && /valid session/.test(e.message))
  await assert.rejects(fetchShared(config, { python: join(dir, 'nope-python') }), e => e.code === 'no_python')
  assert.ok(!readdirSync(tmpdir()).some(n => n.startsWith('opportune-maps-')), 'temp cookie dirs removed')
})

test('poll: matches existing friends by name, creates shadow people, ingests under their ids, returns owner fix', async () => {
  const { ctx, mal, jess } = await setup()
  const peopleBefore = ctx.people.all().length
  const fixture = {
    me: { id: 'malcolm@example.com', fullName: 'malcolm@example.com', lat: OFFICE.lat, lng: OFFICE.lng, acc: 10, timestamp: nowMs(), address: null, battery: null, charging: false },
    contacts: [
      contact('g-jess', 'JESS', { lat: 37.7709, lng: -122.4200 }),                    // 100m from Malcolm's office, matches "Jess" case-insensitively
      contact('g-eileen', 'Eileen Kim', { lat: 37.7746, lng: -122.4366 }, { battery: 12 }),   // at Malcolm's home, unknown → shadow
      { id: 'g-nowhere', fullName: 'No Location', lat: null, lng: null, timestamp: null },   // dropped
    ],
  }
  ctx.plugins.sources[SOURCE_ID].fetch = async () => fixture
  await ctx.sources.pollDue()

  const sc = ctx.sources.forPerson(mal.id).find(s => s.source_id === SOURCE_ID)
  assert.equal(sc.last_error, null)
  // Jess matched, no new person for her
  const jl = locs(ctx, jess.id)
  assert.equal(jl.length, 1)
  assert.equal(jl[0].data.battery, 77)
  assert.equal(jl[0].data.address, '1 Some St')
  assert.equal(jl[0].data.placeName, "Malcolm's office")
  // Eileen became a shadow person, friend of Malcolm, wantMore false
  assert.equal(ctx.people.all().length, peopleBefore + 1)
  const eileen = ctx.people.all().find(p => p.display_name === 'Eileen Kim')
  assert.ok(eileen)
  assert.deepEqual({ step: eileen.onboarding.step, via: eileen.onboarding.via, ownerId: eileen.onboarding.ownerId }, { step: 'shadow', via: SOURCE_ID, ownerId: mal.id })
  const rel = ctx.people.rel(mal.id, eileen.id)
  assert.equal(rel.tier, 'friend')
  assert.equal(rel.want_more, 0)
  assert.equal(ctx.people.rel(eileen.id, mal.id), null, 'no reverse edge invented for a shadow')
  const el = locs(ctx, eileen.id)
  assert.equal(el.length, 1)
  assert.equal(el[0].data.placeName, "Malcolm's home", 'owner places are matched but attributed')
  assert.equal(el[0].data.battery, 12)
  // owner's own fix ingested for the owner, at his own place (unprefixed)
  const ml = locs(ctx, mal.id)
  assert.equal(ml.length, 1)
  assert.equal(ml[0].data.placeName, 'office')
  // the nearby trigger saw Malcolm + Jess (both wantMore) 100m apart, neither at home
  const opp = ctx.db.all(`select * from opportunities where kind = 'nearby'`)
  assert.ok(opp.some(o => o.participants.includes(jess.id) && o.participants.includes(mal.id)), 'nearby opportunity for Malcolm+Jess')

  // second poll with identical data: nothing new anywhere
  resetPoll(ctx)
  await ctx.sources.pollDue()
  assert.equal(locs(ctx, jess.id).length, 1)
  assert.equal(locs(ctx, eileen.id).length, 1)
  assert.equal(locs(ctx, mal.id).length, 1)
  assert.equal(ctx.people.all().length, peopleBefore + 1)

  // Eileen moves and Google renames her; same google id → same person, one new observation
  fixture.contacts[1] = contact('g-eileen', 'Eileen K.', { lat: 37.78, lng: -122.44 }, { timestamp: Date.now() })
  resetPoll(ctx)
  await ctx.sources.pollDue()
  assert.equal(ctx.people.all().length, peopleBefore + 1, 'rename did not mint a duplicate')
  const el2 = locs(ctx, eileen.id)
  assert.equal(el2.length, 2)
  assert.equal(el2[0].data.placeName, null)
  assert.equal(ctx.observations.latest(eileen.id, 'location').data.lat, 37.78)
})

test('poll error from the python bridge lands in source_configs.last_error', async () => {
  const { ctx, mal } = await setup()
  ctx.plugins.sources[SOURCE_ID].fetch = async () => { throw Object.assign(new Error('invalid_cookies: Does not seem we have a valid session.'), { code: 'invalid_cookies' }) }
  await ctx.sources.pollDue()
  const sc = ctx.sources.forPerson(mal.id).find(s => s.source_id === SOURCE_ID)
  assert.match(sc.last_error, /invalid_cookies/)
  // and a config without PSID cookies fails before shelling out
  ctx.sources.connect(mal.id, SOURCE_ID, { email: 'malcolm@example.com', cookies: '' })
  ctx.plugins.sources[SOURCE_ID].fetch = async () => { throw new Error('should not be called') }
  resetPoll(ctx)
  await ctx.sources.pollDue()
  assert.match(ctx.sources.forPerson(mal.id).find(s => s.source_id === SOURCE_ID).last_error, /__Secure-1PSID/)
})

test('resolveContact prefers the full-name match, then nickname; toObservation handles timestamp-only contacts', async () => {
  const { ctx, mal, jess } = await setup()
  const r1 = resolveContact(ctx, mal, { id: 'a', fullName: 'jess', nickname: 'J' })
  assert.equal(r1.person.id, jess.id)
  assert.equal(r1.created, false)
  const r2 = resolveContact(ctx, mal, { id: 'b', fullName: 'Jessica Q', nickname: 'Jess' })
  assert.equal(r2.person.id, jess.id, 'nickname fallback')
  const r3 = resolveContact(ctx, mal, { id: 'c', fullName: 'Sam Who' })
  assert.equal(r3.created, true)
  assert.equal(resolveContact(ctx, mal, { id: 'c', fullName: 'Renamed' }).person.id, r3.person.id, 'kv remembers google id')
  const ts = Date.UTC(2026, 9, 8, 12, 0, 0)
  const obs = toObservation(ctx, mal, r3.person, { lat: 1, lng: 2, timestamp: ts })
  assert.equal(obs.at, '2026-10-08T12:00:00.000Z')
  assert.equal(obs.dedupeKey, `loc@${ts}`)
  assert.equal(obs.kind, 'location')
  const summary = await ingestContacts(ctx, mal, [{ id: 'c', fullName: 'Sam Who', lat: 1, lng: 2, timestamp: ts }, { id: 'c', fullName: 'Sam Who', lat: 1, lng: 2, timestamp: ts }])
  assert.deepEqual({ ingested: summary.ingested, skipped: summary.skipped }, { ingested: 1, skipped: 1 })
  assert.equal(mapsSharing.intervalMin, 5)
})
