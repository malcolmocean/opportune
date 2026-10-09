import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'

const TZ = 'America/Los_Angeles'
const env = { ...process.env, ANTHROPIC_API_KEY: '' }
const settle = async ctx => { for (let i = 0; i < 100; i++) { if (!ctx.db.get(`select 1 from opportunities where status = 'pending'`)) return; await new Promise(r => setTimeout(r, 5)) } }
const noLlm = () => new Proxy({}, { get(_, k) { if (k === 'enabled') return false; throw new Error(`trigger touched ctx.llm.${String(k)}`) } })

// --- tiny tz helpers mirroring what the trigger must get right ---
const parts = (date, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(date).map(p => [p.type, p.value]))
const ymdOf = (date, tz) => { const o = parts(date, tz); return `${o.year}-${o.month}-${o.day}` }
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10) }
const weekdayOf = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay() }
// instant for `hour` o'clock in tz on ymd (good enough for a test: iterate offsets)
const at = (ymd, hour, tz) => {
  const [y, m, d] = ymd.split('-').map(Number)
  for (const off of [7, 8, 0, 1, -1, 5, 6, 9, 10, 2, 3, 4, 11, 12, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11]) {
    const t = new Date(Date.UTC(y, m - 1, d, hour + off))
    const o = parts(t, tz)
    if (`${o.year}-${o.month}-${o.day}` === ymd && +o.hour === hour) return t
  }
  throw new Error('no offset matched')
}
// upcoming local dates (YYYY-MM-DD) in tz whose 18:00 slot is still ahead, next 14 days
const upcoming = (tz, days) => {
  const today = ymdOf(new Date(), tz), out = []
  for (let i = 0; i < 14; i++) { const ymd = addDays(today, i); if (days.includes(weekdayOf(ymd)) && at(ymd, 18, tz) > new Date()) out.push(ymd) }
  return out
}
const block = (ymd, title = 'Busy thing') => ({ kind: 'event', at: at(ymd, 19, TZ).toISOString(), until: at(ymd, 21, TZ).toISOString(), dedupeKey: `${title}@${ymd}`, data: { title, provider: 'test' } })

async function setup() {
  const ctx = await buildContext(env, { dbPath: ':memory:' })
  const jess = ctx.people.create({ displayName: 'Jess', tz: TZ })
  const eileen = ctx.people.create({ displayName: 'Eileen', tz: TZ })
  const bob = ctx.people.create({ displayName: 'Bob', tz: TZ })
  for (const p of [jess, eileen, bob]) ctx.people.update(p.id, { policy: { quietHours: null } })
  ctx.people.setRel(jess.id, eileen.id, { wantMore: true }); ctx.people.setRel(eileen.id, jess.id, { wantMore: true })
  ctx.people.setRel(jess.id, bob.id, { wantMore: true }); ctx.people.setRel(bob.id, jess.id, { wantMore: false })
  // Jess and Eileen have calendars; Bob only shares location → his evenings are unknown
  ctx.sources.connect(jess.id, 'icsCalendar', { urls: [] })
  ctx.sources.connect(eileen.id, 'icsCalendar', { urls: [] })
  ctx.sources.connect(bob.id, 'locationPost', { app: 'OwnTracks' })
  return { ctx, jess, eileen, bob, trigger: ctx.plugins.triggers.standingSlot }
}

test('standingSlot plugin loads with cron manifest', async () => {
  const { trigger } = await setup()
  assert.ok(trigger, 'triggers/standingSlot discovered by loader')
  assert.equal(trigger.intervalMin, 720)
  assert.equal(typeof trigger.runCron, 'function')
})

test('finds the first Mon/Tue evening both are free, skips my busy night, flags calendar-less friends', async () => {
  const { ctx, jess, eileen, bob, trigger } = await setup()
  const slots = upcoming(TZ, [1, 2])      // Mon/Tue dates ahead
  assert.ok(slots.length >= 3)
  await ctx.observations.ingest(jess.id, 'chat', [{ kind: 'intent', data: { text: 'weekly couples dinner Mon/Tue', kind: 'host' } }])
  await ctx.observations.ingest(jess.id, 'test', [block(slots[0], 'Board game night')])        // Jess busy on the first candidate
  // 14 days hold 4 Mon/Tue dates, or 3 late on a Mon/Tue evening; keep slots[1] and slots[2] free either way
  if (slots[3]) await ctx.observations.ingest(eileen.id, 'test', [block(slots[3], 'Eileen out')])
  ctx.llm = noLlm()
  const opps = trigger.runCron(ctx)
  ctx.llm = { enabled: false }
  assert.equal(opps.length, 2, 'at most 2 per intent')
  const [a, b] = opps
  assert.equal(a.kind, 'standingSlot')
  assert.deepEqual(a.participants, [jess.id, eileen.id])
  assert.equal(a.primary, jess.id)
  assert.equal(a.evidence.slot.date, slots[1], 'first free slot is the second Mon/Tue')
  assert.equal(a.dedupeKey, `slot:${jess.id}:${eileen.id}:${slots[1]}`)
  assert.equal(a.expiresAt, at(slots[1], 18, TZ).toISOString(), 'expires at 18:00 local on slot day')
  assert.equal(parts(new Date(a.expiresAt), TZ).hour, '18')
  assert.deepEqual(a.evidence.freeFriends, ['Eileen'])
  assert.deepEqual(a.evidence.unknownFriends, ['Bob'])
  assert.equal(a.evidence.intentText, 'weekly couples dinner Mon/Tue')
  assert.match(a.summary, /Jess wants "weekly couples dinner Mon\/Tue" \(Mon\/Tue evenings\)/)
  assert.match(a.summary, /both Jess and Eileen look free/)
  assert.match(a.summary, /Bob hasn't connected a calendar/)
  assert.equal(b.evidence.slot.date, slots[2], 'second pick is the next distinct free date')
  assert.equal(b.dedupeKey, `slot:${jess.id}:${eileen.id}:${slots[2]}`)
  assert.ok(!opps.some(o => o.participants.includes(bob.id)), 'never claim Bob is free')

  for (const o of opps) await ctx.opportunities.add(trigger.id, o)
  await settle(ctx)
  assert.equal(ctx.db.all(`select * from opportunities where kind = 'standingSlot'`).length, 2)
  const nudges = ctx.db.all(`select * from nudges`)
  assert.equal(nudges.length, 2)
  assert.ok(nudges.every(n => n.person_id === jess.id))
  // same run again → deduped
  for (const o of trigger.runCron(ctx)) assert.equal(await ctx.opportunities.add(trigger.id, o), null)
})

test('weekday parsing: text, window.days, weekend words, default all; data.people narrows candidates', async () => {
  const { ctx, jess, eileen, bob, trigger } = await setup()
  await ctx.observations.ingest(jess.id, 'chat', [
    { kind: 'intent', dedupeKey: 'i1', data: { text: 'host a dinner every thursday', kind: 'host' } },
    { kind: 'intent', dedupeKey: 'i2', data: { text: 'weekly hikes', window: { days: [6] }, people: [bob.id] } },     // Bob only → unknown → nothing emitted
    { kind: 'intent', dedupeKey: 'i3', data: { text: 'weekend brunch host rotation', people: [eileen.id] } },
  ])
  const opps = trigger.runCron(ctx)
  const thu = opps.filter(o => o.evidence.intentText === 'host a dinner every thursday')
  assert.ok(thu.length >= 1 && thu.every(o => o.evidence.slot.weekday === 'Thu'))
  assert.equal(opps.filter(o => o.evidence.intentText === 'weekly hikes').length, 0, 'only-unknown friends emit nothing')
  const wknd = opps.filter(o => o.evidence.intentText === 'weekend brunch host rotation')
  assert.ok(wknd.length >= 1 && wknd.every(o => ['Sat', 'Sun'].includes(o.evidence.slot.weekday)))
  assert.ok(wknd.every(o => o.participants[1] === eileen.id))
  assert.equal(opps.filter(o => o.evidence.intentText === 'weekly hikes' || o.participants.includes(bob.id)).length, 0)
})

test('ignores non-hosty intents, expired intents, and transparent/all-day events do not block', async () => {
  const { ctx, jess, eileen, trigger } = await setup()
  await ctx.observations.ingest(jess.id, 'chat', [
    { kind: 'intent', dedupeKey: 'n1', data: { text: 'want to see Odyssey this week', kind: 'attend' } },
    { kind: 'intent', dedupeKey: 'n2', until: new Date(Date.now() - 864e5).toISOString(), data: { text: 'weekly dinner', kind: 'host' } },
  ])
  assert.equal(trigger.runCron(ctx).length, 0)
  await ctx.observations.ingest(jess.id, 'chat', [{ kind: 'intent', dedupeKey: 'n3', data: { text: 'dinner every evening is fine', kind: 'host' } }])
  const slots = upcoming(TZ, [0, 1, 2, 3, 4, 5, 6])
  const first = slots[0]
  await ctx.observations.ingest(jess.id, 'test', [
    { kind: 'event', at: at(first, 0, TZ).toISOString(), until: at(addDays(first, 1), 0, TZ).toISOString(), dedupeKey: 'allday', data: { title: 'Indigenous Peoples Day', provider: 'test' } },
    { kind: 'event', at: at(first, 19, TZ).toISOString(), until: at(first, 20, TZ).toISOString(), dedupeKey: 'transparent', data: { title: 'Maybe gym', provider: 'test', busy: false } },
  ])
  const opps = trigger.runCron(ctx)
  assert.ok(opps.length >= 1)
  assert.equal(opps[0].evidence.slot.date, first, 'all-day and transparent events do not block')
  assert.deepEqual(opps[0].evidence.primaryAllDayEvents, ['Indigenous Peoples Day'])
  assert.match(opps[0].summary, /any evening/)
})
