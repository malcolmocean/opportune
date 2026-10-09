// Pure parsers: { subject, from, html, text, date, ics?, sender?, messageId? } → normalized event or null.
// No IO. Everything here is unit-testable with fixture strings (see tests/gmailRsvp.test.js).
import ical from 'node-ical'
import { htmlToText, extractLinks, imgAlts, datetimeAttrs, firstHeading } from './html.js'
import { parseWhen, parseGoogleSubjectWhen, tzFromText } from './dates.js'

export const PROVIDERS = ['partiful', 'luma', 'eventbrite', 'googleCalendar']

// ---------- provider detection ----------
export function detectProvider(email) {
  const from = (email.from || '').toLowerCase()
  const sender = (email.sender || '').toLowerCase()
  const subject = email.subject || ''
  if (/partiful\.com/.test(from)) return 'partiful'
  if (/@(?:[\w.-]*\.)?(?:lu\.ma|luma\.com|luma-mail\.com)\b/.test(from) || /\bluma\b/.test(from) && /lu\.ma|luma\.com/.test(email.html || email.text || '')) return 'luma'
  if (/eventbrite\.[a-z.]+/.test(from)) return 'eventbrite'
  if (/calendar-notification@google\.com/.test(from + ' ' + sender)) return 'googleCalendar'
  if (GCAL_SUBJECT.test(subject) && (email.ics || /calendar\.google\.com|google\.com\/calendar/i.test(email.html || email.text || ''))) return 'googleCalendar'
  if (email.ics && /PRODID:[^\n]*Google/i.test(email.ics)) return 'googleCalendar'
  return null
}

// ---------- shared pieces ----------
const STOP_NAMES = new Set(['you', 'partiful', 'luma', 'eventbrite', 'google', 'google calendar', 'view event', 'rsvp', 'going', 'maybe', 'host', 'hosts', 'hosted by', 'logo', 'icon', 'image', 'calendar', 'map', 'guests', 'guest list', 'see all', 'view all', 'more', 'others', 'avatar', 'qr code', 'ticket', 'tickets', 'event', 'reminder', 'details', 'approved', 'waitlist', 'and', 'photo', 'cover', 'banner', 'header'])

// 1–4 capitalized tokens, letters/apostrophes/hyphens/dots, nothing that smells like UI copy.
export function looksLikeName(s) {
  if (!s) return false
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length < 2 || t.length > 40) return false
  if (STOP_NAMES.has(t.toLowerCase())) return false
  if (/\d|@|https?:|\b(logo|icon|image|photo|avatar|qr)\b/i.test(t)) return false
  const toks = t.split(' ')
  if (toks.length > 4) return false
  // every token starts uppercase (or is a particle like "de", "van", "of") and has no trailing punctuation
  return toks.every(w => /^(?:\p{Lu}[\p{L}'’.-]*|de|da|del|van|von|der|la|le|du|of|the|bin|al)$/u.test(w)) && /^\p{Lu}/u.test(toks[0])
}

const cleanName = s => s.replace(/\s+/g, ' ').replace(/[,.!:;]+$/, '').trim()

// "Alice Chen, Bob Li and 12 others are going" / "Alice & Bob are going" / "Alice is going"
export function guestsFromText(text) {
  const out = { names: [], others: 0 }
  if (!text) return out
  const t = text.replace(/ /g, ' ')
  const re = /((?:\p{Lu}[\p{L}'’.-]*(?: \p{Lu}[\p{L}'’.-]*){0,3})(?:, (?:\p{Lu}[\p{L}'’.-]*(?: \p{Lu}[\p{L}'’.-]*){0,3})){0,8}(?:,? (?:and|&) (?:\p{Lu}[\p{L}'’.-]*(?: \p{Lu}[\p{L}'’.-]*){0,3}|(\d+) others?))?)\s+(?:are|is) (?:going|attending|in|coming|registered|on the list)\b/gu
  for (const m of t.matchAll(re)) {
    const chunk = m[1].replace(/,? (?:and|&) \d+ others?$/, '')
    if (m[2]) out.others += +m[2]
    for (const part of chunk.split(/,\s*|\s+(?:and|&)\s+/)) {
      const n = cleanName(part)
      if (looksLikeName(n) && !out.names.includes(n)) out.names.push(n)
    }
  }
  // "+12 others" / "and 12 more" nearby a guest list
  if (!out.others) { const m = t.match(/\+\s?(\d+)\s+(?:others?|more)\b|and (\d+) (?:others?|more)\b/i); if (m) out.others = +(m[1] || m[2]) }
  return out
}

// Lines under a "Going" / "Guests" / "Who's going" header that look like names.
export function guestsFromSection(text) {
  const names = []
  if (!text) return names
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^(?:who'?s going|going|guests?|guest list|attendees|who)\b(?:\s*\(?\d*\)?)?\s*:?\s*$/i.test(lines[i].trim())) continue
    for (let j = i + 1; j < lines.length && j <= i + 40; j++) {
      const l = lines[j].trim()
      if (!l) { if (names.length) break; else continue }
      if (/^(?:see|view|show)\b|^\+?\d+\s+(?:others?|more|going)|^and \d+/i.test(l)) break
      const n = cleanName(l.replace(/\s+[-–]\s+(organizer|host|optional|cohost|co-host)$/i, '').replace(/\s*\((?:host|organizer|you)\)$/i, ''))
      if (looksLikeName(n)) { if (!names.includes(n)) names.push(n) } else if (!/@/.test(l)) break
    }
  }
  return names
}

// Avatar <img alt="Jess Doe"> lists.
export function guestsFromAlts(alts) {
  return (alts || []).map(cleanName).filter(looksLikeName).filter((n, i, a) => a.indexOf(n) === i)
}

export function goingCountFromText(text) {
  const m = (text || '').match(/\bgoing\s*\((\d+)\)|\b(\d+)\s+(?:guests?\s+)?(?:going|attending|registered)\b|\b(\d+)\s+guests\b/i)
  return m ? +(m[1] || m[2] || m[3]) : null
}

// Google "Add to calendar" links carry machine-readable dates/location/title. Any provider may include one.
export function fromAddToCalendarLink(links) {
  for (const { href } of links || []) {
    if (!/calendar\.google\.com\/calendar\/(?:render|u\/\d\/r|event)|google\.com\/calendar\/(?:render|event)/i.test(href) || !/action=TEMPLATE/i.test(href)) continue
    try {
      const u = new URL(href)
      const dates = u.searchParams.get('dates')
      if (!dates) continue
      const [a, b] = dates.split('/')
      const start = gcalStamp(a), end = gcalStamp(b)
      if (!start) continue
      return { start, end, title: u.searchParams.get('text') || null, location: u.searchParams.get('location') || null, allDay: !/T/.test(a) }
    } catch { /* ignore */ }
  }
  return null
}
function gcalStamp(s) {
  if (!s) return null
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return null
  if (!m[4]) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  if (m[7]) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)))
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)))   // floating; treated as UTC (rare)
}

// Text after "📍" / "Where" / "Location" markers, first line.
export function locationFromText(text) {
  if (!text) return null
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    let m = l.match(/^(?:📍|🏠|📌)\s*(.+)$/u) || l.match(/^(?:where|location|venue|address)\s*[:：]\s*(.+)$/i)
    if (m && m[1].trim()) return tidyLocation(m[1])
    if (/^(?:where|location|venue)\s*:?\s*$/i.test(l) || /^📍\s*$/u.test(l)) {
      const nxt = lines.slice(i + 1).map(x => x.trim()).filter(Boolean)
      if (!nxt.length) continue
      // Eventbrite style: venue name line then address line
      const parts = [nxt[0]]
      if (nxt[1] && /\d/.test(nxt[1]) && nxt[1].length < 90 && !/^(when|date|time|\d{1,2}:\d{2})/i.test(nxt[1])) parts.push(nxt[1])
      return tidyLocation(parts.join(', '))
    }
  }
  // no marker: a line that reads like a street address ("1234 Shotwell St, San Francisco, CA")
  const STREET = /^\d{1,6}[a-z]?\s+[\p{L}0-9.'’ -]+\b(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|way|ln|lane|pl|place|ct|court|hwy|pkwy|terrace|ter|cir|circle|sq|square|alley|broadway|embarcadero)\b\.?(?:,.*)?$/iu
  for (const raw of lines) {
    const l = raw.trim()
    if (l.length < 8 || l.length > 160) continue
    if (STREET.test(l) || /,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/.test(l) && /\d/.test(l) && !/\b(?:am|pm)\b/i.test(l)) return tidyLocation(l)
  }
  return null
}
const tidyLocation = s => { const t = s.replace(/\s+/g, ' ').replace(/\s*\((?:map|directions|get directions|view map)\)\s*$/i, '').replace(/\s*[-–·|]\s*(?:map|directions|get directions|view map)\s*$/i, '').trim(); return t.length > 1 && t.length < 200 ? t : null }

// Date-bearing text near "📅" / "When" markers gets first crack, since bodies mention other dates (ticket purchase, footer).
export function whenFromText(text, opts) {
  if (!text) return null
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    const m = l.match(/^(?:📅|🗓|📆|🕒|🕖|⏰)\s*(.*)$/u) || l.match(/^(?:when|date|date and time|date & time|time)\s*[:：]\s*(.*)$/i)
    if (m) {
      const chunk = [m[1], lines[i + 1], lines[i + 2]].filter(Boolean).join(' ')
      const w = parseWhen(chunk, opts)
      if (w) return w
    }
    if (/^(?:when|date and time|date & time|date)\s*:?\s*$/i.test(l)) {
      const w = parseWhen(lines.slice(i + 1, i + 4).join(' '), opts)
      if (w) return w
    }
  }
  return parseWhen(text, opts)
}

export function rsvpStatusFromText(subject, body) {
  const s = (subject || '').toLowerCase(), b = (body || '').slice(0, 1500).toLowerCase()
  const both = s + '\n' + b
  if (/\b(?:canceled|cancelled)\b/.test(s)) return 'cancelled'
  if (/you can'?t make it|you'?re not going|marked (?:as )?not going|you declined|sorry you can'?t/.test(both)) return 'declined'
  if (/waitlist/.test(s) || /you'?re on the waitlist/.test(b)) return 'waitlist'
  if (/you'?re going|you're in\b|you’re in\b|see you there|your tickets?|your order|order confirm|you'?re registered|registration .*confirmed|spot is confirmed|^confirmed:|you'?re confirmed|approved|thanks for rsvp|rsvp confirmed|is tomorrow|is today|starts in|starting soon|reminder/.test(both)) {
    if (/\bmaybe\b/.test(s) || /you'?re a maybe|rsvp'?d maybe|marked maybe/.test(b)) return 'maybe'
    return 'going'
  }
  if (/\bmaybe\b/.test(s)) return 'maybe'
  if (/invited you|you'?re invited|invitation|invites you|can you make it|you'?ve been invited|join us|wants you there/.test(both)) return 'invited'
  return 'unknown'
}

// ---------- ICS (Google invites, Luma attachments) ----------
export function parseIcs(str) {
  if (!str) return null
  let data
  try { data = ical.sync.parseICS(str) } catch { return null }
  const ev = Object.values(data).find(x => x.type === 'VEVENT')
  if (!ev) return null
  const list = x => x ? (Array.isArray(x) ? x : [x]) : []
  const person = a => typeof a === 'string'
    ? { name: null, email: a.replace(/^mailto:/i, '') || null }
    : { name: a?.params?.CN || null, email: (a?.val || '').replace(/^mailto:/i, '') || null, status: partstat(a?.params?.PARTSTAT), role: /CHAIR/i.test(a?.params?.ROLE || '') ? 'host' : undefined }
  const start = ev.start instanceof Date ? ev.start : (ev.start ? new Date(ev.start) : null)
  const end = ev.end instanceof Date ? ev.end : (ev.end ? new Date(ev.end) : null)
  return {
    uid: ev.uid || null, title: ev.summary || null, start: start && !isNaN(start) ? start : null, end: end && !isNaN(end) ? end : null,
    allDay: ev.datetype === 'date', location: ev.location || null, url: ev.url || null, status: ev.status || null,
    organizer: ev.organizer ? person(ev.organizer) : null,
    attendees: list(ev.attendee).map(person).filter(a => a.name || a.email),
    description: ev.description || '',
  }
}
const partstat = p => ({ ACCEPTED: 'going', DECLINED: 'declined', TENTATIVE: 'maybe', 'NEEDS-ACTION': 'invited' })[(p || '').toUpperCase()] || undefined

// ---------- canonical URLs ----------
const LUMA_RESERVED = new Set(['user', 'settings', 'unsubscribe', 'calendar', 'discover', 'home', 'signin', 'login', 'create', 'help', 'privacy', 'terms', 'pricing', 'explore', 'p', 'u', 'c', 'api', 'img', 'cdn', 'static', 'ios', 'android', 'app', 'download', 'email', 'tickets', 'check-in', 'checkin', 'my-tickets', 'blog', 'about', 'contact', 'support', 'host', 'hosts', 'map', 'sf', 'nyc', 'la', 'london'])

export function canonicalUrl(provider, candidates) {
  const hrefs = (candidates || []).map(c => typeof c === 'string' ? c : c.href).filter(Boolean)
  const find = (re, fmt) => { for (const h of hrefs) { const m = h.match(re); if (m) return fmt(m) } return null }
  switch (provider) {
    case 'partiful':
      return find(/https?:\/\/(?:www\.)?partiful\.com\/e\/([A-Za-z0-9_-]{6,})/i, m => `https://partiful.com/e/${m[1]}`)
    case 'luma': {
      const evt = find(/https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/(?:e\/|event\/)?(evt-[A-Za-z0-9_-]+)/i, m => `https://lu.ma/${m[1]}`)
      if (evt) return evt
      for (const h of hrefs) {
        const m = h.match(/https?:\/\/(?:www\.)?(lu\.ma|luma\.com)\/([A-Za-z0-9_-]{3,40})(?:[/?#]|$)/i)
        if (m && !LUMA_RESERVED.has(m[2].toLowerCase()) && !/^(?:unsubscribe|settings|user)/i.test(m[2])) return `https://lu.ma/${m[2]}`
      }
      return null
    }
    case 'eventbrite':
      return find(/https?:\/\/(?:www\.)?(eventbrite\.[a-z.]{2,10})\/e\/([A-Za-z0-9_-]+?-tickets-\d+|\d+)/i, m => `https://www.${m[1].toLowerCase()}/e/${m[2]}`)
    case 'googleCalendar':
      return find(/https?:\/\/(?:www\.google\.com\/calendar|calendar\.google\.com\/calendar)\/event\?[^"'\s]*\beid=([A-Za-z0-9_-]+)/i, m => `https://calendar.google.com/calendar/event?eid=${m[1]}`)
    default: return null
  }
}

// ---------- subject → title / host ----------
const GCAL_SUBJECT = /^(invitation|updated invitation(?: with note)?|accepted|tentatively accepted|declined|canceled event|cancelled event|new event|reminder)(?: from [^:]+)?:\s/i

export function titleFromSubject(provider, subject) {
  const s = (subject || '').replace(/\s+/g, ' ').trim()
  const pats = {
    partiful: [
      /^you'?re going to (.+?)!?$/i, /^you'?re invited(?: to)?:? (.+?)!?$/i, /^(.+?) invited you(?: to)?:? (.+?)!?$/i,
      /^reminder: (.+?) (?:is|starts) (?:tomorrow|today|tonight|soon|in .+)!?$/i, /^(.+?) is (?:tomorrow|today|tonight)!?$/i,
      /^(.+?) updated (.+?)!?$/i, /^update(?:d)?: (.+?)!?$/i, /^your rsvp (?:to|for) (.+?)!?$/i, /^(.+?): can you make it\??$/i,
      /^you'?re on the waitlist for (.+?)!?$/i, /^(?:new )?(?:message|note) from (?:the )?host of (.+?)!?$/i, /^(?:new )?photos? (?:from|at) (.+?)!?$/i,
    ],
    luma: [
      /^you'?re in!? (.+?)!?$/i, /^(?:confirmed|approved|registered): (.+?)$/i, /^your (?:registration|spot|ticket) (?:for|to) (.+?) (?:is|has been) (?:confirmed|approved)!?$/i,
      /^your spot is confirmed for (.+?)!?$/i, /^you'?re on the waitlist for (.+?)!?$/i, /^(.+?) invited you to (.+?)!?$/i, /^you'?re invited(?: to)?:? (.+?)!?$/i,
      /^reminder: (.+?) (?:is|starts) (?:tomorrow|today|tonight|soon|in .+)!?$/i, /^(.+?) (?:is|starts) (?:tomorrow|today|tonight|in \d+ (?:hours?|minutes?))!?$/i,
      /^(?:update|event update|updated): (.+?)$/i, /^(.+?) has been updated$/i, /^(?:host )?message(?: from .+?)?: (.+?)$/i,
    ],
    eventbrite: [
      /^your tickets? (?:for|to) (.+?)!?$/i, /^your order (?:for|to) (.+?)(?: is confirmed| has been confirmed)?!?$/i, /^order confirmation (?:for|-|–) (.+?)$/i,
      /^(?:thanks for your order!?\s*)?(?:here are your tickets (?:for|to) )?(.+?)$/i, /^reminder: (.+?) (?:is|starts) (?:tomorrow|today|tonight|soon|in .+)!?$/i, /^(.+?) (?:is|starts) (?:tomorrow|today|tonight|soon|starting soon)!?$/i,
    ],
  }
  for (const re of pats[provider] || []) {
    const m = s.match(re)
    if (!m) continue
    const title = m[2] ?? m[1]
    const host = m[2] != null ? m[1] : null
    if (title && title.length > 1) return { title: title.trim(), host: host && looksLikeName(host) ? host.trim() : null }
  }
  return { title: null, host: null }
}

export function hostFromText(text) {
  const m = (text || '').match(/\bhosted by\s+(.+?)(?:\n|$| ·| \|| and \d+| \+ \d+)/i) || (text || '').match(/\bhosts?:\s*(.+?)(?:\n|$)/i)
  if (!m) return []
  return m[1].split(/,\s*|\s+(?:and|&)\s+/).map(cleanName).filter(looksLikeName)
}

// ---------- the main entry ----------
// opts: { tz: person's IANA zone, selfEmail: the inbox owner's address, now: Date for year inference }
export function parseEmail(email, opts = {}) {
  const provider = detectProvider(email)
  if (!provider) return null
  const tz = opts.tz || 'UTC'
  const ref = email.date ? new Date(email.date) : (opts.now || new Date())
  const html = email.html || ''
  const text = (email.text && email.text.trim().length > 40 ? email.text : htmlToText(html)) || ''
  const links = extractLinks(html).concat([...(email.text || '').matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map(m => ({ href: m[0], text: '' })))
  const ics = email.ics ? parseIcs(email.ics) : null
  const a2c = fromAddToCalendarLink(links)

  let ev
  if (provider === 'googleCalendar') ev = parseGoogle(email, { text, links, ics, tz, ref })
  else ev = parseEventMail(provider, email, { text, html, links, ics, tz, ref })
  if (!ev) return null

  // machine-readable date hints beat prose
  if (ics?.start) { ev.start = ics.start; ev.end = ics.end || ev.end; ev.allDay = ics.allDay }
  else if (a2c?.start && !ev.start) { ev.start = a2c.start; ev.end = a2c.end || null; ev.allDay = a2c.allDay }
  if (!ev.start) {
    const dts = datetimeAttrs(html)
    if (dts.length) { ev.start = dts[0]; ev.end = dts[1] && dts[1] > dts[0] ? dts[1] : null }
  }
  if (!ev.start) return null                                   // can't place it in time → not useful downstream

  ev.title = (ev.title || ics?.title || a2c?.title || firstHeading(html) || email.subject || '(untitled)').replace(/\s+/g, ' ').trim()
  ev.location = ev.location || ics?.location || a2c?.location || null
  if (!ev.end && !ev.allDay) ev.end = new Date(ev.start.getTime() + 3 * 3600e3)   // parties: assume 3h
  if (ev.allDay && !ev.end) ev.end = new Date(ev.start.getTime() + 864e5)

  // attendees: dedupe by email, then name; drop self
  const self = (opts.selfEmail || email.to || '').toLowerCase()
  const seen = new Set(), attendees = []
  for (const a of ev.attendees || []) {
    const name = a.name ? cleanName(a.name) : null, emailAddr = a.email ? a.email.toLowerCase() : null
    if (!name && !emailAddr) continue
    if (emailAddr && self && emailAddr === self) continue
    if (name && !emailAddr && !looksLikeName(name)) continue
    const key = emailAddr || name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    attendees.push({ name: name || null, email: emailAddr || null, ...(a.role ? { role: a.role } : {}), ...(a.status ? { status: a.status } : {}) })
  }
  ev.attendees = attendees

  const url = ev.url || canonicalUrl(provider, links)
  const dedupeKey = ev.dedupeKey || url || (email.messageId ? `msg:${email.messageId}` : `subj:${provider}:${ev.title}:${ev.start.toISOString().slice(0, 10)}`)
  return {
    title: ev.title, start: ev.start.toISOString(), end: ev.end ? ev.end.toISOString() : null, allDay: !!ev.allDay,
    location: ev.location, url, provider, attendees, rsvpStatus: ev.rsvpStatus || 'unknown',
    goingCount: ev.goingCount ?? null, host: ev.host || null, dedupeKey,
  }
}

// Partiful / Luma / Eventbrite share a shape: title from subject, prose date, 📍 location, guest names.
function parseEventMail(provider, email, { text, html, links, ics, tz, ref }) {
  const { title: subjTitle, host: subjHost } = titleFromSubject(provider, email.subject)
  const zone = tzFromText(text) || tz
  const when = whenFromText(text, { tz: zone, ref })
  const hosts = [...(subjHost ? [subjHost] : []), ...hostFromText(text)]
  const g = guestsFromText(text)
  const names = [...g.names, ...guestsFromSection(text), ...(provider !== 'eventbrite' ? guestsFromAlts(imgAlts(html)) : [])]
  const attendees = [
    ...hosts.map(n => ({ name: n, role: 'host' })),
    ...names.map(n => ({ name: n })),
    ...(ics?.attendees || []),
    ...(ics?.organizer ? [{ ...ics.organizer, role: 'host' }] : []),
  ]
  const explicitCount = goingCountFromText(text)
  const goingCount = explicitCount ?? (g.names.length || g.others ? g.names.length + g.others : null)
  // a "View event" style link is the best URL hint; canonicalUrl() scans all links anyway
  const preferred = links.filter(l => /view (?:event|invite|details)|open in|see event|event page|your ticket/i.test(l.text || ''))
  const url = canonicalUrl(provider, [...preferred, ...links])
  return {
    title: subjTitle, host: hosts[0] || null, start: when?.start || null, end: when?.end || null, allDay: when?.allDay || false,
    location: locationFromText(text), url, attendees, goingCount,
    rsvpStatus: rsvpStatusFromText(email.subject, text),
  }
}

// Google Calendar: subject carries title+time, ICS carries the truth, body has a "Who" list.
function parseGoogle(email, { text, links, ics, tz, ref }) {
  const subject = (email.subject || '').replace(/\s+/g, ' ').trim()
  const m = subject.match(/^(?<prefix>invitation|updated invitation(?: with note)?|accepted|tentatively accepted|declined|canceled event|cancelled event|new event|reminder)(?: from [^:]+)?:\s*(?<rest>.+)$/i)
  const prefix = (m?.groups.prefix || '').toLowerCase()
  let title = null, when = null
  if (m) {
    const rest = m.groups.rest
    const at = rest.lastIndexOf(' @ ')
    if (at > 0) {
      title = rest.slice(0, at).trim()
      let whenPart = rest.slice(at + 3).trim()
      whenPart = whenPart.replace(/\s*\([^()\s]+@[^()\s]+\)\s*$/, '')   // trailing (recipient@x)
      when = parseGoogleSubjectWhen(whenPart, { tz, ref })
    } else title = rest.trim()
  }
  // body: "Who" section + mailto links
  const attendees = []
  const organizers = new Set()
  for (const line of text.split('\n')) {
    const mm = line.trim().match(/^[•*-]?\s*(.+?)\s+[-–]\s+organizer$/i)
    if (mm && looksLikeName(mm[1])) organizers.add(mm[1])
  }
  for (const n of guestsFromSection(text)) attendees.push({ name: n, ...(organizers.has(n) ? { role: 'host' } : {}) })
  for (const l of links) {
    const mm = l.href.match(/^mailto:([^?]+)/i)
    if (mm) attendees.push({ name: looksLikeName(l.text) ? l.text : null, email: mm[1] })
  }
  for (const line of text.split('\n')) {
    const mm = line.match(/^\s*[•*-]?\s*(?:([^\n<]{2,60}?)\s*(?:<|\()?)?([\w.+-]+@[\w.-]+\.\w+)[>)]?\s*(?:-\s*(organizer|optional))?\s*$/i)
    if (mm) attendees.push({ name: mm[1] && looksLikeName(mm[1].trim()) ? mm[1].trim() : null, email: mm[2], ...(mm[3] === 'organizer' ? { role: 'host' } : {}) })
  }
  if (ics) {
    attendees.push(...ics.attendees)
    if (ics.organizer) attendees.push({ ...ics.organizer, role: 'host' })
  }
  let rsvpStatus = 'invited'
  if (/^(accepted|declined|tentatively accepted)$/.test(prefix)) {
    rsvpStatus = 'hosting'
    // the From header is the replier
    const fm = (email.from || '').match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>/) || (email.from || '').match(/([\w.+-]+@[\w.-]+\.\w+)/)
    if (fm) attendees.push({ name: fm[2] ? fm[1].trim() : null, email: fm[2] || fm[1], status: prefix === 'accepted' ? 'going' : prefix === 'declined' ? 'declined' : 'maybe' })
  } else if (/canceled|cancelled/.test(prefix)) rsvpStatus = 'cancelled'
  else if (ics && email.to) {
    const me = ics.attendees.find(a => a.email && a.email.toLowerCase() === String(email.to).toLowerCase())
    if (me?.status) rsvpStatus = me.status
  }
  const hostFromIcs = ics?.organizer?.name || [...organizers][0] || null
  const url = ics?.url || canonicalUrl('googleCalendar', links)
  const where = locationFromText(text)
  return {
    title: title || ics?.title || null, host: hostFromIcs, start: when?.start || null, end: when?.end || null, allDay: when?.allDay || false,
    location: where, url, attendees, goingCount: null, rsvpStatus,
    dedupeKey: ics?.uid ? `gcal:${ics.uid}` : null,
  }
}
