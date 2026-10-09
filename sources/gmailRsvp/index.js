import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { parseEmail } from './parsers.js'

// Event emails over IMAP (Gmail app password, no OAuth). Partiful, Luma, Eventbrite, Google Calendar
// invitations → `event` observations with attendee names, so coAttendance can spot friends on guest lists
// even when those friends aren't on the system yet.

const DEFAULT_SINCE_DAYS = 30
const MAX_MESSAGES_PER_POLL = 300
const SENDER_FILTERS = [
  { from: 'partiful.com' }, { from: 'lu.ma' }, { from: 'luma.com' }, { from: 'eventbrite' },
  { from: 'calendar-notification@google.com' }, { header: { Sender: 'calendar-notification@google.com' } },
  { subject: 'Invitation:' }, { subject: 'Updated invitation' },
]

export default {
  id: 'gmailRsvp',
  name: 'Event emails (Gmail)',
  description: 'Reads Partiful, Luma, Eventbrite and Google Calendar emails from your Gmail inbox over IMAP. Events feed co-attendance (including guest names of friends not yet on the system), plans and taste.',
  repo: 'https://github.com/malcolmocean/opportune/tree/main/sources/gmailRsvp',
  kinds: ['event'],
  intervalMin: 20,
  setup: [
    { key: 'email', type: 'text', label: 'Your Gmail address' },
    { key: 'appPassword', type: 'secret', label: 'A Gmail app password (myaccount.google.com/apppasswords — needs 2-step verification on). Spaces are fine, I\'ll strip them.', parse: v => v.replace(/\s+/g, '') },
    { key: 'since', type: 'text', label: 'How many days back should I read on the first pass? (default 30)', optional: true, parse: v => Math.max(1, Math.min(365, parseInt(v, 10) || DEFAULT_SINCE_DAYS)) },
  ],

  async poll(ctx, person, config, lastPollIso) {
    const L = ctx.log('gmailRsvp')
    const email = String(config.email || '').trim().toLowerCase()
    const pass = String(config.appPassword || '').replace(/\s+/g, '')
    if (!email || !pass) throw new Error('gmailRsvp: email and appPassword are required')

    // Identity: lets coAttendance match guest-list emails to this person when they appear on a friend's event.
    ctx.people.bind(person.id, 'email', email)

    const sinceDays = +config.since > 0 ? +config.since : DEFAULT_SINCE_DAYS
    // Overlap the previous poll by a day: IMAP SINCE is date-granular and clocks drift. dedupeKey absorbs repeats.
    const since = lastPollIso ? new Date(new Date(lastPollIso).getTime() - 864e5) : new Date(Date.now() - sinceDays * 864e5)

    const client = new ImapFlow({
      host: config.imapHost || 'imap.gmail.com', port: +(config.imapPort || 993), secure: true,
      auth: { user: email, pass }, logger: false, emitLogs: false, connectionTimeout: 30e3, greetingTimeout: 20e3, socketTimeout: 120e3,
    })
    const messages = []
    await client.connect()
    try {
      const mailbox = await pickMailbox(client)
      const lock = await client.getMailboxLock(mailbox)
      try {
        const uids = new Set()
        for (const f of SENDER_FILTERS) {
          try {
            const found = await client.search({ since, ...f }, { uid: true })
            for (const u of found || []) uids.add(u)
          } catch (e) { L.warn(`search ${JSON.stringify(f)} failed: ${e.message}`) }
        }
        const list = [...uids].sort((a, b) => a - b).slice(-MAX_MESSAGES_PER_POLL)
        L.info(`${person.display_name || person.id}: ${list.length} candidate emails in ${mailbox} since ${since.toISOString().slice(0, 10)}`)
        if (list.length) {
          for await (const msg of client.fetch(list, { uid: true, source: true }, { uid: true })) {
            if (msg.source) messages.push(msg.source)
          }
        }
      } finally { lock.release() }
    } finally {
      try { await client.logout() } catch { client.close() }
    }

    const byKey = new Map()
    let skipped = 0
    for (const source of messages) {
      let parsed
      try { parsed = await simpleParser(source) } catch (e) { skipped++; L.warn(`mail parse failed: ${e.message}`); continue }
      const ev = parseEmail(toEmail(parsed), { tz: person.tz || 'UTC', selfEmail: email })
      if (!ev) { skipped++; continue }
      const prev = byKey.get(ev.dedupeKey)
      byKey.set(ev.dedupeKey, prev ? mergeEvents(prev, ev) : ev)
    }
    // Merge with what we already know about each event (an earlier mail may have listed more guests).
    const out = []
    for (const ev of byKey.values()) {
      const existing = ctx.db.get('select data from observations where person_id = ? and source_id = ? and dedupe_key = ?', person.id, 'gmailRsvp', ev.dedupeKey)
      const merged = existing ? mergeEvents(safeJson(existing.data), ev) : ev
      out.push(toObservation(merged))
    }
    L.info(`${person.display_name || person.id}: ${out.length} events (${skipped} emails skipped)`)
    return out
  },
}

// Normalize a mailparser result into the plain shape the pure parsers take.
export function toEmail(parsed) {
  const addr = a => a?.value?.map(v => v.name ? `${v.name} <${v.address}>` : v.address).join(', ') || a?.text || ''
  const icsAtt = (parsed.attachments || []).find(a => /text\/calendar|application\/ics/i.test(a.contentType || '') || /\.ics$/i.test(a.filename || ''))
  const sender = parsed.headers?.get?.('sender')
  return {
    subject: parsed.subject || '', from: addr(parsed.from), to: parsed.to?.value?.[0]?.address || '',
    sender: sender ? (sender.text || addr(sender)) : '',
    html: typeof parsed.html === 'string' ? parsed.html : (parsed.textAsHtml || ''),
    text: parsed.text || '', date: parsed.date ? new Date(parsed.date).toISOString() : null,
    ics: icsAtt?.content ? icsAtt.content.toString('utf8') : null, messageId: parsed.messageId || null,
  }
}

// Later mail wins for scalar fields when it has them; attendees union by email then name.
export function mergeEvents(a, b) {
  if (!a) return b
  if (!b) return a
  const seen = new Set(), attendees = []
  for (const x of [...(a.attendees || []), ...(b.attendees || [])]) {
    const key = (x.email || x.name || '').toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key); attendees.push(x)
  }
  const rank = { unknown: 0, invited: 1, waitlist: 2, maybe: 3, going: 4, hosting: 5, declined: 6, cancelled: 7 }
  const rsvpStatus = (rank[b.rsvpStatus] ?? 0) >= (rank[a.rsvpStatus] ?? 0) ? b.rsvpStatus : a.rsvpStatus
  return {
    ...a, ...stripNulls(b), attendees, rsvpStatus,
    goingCount: Math.max(a.goingCount || 0, b.goingCount || 0) || null,
  }
}
const stripNulls = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== 'unknown'))
const safeJson = s => { try { return typeof s === 'string' ? JSON.parse(s) : s } catch { return null } }

export function toObservation(ev) {
  const busy = ['going', 'maybe', 'hosting'].includes(ev.rsvpStatus)
  return {
    kind: 'event', at: ev.start, until: ev.end || null, dedupeKey: ev.dedupeKey,
    data: {
      title: ev.title, start: ev.start, end: ev.end || null, allDay: !!ev.allDay, location: ev.location || null, url: ev.url || null,
      provider: ev.provider, attendees: ev.attendees || [], rsvpStatus: ev.rsvpStatus, goingCount: ev.goingCount ?? null, host: ev.host || null, busy,
    },
  }
}

// Gmail: prefer "[Gmail]/All Mail" so archived RSVPs count; other servers: INBOX.
async function pickMailbox(client) {
  try {
    const boxes = await client.list()
    const all = boxes.find(b => b.specialUse === '\\All') || boxes.find(b => /all mail/i.test(b.path))
    if (all) return all.path
  } catch { /* fall through */ }
  return 'INBOX'
}
