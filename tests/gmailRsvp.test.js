import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../core/context.js'
import plugin, { mergeEvents, toObservation, toEmail } from '../sources/gmailRsvp/index.js'
import { parseEmail, detectProvider, guestsFromText, looksLikeName, canonicalUrl } from '../sources/gmailRsvp/parsers.js'
import { parseWhen, parseGoogleSubjectWhen, zonedToDate } from '../sources/gmailRsvp/dates.js'
import { htmlToText, extractLinks } from '../sources/gmailRsvp/html.js'
import { simpleParser } from 'mailparser'

const TZ = 'America/Los_Angeles'
const ME = 'malcolm@stem.ai'

// ---------- fixtures (written from memory of real emails; validate against live samples) ----------

const PARTIFUL_GOING = {
  subject: 'You\'re going to Jess\'s Rooftop Birthday Bash! 🎂',
  from: 'Partiful <hello@partiful.com>',
  to: ME,
  date: '2026-10-08T18:04:11.000Z',
  messageId: '<abc123@partiful.com>',
  text: '',
  html: `<!DOCTYPE html><html><head><style>.x{color:red}</style></head><body>
<table><tr><td>
<img src="https://cdn.partiful.com/logo.png" alt="Partiful">
<h1 style="font-size:28px">Jess&#39;s Rooftop Birthday Bash! 🎂</h1>
<p>Hi Malcolm, you&#39;re going! 🎉</p>
<p>📅 Saturday, October 18 · 7:00 PM PDT</p>
<p>📍 The Battery Rooftop, 717 Battery St, San Francisco</p>
<p>Hosted by Jess Doe</p>
<div>
  <img src="https://cdn.partiful.com/u/1.jpg" alt="Alice Chen" width="32">
  <img src="https://cdn.partiful.com/u/2.jpg" alt="Bob Li" width="32">
  <img src="https://cdn.partiful.com/u/3.jpg" alt="Priya Patel" width="32">
</div>
<p>Alice Chen, Bob Li, Priya Patel and 12 others are going</p>
<p><a href="https://click.partiful.com/ls/click?upn=abc&amp;url=https%3A%2F%2Fpartiful.com%2Fe%2FkJ8sD2mQ9xLp%3Futm_source%3Demail">View Event</a></p>
<p><a href="https://partiful.com/settings/notifications">Notification settings</a></p>
</td></tr></table></body></html>`,
}

const PARTIFUL_INVITE = {
  subject: 'Sam Rivera invited you to Winter Solstice Potluck',
  from: 'Partiful <invites@partiful.com>',
  to: ME,
  date: '2026-11-28T02:14:00.000Z',
  messageId: '<def456@partiful.com>',
  text: `Winter Solstice Potluck

Sam Rivera invited you!

Sunday, December 21 at 5:30pm
1234 Shotwell St, San Francisco, CA

Going
Sam Rivera
Dana Whitfield
Kai Nakamura

Can you make it? RSVP here: https://partiful.com/e/Qw3rTy7UiOp1?s=i

Partiful · Unsubscribe`,
  html: '',
}

const LUMA_CONFIRMED = {
  subject: 'You\'re in! AI Tinkerers SF — October Demo Night',
  from: 'Luma <no-reply@lu.ma>',
  to: ME,
  date: '2026-10-05T22:30:00.000Z',
  messageId: '<luma-789@lu.ma>',
  text: '',
  html: `<html><body>
<div style="max-width:600px">
<img alt="Luma" src="https://images.lumacdn.com/logo.png">
<h2>You&rsquo;re in!</h2>
<h1>AI Tinkerers SF &mdash; October Demo Night</h1>
<p>Hosted by <a href="https://lu.ma/user/usr-abc">Priya Patel</a> and <a href="https://lu.ma/user/usr-def">Tom Okafor</a></p>
<p>📅 Saturday, October 25 · 6:30 PM – 9:30 PM PDT</p>
<p>📍 Shack15, 1 Ferry Building, San Francisco, CA 94111</p>
<p>Dan Kim, Mei Wong and 24 others are going</p>
<p><a href="https://lu.ma/ai-tinkerers-oct?tk=abc123">View Event</a> &nbsp; <a href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=AI+Tinkerers+SF+%E2%80%94+October+Demo+Night&amp;dates=20261026T013000Z%2F20261026T043000Z&amp;location=Shack15%2C+1+Ferry+Building">Add to Google Calendar</a></p>
<p style="font-size:11px"><a href="https://lu.ma/unsubscribe?x=1">Unsubscribe</a> · <a href="https://lu.ma/settings">Settings</a></p>
</div></body></html>`,
}

const EVENTBRITE_TICKETS = {
  subject: 'Your Tickets for Vulfpeck Live at The Fillmore',
  from: 'Eventbrite <orders@eventbrite.com>',
  to: ME,
  date: '2026-10-02T15:00:00.000Z',
  messageId: '<eb-555@eventbrite.com>',
  text: '',
  html: `<html><body>
<h1>Vulfpeck Live at The Fillmore</h1>
<p>Order #9876543210 · Malcolm Ocean</p>
<table><tr><td>
<p><strong>Date and time</strong><br>Saturday, November 1, 2026 from 8:00 PM to 11:00 PM (PDT)</p>
<p><strong>Location</strong><br>The Fillmore<br>1805 Geary Blvd, San Francisco, CA 94115</p>
</td></tr></table>
<a href="https://www.eventbrite.com/e/vulfpeck-live-at-the-fillmore-tickets-123456789012?aff=ebdsoporgprofile&amp;utm=1">View event</a>
<a href="https://www.eventbrite.com/mytickets/">My tickets</a>
</body></html>`,
}

const GCAL_ICS = `BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
METHOD:REQUEST
BEGIN:VEVENT
DTSTART:20261019T020000Z
DTEND:20261019T040000Z
DTSTAMP:20261008T170000Z
ORGANIZER;CN=Jess Doe:mailto:jess@example.com
UID:7f3k2m9q1abc@google.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Jess Doe;X-NUM-GUESTS=0:mailto:jess@example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=malcolm@stem.ai;X-NUM-GUESTS=0:mailto:malcolm@stem.ai
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=TENTATIVE;CN=Bob Li;X-NUM-GUESTS=0:mailto:bob@example.com
LOCATION:Nopa\\, 560 Divisadero St\\, San Francisco\\, CA 94117
SUMMARY:Dinner at Nopa
URL:https://www.google.com/calendar/event?eid=N2YzazJtOXExYWJjIG1hbGNvbG1Ac3RlbS5haQ
END:VEVENT
END:VCALENDAR`

const GCAL_INVITE = {
  subject: 'Invitation: Dinner at Nopa @ Sat Oct 18, 2026 7pm - 9pm (PDT) (malcolm@stem.ai)',
  from: 'Jess Doe <jess@example.com>',
  sender: 'Google Calendar <calendar-notification@google.com>',
  to: ME,
  date: '2026-10-08T17:00:00.000Z',
  messageId: '<gcal-1@google.com>',
  ics: GCAL_ICS,
  text: `Dinner at Nopa

When
Sat Oct 18, 2026 7pm – 9pm Pacific Time - Los Angeles

Where
Nopa, 560 Divisadero St, San Francisco, CA 94117

Who
Jess Doe - organizer
malcolm@stem.ai
Bob Li - optional

View all guest info
Reply for malcolm@stem.ai: Yes / No / Maybe

https://calendar.google.com/calendar/event?action=VIEW&eid=N2YzazJtOXExYWJjIG1hbGNvbG1Ac3RlbS5haQ&tok=XYZ&ctz=America%2FLos_Angeles
`,
  html: '',
}

// ---------- dates ----------

test('parseWhen: prose date forms resolve in the person tz, with abbreviations winning', () => {
  const ref = '2026-10-08T12:00:00Z'
  assert.equal(parseWhen('Saturday, October 18 · 7:00 PM PDT', { tz: TZ, ref }).start.toISOString(), '2026-10-19T02:00:00.000Z')
  const r = parseWhen('Saturday, October 25 · 6:30 PM – 9:30 PM PDT', { tz: TZ, ref })
  assert.equal(r.start.toISOString(), '2026-10-26T01:30:00.000Z')
  assert.equal(r.end.toISOString(), '2026-10-26T04:30:00.000Z')
  // no abbreviation → person tz (New York here)
  assert.equal(parseWhen('Sat, Oct 18, 7pm', { tz: 'America/New_York', ref }).start.toISOString(), '2026-10-18T23:00:00.000Z')
  // "7 - 9pm": first hour inherits pm
  const e = parseWhen('Thursday, December 11 at 7 - 9pm', { tz: TZ, ref })
  assert.equal(e.start.toISOString(), '2026-12-12T03:00:00.000Z')
  assert.equal(e.end.toISOString(), '2026-12-12T05:00:00.000Z')
  // year inference across New Year
  assert.equal(parseWhen('Friday, January 9 · 8:00 PM EST', { tz: TZ, ref: '2026-12-20T00:00:00Z' }).start.toISOString(), '2027-01-10T01:00:00.000Z')
  // European order + 24h clock
  assert.equal(parseWhen('18 October 2026, 19:00 CET', { tz: TZ, ref }).start.toISOString(), '2026-10-18T17:00:00.000Z')
  assert.equal(parseWhen('Sat Oct 18, 2026', { tz: TZ, ref }).allDay, true)
  assert.equal(parseWhen('no date here', { tz: TZ, ref }), null)
})

test('zonedToDate handles DST transitions', () => {
  // 2026-11-01 02:00 PDT → PST. 8pm that day is PST (UTC-8).
  assert.equal(zonedToDate({ y: 2026, m: 10, d: 1, hh: 20 }, TZ).toISOString(), '2026-11-02T04:00:00.000Z')
  assert.equal(zonedToDate({ y: 2026, m: 6, d: 4, hh: 12 }, TZ).toISOString(), '2026-07-04T19:00:00.000Z')
})

test('parseGoogleSubjectWhen: same-day, multi-day and all-day', () => {
  const ref = '2026-10-08T12:00:00Z'
  const a = parseGoogleSubjectWhen('Sat Oct 18, 2026 7pm - 9pm (PDT)', { tz: TZ, ref })
  assert.equal(a.start.toISOString(), '2026-10-19T02:00:00.000Z')
  assert.equal(a.end.toISOString(), '2026-10-19T04:00:00.000Z')
  const b = parseGoogleSubjectWhen('Fri Oct 17, 2026 7pm - Sat Oct 18, 2026 9am (PDT)', { tz: TZ, ref })
  assert.equal(b.end.toISOString(), '2026-10-18T16:00:00.000Z')
  assert.equal(parseGoogleSubjectWhen('Sat Oct 18, 2026 (PDT)', { tz: TZ, ref }).allDay, true)
})

// ---------- html + names ----------

test('htmlToText strips style/script and keeps line structure; extractLinks unwraps click trackers', () => {
  const t = htmlToText(PARTIFUL_GOING.html)
  assert.match(t, /^Jess's Rooftop Birthday Bash! 🎂/m)
  assert.doesNotMatch(t, /color:red/)
  const links = extractLinks(PARTIFUL_GOING.html)
  assert.ok(links.some(l => l.href === 'https://partiful.com/e/kJ8sD2mQ9xLp?utm_source=email' && l.viaTracker))
})

test('looksLikeName and guestsFromText', () => {
  assert.ok(looksLikeName('Alice Chen'))
  assert.ok(looksLikeName('Ana de la Cruz'))
  assert.ok(looksLikeName('Zoë O\'Brien-Smith'))
  assert.equal(looksLikeName('View Event'), false)
  assert.equal(looksLikeName('Partiful'), false)
  assert.equal(looksLikeName('you'), false)
  assert.equal(looksLikeName('12 others'), false)
  const g = guestsFromText('Alice Chen, Bob Li, Priya Patel and 12 others are going')
  assert.deepEqual(g.names, ['Alice Chen', 'Bob Li', 'Priya Patel'])
  assert.equal(g.others, 12)
  assert.deepEqual(guestsFromText('Dan Kim & Mei Wong are going').names, ['Dan Kim', 'Mei Wong'])
  assert.deepEqual(guestsFromText('Sam is going').names, ['Sam'])
})

test('canonicalUrl per provider', () => {
  assert.equal(canonicalUrl('partiful', ['https://partiful.com/e/kJ8sD2mQ9xLp?utm_source=email']), 'https://partiful.com/e/kJ8sD2mQ9xLp')
  assert.equal(canonicalUrl('luma', ['https://lu.ma/unsubscribe?x=1', 'https://lu.ma/user/usr-abc', 'https://lu.ma/ai-tinkerers-oct?tk=abc']), 'https://lu.ma/ai-tinkerers-oct')
  assert.equal(canonicalUrl('luma', ['https://luma.com/evt-Abc123']), 'https://lu.ma/evt-Abc123')
  assert.equal(canonicalUrl('eventbrite', ['https://www.eventbrite.com/e/vulfpeck-live-tickets-123456789012?aff=x']), 'https://www.eventbrite.com/e/vulfpeck-live-tickets-123456789012')
  assert.equal(canonicalUrl('googleCalendar', ['https://calendar.google.com/calendar/event?action=VIEW&eid=ABC&tok=XYZ']), 'https://calendar.google.com/calendar/event?eid=ABC')
})

// ---------- provider parsers ----------

test('Partiful: going confirmation → title, when, where, canonical url, guest names (text + avatar alts), host', () => {
  assert.equal(detectProvider(PARTIFUL_GOING), 'partiful')
  const ev = parseEmail(PARTIFUL_GOING, { tz: TZ, selfEmail: ME })
  assert.equal(ev.provider, 'partiful')
  assert.equal(ev.title, 'Jess\'s Rooftop Birthday Bash! 🎂')
  assert.equal(ev.start, '2026-10-19T02:00:00.000Z')
  assert.equal(ev.end, '2026-10-19T05:00:00.000Z')   // 3h default
  assert.equal(ev.location, 'The Battery Rooftop, 717 Battery St, San Francisco')
  assert.equal(ev.url, 'https://partiful.com/e/kJ8sD2mQ9xLp')
  assert.equal(ev.dedupeKey, ev.url)
  assert.equal(ev.rsvpStatus, 'going')
  assert.equal(ev.host, 'Jess Doe')
  const names = ev.attendees.map(a => a.name)
  assert.deepEqual(names, ['Jess Doe', 'Alice Chen', 'Bob Li', 'Priya Patel'])
  assert.equal(ev.attendees[0].role, 'host')
  assert.equal(ev.goingCount, 15)
  assert.ok(!names.includes('Partiful'))
})

test('Partiful: plain-text invite → year inference, host from subject, "Going" section names, invited status', () => {
  const ev = parseEmail(PARTIFUL_INVITE, { tz: TZ, selfEmail: ME })
  assert.equal(ev.title, 'Winter Solstice Potluck')
  assert.equal(ev.start, '2026-12-22T01:30:00.000Z')   // Dec 21 5:30pm PST
  assert.equal(ev.url, 'https://partiful.com/e/Qw3rTy7UiOp1')
  assert.equal(ev.rsvpStatus, 'invited')
  assert.equal(ev.host, 'Sam Rivera')
  assert.deepEqual(ev.attendees.map(a => a.name), ['Sam Rivera', 'Dana Whitfield', 'Kai Nakamura'])
  assert.equal(ev.location, '1234 Shotwell St, San Francisco, CA')
})

test('Luma: confirmation → add-to-calendar dates agree with prose, co-hosts, "X, Y and 24 others", reserved slugs skipped', () => {
  assert.equal(detectProvider(LUMA_CONFIRMED), 'luma')
  const ev = parseEmail(LUMA_CONFIRMED, { tz: TZ, selfEmail: ME })
  assert.equal(ev.title, 'AI Tinkerers SF — October Demo Night')
  assert.equal(ev.start, '2026-10-26T01:30:00.000Z')
  assert.equal(ev.end, '2026-10-26T04:30:00.000Z')
  assert.equal(ev.location, 'Shack15, 1 Ferry Building, San Francisco, CA 94111')
  assert.equal(ev.url, 'https://lu.ma/ai-tinkerers-oct')
  assert.equal(ev.rsvpStatus, 'going')
  assert.deepEqual(ev.attendees.filter(a => a.role === 'host').map(a => a.name), ['Priya Patel', 'Tom Okafor'])
  assert.deepEqual(ev.attendees.filter(a => !a.role).map(a => a.name), ['Dan Kim', 'Mei Wong'])
  assert.equal(ev.goingCount, 26)
})

test('Eventbrite: tickets → explicit-year date range, venue + address, url stripped of affiliate params, no bogus guests', () => {
  assert.equal(detectProvider(EVENTBRITE_TICKETS), 'eventbrite')
  const ev = parseEmail(EVENTBRITE_TICKETS, { tz: TZ, selfEmail: ME })
  assert.equal(ev.title, 'Vulfpeck Live at The Fillmore')
  assert.equal(ev.start, '2026-11-02T04:00:00.000Z')   // Nov 1 is already PST
  assert.equal(ev.end, '2026-11-02T07:00:00.000Z')
  assert.equal(ev.location, 'The Fillmore, 1805 Geary Blvd, San Francisco, CA 94115')
  assert.equal(ev.url, 'https://www.eventbrite.com/e/vulfpeck-live-at-the-fillmore-tickets-123456789012')
  assert.equal(ev.rsvpStatus, 'going')
  assert.deepEqual(ev.attendees, [])
})

test('Google Calendar invitation: ICS is the source of truth; attendees carry emails + PARTSTAT; self excluded', () => {
  assert.equal(detectProvider(GCAL_INVITE), 'googleCalendar')
  const ev = parseEmail(GCAL_INVITE, { tz: TZ, selfEmail: ME })
  assert.equal(ev.title, 'Dinner at Nopa')
  assert.equal(ev.start, '2026-10-19T02:00:00.000Z')
  assert.equal(ev.end, '2026-10-19T04:00:00.000Z')
  assert.equal(ev.location, 'Nopa, 560 Divisadero St, San Francisco, CA 94117')
  assert.equal(ev.dedupeKey, 'gcal:7f3k2m9q1abc@google.com')
  assert.equal(ev.url, 'https://www.google.com/calendar/event?eid=N2YzazJtOXExYWJjIG1hbGNvbG1Ac3RlbS5haQ')
  assert.equal(ev.rsvpStatus, 'invited')
  assert.equal(ev.host, 'Jess Doe')
  const jess = ev.attendees.find(a => a.email === 'jess@example.com')
  const bob = ev.attendees.find(a => a.email === 'bob@example.com')
  assert.equal(jess.name, 'Jess Doe'); assert.equal(jess.status, 'going')
  assert.equal(bob.name, 'Bob Li'); assert.equal(bob.status, 'maybe')
  assert.ok(!ev.attendees.some(a => a.email === ME))
})

test('Google Calendar invitation without ICS falls back to the subject line', () => {
  const ev = parseEmail({ ...GCAL_INVITE, ics: null, sender: '' }, { tz: TZ, selfEmail: ME })
  assert.equal(ev.title, 'Dinner at Nopa')
  assert.equal(ev.start, '2026-10-19T02:00:00.000Z')
  assert.equal(ev.end, '2026-10-19T04:00:00.000Z')
  assert.equal(ev.url, 'https://calendar.google.com/calendar/event?eid=N2YzazJtOXExYWJjIG1hbGNvbG1Ac3RlbS5haQ')
  assert.deepEqual(ev.attendees.find(a => a.role === 'host')?.name, 'Jess Doe')
  assert.ok(ev.attendees.some(a => a.name === 'Bob Li'))
})

test('Google Calendar "Accepted:" reply to my event → hosting, replier recorded as going', () => {
  const ev = parseEmail({
    subject: 'Accepted: Board games @ Sun Oct 26, 2026 3pm - 6pm (PDT) (malcolm@stem.ai)',
    from: 'Kai Nakamura <kai@example.com>', sender: 'Google Calendar <calendar-notification@google.com>', to: ME,
    date: '2026-10-08T17:00:00.000Z', text: 'Kai Nakamura has accepted this invitation.\n\nBoard games\nWhen\nSun Oct 26, 2026 3pm – 6pm Pacific Time\n', html: '',
  }, { tz: TZ, selfEmail: ME })
  assert.equal(ev.rsvpStatus, 'hosting')
  assert.equal(ev.start, '2026-10-26T22:00:00.000Z')
  assert.deepEqual(ev.attendees, [{ name: 'Kai Nakamura', email: 'kai@example.com', status: 'going' }])
})

test('non-event mail and undated event mail are ignored', () => {
  assert.equal(parseEmail({ subject: 'Your receipt', from: 'Stripe <receipts@stripe.com>', html: '<p>$5</p>', text: '' }, { tz: TZ }), null)
  assert.equal(parseEmail({ subject: 'New photos from Taco Tuesday', from: 'Partiful <hello@partiful.com>', html: '<p>Check them out <a href="https://partiful.com/e/abcdefgh">here</a></p>', text: '' }, { tz: TZ }), null)
})

// ---------- raw MIME → toEmail → parseEmail ----------

test('toEmail pulls a text/calendar attachment and Sender header out of a raw MIME message', async () => {
  const raw = [
    'From: Jess Doe <jess@example.com>', 'Sender: Google Calendar <calendar-notification@google.com>', `To: ${ME}`,
    'Subject: Invitation: Dinner at Nopa @ Sat Oct 18, 2026 7pm - 9pm (PDT) (malcolm@stem.ai)',
    'Date: Thu, 08 Oct 2026 10:00:00 -0700', 'Message-ID: <raw-1@google.com>', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain; charset=UTF-8', '',
    GCAL_INVITE.text, '--B', 'Content-Type: text/calendar; charset=UTF-8; method=REQUEST', 'Content-Transfer-Encoding: 7bit', '',
    GCAL_ICS, '--B--', '',
  ].join('\r\n')
  const email = toEmail(await simpleParser(raw))
  assert.match(email.sender, /calendar-notification@google\.com/)
  assert.ok(email.ics && /BEGIN:VEVENT/.test(email.ics))
  assert.equal(email.messageId, '<raw-1@google.com>')
  const ev = parseEmail(email, { tz: TZ, selfEmail: ME })
  assert.equal(ev.dedupeKey, 'gcal:7f3k2m9q1abc@google.com')
  assert.equal(ev.attendees.find(a => a.email === 'jess@example.com')?.name, 'Jess Doe')
})

// ---------- merging + observation shape ----------

test('mergeEvents unions attendees, keeps the strongest rsvp status, prefers newer non-null scalars', () => {
  const a = { title: 'X', url: 'u', rsvpStatus: 'invited', attendees: [{ name: 'Alice Chen' }, { name: 'Bob Li', email: 'bob@example.com' }], goingCount: 3, location: 'Somewhere' }
  const b = { title: 'X (updated)', url: 'u', rsvpStatus: 'going', attendees: [{ name: 'Bob', email: 'bob@example.com' }, { name: 'Kai Nakamura' }], goingCount: null, location: null }
  const m = mergeEvents(a, b)
  assert.equal(m.title, 'X (updated)')
  assert.equal(m.location, 'Somewhere')
  assert.equal(m.rsvpStatus, 'going')
  assert.equal(m.goingCount, 3)
  assert.deepEqual(m.attendees.map(x => x.name), ['Alice Chen', 'Bob Li', 'Kai Nakamura'])
  // a reminder after a confirmation shouldn't downgrade going → unknown
  assert.equal(mergeEvents({ rsvpStatus: 'going', attendees: [] }, { rsvpStatus: 'unknown', attendees: [] }).rsvpStatus, 'going')
})

test('toObservation produces the core event shape', () => {
  const ev = parseEmail(PARTIFUL_GOING, { tz: TZ, selfEmail: ME })
  const o = toObservation(ev)
  assert.equal(o.kind, 'event')
  assert.equal(o.at, ev.start); assert.equal(o.until, ev.end); assert.equal(o.dedupeKey, ev.url)
  assert.equal(o.data.provider, 'partiful'); assert.equal(o.data.busy, true)
  assert.ok(Array.isArray(o.data.attendees) && o.data.attendees.every(a => 'name' in a && 'email' in a))
})

// ---------- integration: in-memory context, identity binding, coAttendance ----------

test('manifest shape', () => {
  assert.equal(plugin.id, 'gmailRsvp')
  assert.equal(plugin.intervalMin, 20)
  assert.deepEqual(plugin.kinds, ['event'])
  assert.deepEqual(plugin.setup.map(s => s.key), ['email', 'appPassword', 'since'])
  assert.equal(plugin.setup[1].type, 'secret')
  assert.equal(plugin.setup[0].type, 'text')
  assert.equal(plugin.setup[2].parse('abc'), 30)
  assert.equal(plugin.setup[1].parse('abcd efgh ijkl mnop'), 'abcdefghijklmnop')
  assert.equal(typeof plugin.poll, 'function')
})

test('ingesting a parsed Partiful event fires coAttendance for a friend on the guest list (by name) and by bound email', async () => {
  const ctx = await buildContext(process.env, { dbPath: ':memory:' })
  assert.ok(ctx.plugins.sources.gmailRsvp, 'plugin loads via the plugin loader')
  const me = ctx.people.create({ displayName: 'Malcolm', tz: TZ })
  const alice = ctx.people.create({ displayName: 'Alice Chen', tz: TZ })
  const bob = ctx.people.create({ displayName: 'Robert Li', tz: TZ })
  ctx.people.setRel(me.id, alice.id, { tier: 'friend', wantMore: true })
  ctx.people.setRel(me.id, bob.id, { tier: 'friend', wantMore: true })
  // what poll() does on connect, for Bob's side: his inbox binds his email
  ctx.people.bind(bob.id, 'email', 'bob@example.com')
  ctx.people.bind(bob.id, 'email', 'bob@example.com')   // idempotent
  assert.equal(ctx.people.identities(bob.id).filter(i => i.channel === 'email').length, 1)

  // freeze time so the event is in the future relative to the fixture
  const future = new Date(Date.now() + 10 * 864e5)
  const ev = parseEmail(GCAL_INVITE, { tz: TZ, selfEmail: ME })
  ev.start = future.toISOString(); ev.end = new Date(future.getTime() + 7200e3).toISOString()
  ev.attendees.push({ name: 'Alice Chen', email: null })
  const inserted = await ctx.observations.ingest(me.id, 'gmailRsvp', [toObservation(ev)])
  assert.equal(inserted.length, 1)
  const opps = ctx.db.all('select * from opportunities where kind = ?', 'coAttendance')
  const who = opps.map(o => JSON.parse(o.participants)).map(p => p.find(x => x !== me.id)).sort()
  assert.deepEqual(who, [alice.id, bob.id].sort(), 'Alice matched by name, Bob matched by bound email')

  // re-ingesting the same dedupeKey with identical data is a no-op
  const again = await ctx.observations.ingest(me.id, 'gmailRsvp', [toObservation(ev)])
  assert.equal(again.length, 0)
  assert.equal(ctx.db.get('select count(*) as n from observations where source_id = ?', 'gmailRsvp').n, 1)
})

test('poll() rejects an incomplete config before touching the network', async () => {
  const ctx = await buildContext(process.env, { dbPath: ':memory:' })
  const me = ctx.people.create({ displayName: 'Malcolm', tz: TZ })
  await assert.rejects(() => plugin.poll(ctx, me, { email: ME }, null), /appPassword/)
})
