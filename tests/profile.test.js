// people.dropin_note (default drop-in note) and people.story, through the app ingest, porchlight(), the dropin
// query and the agent; plus the schema migration and the boot-time node_url resync for local people.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildContext } from '../core/context.js'
import { openDb } from '../core/db.js'
import { STORY_MAX, DROPIN_NOTE_MAX } from '../core/people.js'
import { porchlight } from '../queries/dropin/porchlight.js'

const HOME = { lat: 37.7745, lng: -122.4365 }
const env = { ...process.env, ANTHROPIC_API_KEY: '', FIREBASE_SERVICE_ACCOUNT_JSON: '' }

async function setup() {
  const ctx = await buildContext(env, { dbPath: ':memory:' })
  const jess = ctx.people.create({ displayName: 'Jess' })
  const eileen = ctx.people.create({ displayName: 'Eileen' })
  ctx.people.setRel(jess.id, eileen.id, { wantMore: true })
  ctx.people.setRel(eileen.id, jess.id, { wantMore: true })
  ctx.people.addPlace(eileen.id, { name: 'home', ...HOME, radiusM: 120 })
  await ctx.observations.ingest(eileen.id, 'test', [{ kind: 'location', data: { ...HOME, placeName: 'home' } }])
  const sc = ctx.sources.connect(eileen.id, 'opportuneApp', {})
  const post = body => ctx.sources.ingest('opportuneApp', sc.token, body)
  const light = () => porchlight(ctx, ctx.people.get(eileen.id))
  return { ctx, jess, eileen, post, light }
}

test('default note: set once via ingest, shown when a status has no note, replaced one time by a status note, cleared by ""', async () => {
  const { ctx, eileen, post, light } = await setup()
  assert.deepEqual(light(), { state: 'ask', source: 'default' }, 'no note key at all when nothing is set')
  assert.equal((await post({ defaultNote: '  come by the back  ' })).length, 0, 'profile keys produce no observations')
  assert.equal(ctx.people.get(eileen.id).dropin_note, 'come by the back')
  assert.equal(light().note, 'come by the back', 'default note shows under the policy default')
  await post({ status: { porchlight: 'open' } })                       // app status with no note
  assert.deepEqual([light().state, light().source, light().note], ['open', 'status', 'come by the back'])
  assert.equal(ctx.people.get(eileen.id).dropin_note, 'come by the back', 'setting a status did not clear the default')
  await post({ status: { porchlight: 'open', note: 'door is unlocked, just walk in' } })
  assert.equal(light().note, 'door is unlocked, just walk in', 'a status note replaces the default for that status')
  await post({ status: { porchlight: 'ask' } })
  assert.equal(light().note, 'come by the back', 'the next status without a note is back to the default')
  await post({ defaultNote: '' })
  assert.equal(ctx.people.get(eileen.id).dropin_note, '')
  assert.equal('note' in light(), false)
  await post({ defaultNote: 'x'.repeat(DROPIN_NOTE_MAX + 50) })
  assert.equal(ctx.people.get(eileen.id).dropin_note.length, DROPIN_NOTE_MAX)
})

test('default note: the agent set_status tool keeps working and resolves to the default note too', async () => {
  const { ctx, eileen, post, light } = await setup()
  await post({ defaultNote: 'ring twice' })
  const tools = ctx.agent.tools(ctx.people.get(eileen.id))
  await tools.find(t => t.name === 'set_status').run({ porchlight: 'open' })
  assert.deepEqual([light().state, light().note], ['open', 'ring twice'])
  await tools.find(t => t.name === 'set_status').run({ porchlight: 'open', note: 'in the garden' })
  assert.equal(light().note, 'in the garden')
  const r = await tools.find(t => t.name === 'update_profile').run({ defaultNote: 'side gate', story: 'Weeknights after 8 are good. No phone calls.' })
  assert.deepEqual(r, { story: 'Weeknights after 8 are good. No phone calls.', defaultNote: 'side gate' })
  assert.equal(ctx.people.get(eileen.id).dropin_note, 'side gate')
  assert.match(ctx.agent.system(ctx.people.get(eileen.id)), /Their story \(.*\): Weeknights after 8 are good\. No phone calls\./)
  assert.match(ctx.agent.system(ctx.people.get(eileen.id)), /default drop-in note .*: side gate/)
  assert.equal(await tools.find(t => t.name === 'update_profile').run({}).error, 'nothing to set')
})

test('story: ingest, clamp to STORY_MAX, readable by friends through the dropin answer; note travels with it', async () => {
  const { ctx, jess, eileen, post } = await setup()
  await post({ story: 'Usually free weeknights after 8, love a walk, hate phone calls. Saturday mornings are family.' })
  assert.equal(ctx.people.get(eileen.id).story, 'Usually free weeknights after 8, love a walk, hate phone calls. Saturday mornings are family.')
  await post({ status: { porchlight: 'open' }, defaultNote: 'back door' })
  const a = await ctx.query.ask({ from: jess.id, to: eileen.id, kind: 'dropin', text: 'ok?' })
  assert.equal(a.answer, 'yes')
  assert.deepEqual(a.revealed, { porchlight: 'open', note: 'back door', story: 'Usually free weeknights after 8, love a walk, hate phone calls. Saturday mornings are family.', presence: 'home' })
  await post({ story: 'y'.repeat(STORY_MAX + 1) })
  assert.equal(ctx.people.get(eileen.id).story.length, STORY_MAX)
  await post({ story: 42 })
  assert.equal(ctx.people.get(eileen.id).story.length, STORY_MAX, 'non-strings are ignored')
  await post({ story: '' })
  assert.equal(ctx.people.get(eileen.id).story, '')
  const b = await ctx.query.ask({ from: jess.id, to: eileen.id, kind: 'dropin', text: 'ok?' })
  assert.equal('story' in b.revealed, false)
  // friendsOf / connections carry the column, so the state route and triggers see it without another lookup
  await post({ story: 'short' })
  assert.equal(ctx.people.connections(jess.id).find(f => f.id === eileen.id).story, 'short')
  assert.equal(ctx.people.friendsOf(jess.id).find(f => f.id === eileen.id).story, 'short')
})

test('migration: an older people table gains dropin_note and story on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opportune-mig-'))
  const path = join(dir, 'old.db')
  const raw = new DatabaseSync(path)
  raw.exec(`create table people (id text primary key, node_url text not null, remote integer not null default 0, display_name text, pubkey text, privkey text, tz text, home_place_id text, policy json not null default '{}', onboarding json not null default '{}', created_at text not null)`)
  raw.exec(`insert into people (id, node_url, created_at) values ('p1', 'http://old', '2026-01-01')`)
  raw.close()
  const db = openDb(path)
  const cols = db.all('pragma table_info(people)').map(c => c.name)
  assert.ok(cols.includes('dropin_note') && cols.includes('story'))
  assert.deepEqual({ ...db.get('select dropin_note, story from people where id = ?', 'p1') }, { dropin_note: '', story: '' })
  openDb(path)   // idempotent
})

test('boot: local people follow NODE_URL; remote people keep their node', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opportune-url-'))
  const path = join(dir, 'node.db')
  const c1 = await buildContext({ ...env, NODE_URL: 'https://1.2.3.4.sslip.io' }, { dbPath: path })
  const me = c1.people.create({ displayName: 'Malcolm' })
  const far = c1.people.create({ displayName: 'Bob', remote: true, nodeUrl: 'https://bob.example', pubkey: 'x' })
  assert.equal(c1.people.get(me.id).node_url, 'https://1.2.3.4.sslip.io')
  c1.db.raw.close()
  const c2 = await buildContext({ ...env, NODE_URL: 'https://opportune.club' }, { dbPath: path })
  assert.equal(c2.people.get(me.id).node_url, 'https://opportune.club')
  assert.equal(c2.people.get(far.id).node_url, 'https://bob.example')
  assert.equal(c2.people.nodeUrl, 'https://opportune.club')
  c2.db.raw.close()
})
