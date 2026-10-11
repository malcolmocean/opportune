import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'

const TZ = 'America/Los_Angeles'
const mk = async () => {
  const ctx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '' }, { dbPath: ':memory:' })
  const me = ctx.people.create({ displayName: 'Malcolm', tz: TZ })
  ctx.people.update(me.id, { onboarding: { step: 'done' }, policy: { quietHours: { start: 99, end: 99 } } })
  ctx.people.bind(me.id, 'email', 'malcolm@example.com')
  return { ctx, me }
}
const future = (days = 3) => new Date(Date.now() + days * 864e5).toISOString()
const event = (attendees, extra = {}) => ({
  kind: 'event', at: future(), dedupeKey: 'sam-bday', data: { title: "Sam's birthday thing", url: 'https://partiful.com/e/sam', rsvpStatus: 'going', location: 'Dolores Park', attendees, ...extra },
})
const settle = () => new Promise(r => setTimeout(r, 30))
const opps = ctx => ctx.db.all(`select * from opportunities where kind = 'coAttendance' order by created_at, rowid`).map(o => ({ ...o, participants: JSON.parse(o.participants), evidence: JSON.parse(o.evidence) }))
const via = o => o.evidence.find(e => e.matchedVia)?.matchedVia

test('contactsMatching: by normalized email and by case/whitespace-insensitive name', async () => {
  const { ctx, me } = await mk()
  ctx.people.addContacts(me.id, [{ name: 'Eileen K', emails: ['Eileen@Example.com'], phones: ['415 555 0100'] }, { name: 'Sam', emails: ['sam@example.com'] }])
  assert.deepEqual(ctx.people.contactsMatching(me.id, { email: 'EILEEN@example.com' }), [{ name: 'Eileen K', kind: 'email', value: 'eileen@example.com' }])
  const byName = ctx.people.contactsMatching(me.id, { name: '  eileen   k ' })
  assert.deepEqual(byName.map(c => c.kind).sort(), ['email', 'phone'])
  assert.deepEqual(ctx.people.contactsMatching(me.id, { email: 'nobody@example.com', name: 'Nobody' }), [])
  const other = ctx.people.create({ displayName: 'Other' })
  assert.deepEqual(ctx.people.contactsMatching(other.id, { email: 'eileen@example.com' }), [], 'owner-scoped')
})

test('guest list: a contact (by email) who is not on the system → single-participant opportunity for me, nudged', async () => {
  const { ctx, me } = await mk()
  ctx.people.addContacts(me.id, [{ name: 'Eileen', emails: ['eileen@example.com'] }])
  await ctx.observations.ingest(me.id, 'gmailRsvp', [event([{ name: 'E. Kane', email: 'EILEEN@example.com', status: 'going' }])])
  await settle()
  const [opp, ...rest] = opps(ctx)
  assert.ok(opp); assert.equal(rest.length, 0)
  assert.deepEqual(opp.participants, [me.id]); assert.equal(opp.primary_id, me.id)
  assert.match(opp.summary, /^Eileen \(from your contacts\) is on the guest list for "Sam's birthday thing" .+ — you're both going\. It's at Dolores Park\.$/)
  assert.equal(via(opp), 'contacts')
  assert.deepEqual(opp.evidence[1].attendee, { name: 'E. Kane', email: 'EILEEN@example.com', status: 'going' })
  assert.match(opp.dedupe_key, /:guest:eileen$/)
  const d = ctx.db.all(`select * from decisions where opportunity_id = ?`, opp.id)
  assert.equal(d.length, 1); assert.equal(d[0].person_id, me.id); assert.equal(d[0].verdict, 'nudge', 'gate passes with no other participant')
})

test('guest list: a contact matched by name only (no email), with the contact name used in the summary', async () => {
  const { ctx, me } = await mk()
  ctx.people.addContacts(me.id, [{ name: 'Eileen Kane', phones: ['+14155550100'] }])
  await ctx.observations.ingest(me.id, 'gmailRsvp', [event([{ name: 'eileen kane', email: null }])])
  const [opp] = opps(ctx)
  assert.ok(opp); assert.equal(via(opp), 'contacts'); assert.match(opp.summary, /^Eileen Kane \(from your contacts\)/)
})

test('guest list: someone I created an invite for (used or not)', async () => {
  const { ctx, me } = await mk()
  ctx.people.invite(me.id, { inviteeName: 'Priya Natarajan' })
  const used = ctx.people.invite(me.id, { inviteeName: 'Tom' })
  const tom = ctx.people.create({ displayName: 'Tom' })
  ctx.people.acceptInvite(used.code, tom.id)   // Tom is now a friend on the system → pair opp, not an invite match
  await ctx.observations.ingest(me.id, 'gmailRsvp', [event([{ name: 'Priya Natarajan' }, { name: 'Tom' }])])
  const all = opps(ctx)
  const priya = all.find(o => /Priya/.test(o.summary)), tomOpp = all.find(o => o.participants.includes(tom.id))
  assert.ok(priya); assert.equal(via(priya), 'invite'); assert.deepEqual(priya.participants, [me.id])
  assert.match(priya.summary, /^Priya Natarajan \(who you invited to Opportune\) is on the guest list/)
  assert.ok(tomOpp); assert.deepEqual(tomOpp.participants, [me.id, tom.id]); assert.equal(tomOpp.primary_id, me.id)
  assert.equal(all.length, 2)
})

test('guest list: a shadow person (Maps sharing) is matched as off-system, not as a friend pair', async () => {
  const { ctx, me } = await mk()
  // what sources/mapsSharing resolveContact() does
  const shadow = ctx.people.create({ displayName: 'Eileen Kane', tz: TZ })
  ctx.people.update(shadow.id, { onboarding: { step: 'shadow', via: 'mapsSharing', ownerId: me.id } })
  ctx.people.setRel(me.id, shadow.id, { tier: 'friend', wantMore: false, note: 'shares Google Maps location with you' })
  await ctx.observations.ingest(me.id, 'gmailRsvp', [event([{ name: 'Eileen Kane', role: 'host' }])])
  await settle()
  const all = opps(ctx)
  assert.equal(all.length, 1)
  assert.deepEqual(all[0].participants, [me.id], 'the shadow person is not a participant')
  assert.equal(via(all[0]), 'shadow')
  assert.match(all[0].summary, /^Eileen Kane \(who shares their Maps location with you\) is hosting "Sam's birthday thing"/)
  assert.equal(ctx.db.get(`select verdict from decisions where opportunity_id = ?`, all[0].id).verdict, 'nudge')
})

test('guest list: skips me (by name or bound email), declined guests, unknowns; caps off-system matches at 5; dedupes on re-ingest', async () => {
  const { ctx, me } = await mk()
  const names = ['A One', 'B Two', 'C Three', 'D Four', 'E Five', 'F Six', 'G Seven']
  ctx.people.addContacts(me.id, [...names.map((n, i) => ({ name: n, emails: [`${i}@example.com`] })), { name: 'Malcolm', emails: ['malcolm@example.com'] }, { name: 'Zed', emails: ['zed@example.com'] }])
  const attendees = [
    { name: 'Malcolm', email: null }, { name: 'Someone Else', email: 'MALCOLM@example.com' },
    { name: 'Zed', email: 'zed@example.com', status: 'declined' }, { name: 'Stranger', email: 'stranger@example.com' },
    ...names.map((n, i) => ({ name: n, email: `${i}@example.com` })),
  ]
  await ctx.observations.ingest(me.id, 'gmailRsvp', [event(attendees)])
  const all = opps(ctx)
  assert.equal(all.length, 5)
  assert.ok(all.every(o => via(o) === 'contacts' && o.participants.length === 1))
  assert.ok(!all.some(o => /Malcolm|Zed|Stranger|Someone/.test(o.summary)))
  // same event again with one more guest → data changed, trigger refires, nothing new (dedupeKey per attendee)
  await ctx.observations.ingest(me.id, 'gmailRsvp', [event([...attendees, { name: 'H Eight' }])])
  assert.equal(opps(ctx).length, 5)
})

test('guest list: rsvpStatus invited → "you\'re invited too"', async () => {
  const { ctx, me } = await mk()
  ctx.people.addContacts(me.id, [{ name: 'Eileen', emails: ['eileen@example.com'] }])
  await ctx.observations.ingest(me.id, 'gmailRsvp', [event([{ name: 'Eileen', email: 'eileen@example.com' }], { rsvpStatus: 'invited' })])
  assert.match(opps(ctx)[0].summary, /— you're invited too\./)
})

test('both on the system: each side\'s own guest list tells that side; the shared event tells both once', async () => {
  const { ctx, me } = await mk()
  const jess = ctx.people.create({ displayName: 'Jess', tz: TZ })
  ctx.people.update(jess.id, { onboarding: { step: 'done' }, policy: { quietHours: { start: 99, end: 99 } } })
  ctx.people.setRel(me.id, jess.id, { wantMore: true }); ctx.people.setRel(jess.id, me.id, { wantMore: false })
  // my event lists Jess → tell me (the match came from my list)
  await ctx.observations.ingest(me.id, 'gmailRsvp', [event([{ name: 'Jess' }])])
  let all = opps(ctx)
  assert.equal(all.length, 1); assert.equal(all[0].primary_id, me.id); assert.deepEqual(all[0].participants, [me.id, jess.id])
  assert.match(all[0].summary, /Malcolm and Jess are both going to "Sam's birthday thing" on .+ \(they're on the guest list\)/)
  // Jess's copy of the same event (same url) lists me → both have it: primary null, one opp, two decisions
  await ctx.observations.ingest(jess.id, 'gmailRsvp', [event([{ name: 'Malcolm' }])])
  await settle()
  all = opps(ctx)
  assert.equal(all.length, 2)
  const both = all[1]
  assert.equal(both.primary_id, null); assert.deepEqual(both.participants.sort(), [me.id, jess.id].sort())
  assert.match(both.summary, /Jess and Malcolm are both going to .+ \(both have it on their calendar\)/)
  assert.doesNotMatch(both.dedupe_key, /guest/)
  assert.deepEqual(ctx.db.all(`select person_id from decisions where opportunity_id = ? order by person_id`, both.id).map(d => d.person_id), [me.id, jess.id].sort())
  // the same event ingested again on Jess's side with a new guest is deduped by the direction-free key
  await ctx.observations.ingest(jess.id, 'gmailRsvp', [event([{ name: 'Malcolm' }, { name: 'New Guest' }])])
  assert.equal(opps(ctx).length, 2)
})

test('both on the system: friend matched by name is not also emitted as a contacts match', async () => {
  const { ctx, me } = await mk()
  const jess = ctx.people.create({ displayName: 'Jess Lee', tz: TZ })
  ctx.people.setRel(me.id, jess.id, { wantMore: true })
  ctx.people.addContacts(me.id, [{ name: 'Jess Lee', emails: ['jess@example.com'] }])
  await ctx.observations.ingest(me.id, 'gmailRsvp', [event([{ name: 'Jess Lee', email: 'jess@example.com' }])])
  const all = opps(ctx)
  assert.equal(all.length, 1); assert.deepEqual(all[0].participants, [me.id, jess.id])
})

test('past events and events with no attendees produce nothing', async () => {
  const { ctx, me } = await mk()
  ctx.people.addContacts(me.id, [{ name: 'Eileen', emails: ['eileen@example.com'] }])
  await ctx.observations.ingest(me.id, 'gmailRsvp', [{ ...event([{ name: 'Eileen', email: 'eileen@example.com' }]), at: new Date(Date.now() - 864e5).toISOString() }])
  await ctx.observations.ingest(me.id, 'gmailRsvp', [{ ...event([]), dedupeKey: 'empty' }])
  assert.equal(opps(ctx).length, 0)
})
