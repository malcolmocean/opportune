// Your own chats via Matrix (Beeper bridges WhatsApp, iMessage, Signal, Telegram, ...).
// Owner-only source for DESIGN patterns 20 (message elevation) and 21 (plan inference from chat).
// Talks to the client-server REST API with fetch; no SDK. Incremental /sync with a stored
// next_batch token, a tight filter, and set_presence=offline so polling never shows you online.
//
// Privacy: everything here stays on the owner's node. Observations are 'mention' rows on the
// owner, never revealed by any query plugin; message text is clipped to 500 chars; the only
// thing this source emits beyond observations is an opportunity addressed to the owner alone.
const API = '/_matrix/client/v3'
const MAX_TEXT = 500
const DM_MAX_MEMBERS = 3            // you + them, plus a bridge bot on Beeper
const FIRST_SYNC_WINDOW_MS = 60 * 60e3   // no stored token yet: only look at the last hour
const ELEVATION_TTL_MS = 45 * 60e3
const FILTER = {
  presence: { types: [] },
  account_data: { types: [] },
  room: {
    timeline: { types: ['m.room.message', 'm.room.encrypted', 'm.room.member', 'm.room.name'], limit: 50 },
    state: { types: ['m.room.member', 'm.room.name'], lazy_load_members: true },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
}

export default {
  id: 'matrix',
  name: 'Chats (Matrix / Beeper)',
  description: 'Reads your own DMs from a Matrix account (Beeper bridges WhatsApp, iMessage, Signal, Telegram…). Finds plans people tell you about and elevates right-now coordination asks. Owner-only: nothing from here is ever shared with friends\' nodes.',
  repo: 'https://github.com/malcolmocean/opportune/tree/main/sources/matrix',
  kinds: ['mention'],
  intervalMin: 5,
  setup: [
    { key: 'homeserver', type: 'url', label: 'Homeserver URL (Beeper: https://matrix.beeper.com)' },
    { key: 'accessToken', type: 'secret', label: 'Access token (how to get one: sources/matrix/README.md)' },
    { key: 'rooms', type: 'text', label: 'Room ids to watch, comma-separated (optional; default: every DM-sized room, ≤3 members)', optional: true, parse: parseRooms },
  ],

  async poll(ctx, person, config) {
    const L = ctx.log('matrix')
    const api = client(config)
    const K = { since: `matrix:${person.id}:since`, me: `matrix:${person.id}:userId`, rooms: `matrix:${person.id}:rooms` }

    let me = ctx.db.kvGet(K.me)
    if (!me) { me = (await api.get('/account/whoami')).user_id; ctx.db.kvSet(K.me, me) }
    const since = ctx.db.kvGet(K.since) || null
    const sync = await api.get('/sync', { filter: JSON.stringify(FILTER), timeout: 0, set_presence: 'offline', since })

    const cache = ctx.db.kvGet(K.rooms) || {}       // roomId → { members, name, heroes, names: { mxid: displayname } }
    const only = parseRooms(config.rooms)
    const cutoff = since ? 0 : Date.now() - FIRST_SYNC_WINDOW_MS
    const msgs = []
    let encrypted = 0
    for (const [roomId, room] of Object.entries(sync.rooms?.join || {})) {
      const c = cache[roomId] = cache[roomId] || { members: null, name: null, heroes: null, names: {} }
      const s = room.summary || {}
      if (s['m.joined_member_count'] != null) c.members = s['m.joined_member_count'] + (s['m.invited_member_count'] || 0)
      if (s['m.heroes']) c.heroes = s['m.heroes']
      for (const ev of [...(room.state?.events || []), ...(room.timeline?.events || [])]) {
        if (ev.type === 'm.room.member' && ev.content?.displayname) c.names[ev.state_key] = ev.content.displayname
        if (ev.type === 'm.room.name' && ev.content?.name) c.name = ev.content.name
      }
      const texts = (room.timeline?.events || []).filter(ev => ev.type === 'm.room.message')
      const enc = (room.timeline?.events || []).filter(ev => ev.type === 'm.room.encrypted' && ev.origin_server_ts >= cutoff).length
      if (!texts.length && !enc) continue
      if (only ? !only.includes(roomId) : !(await isDm(api, roomId, c))) continue
      encrypted += enc
      if (room.timeline?.limited && since) L.warn(`${label(c, roomId, me)}: timeline gap, some messages between polls were skipped`)
      for (const ev of texts) {
        const m = textOf(ev)
        if (!m || ev.origin_server_ts < cutoff) continue
        msgs.push({
          eventId: m.eventId, roomId, room: label(c, roomId, me), sender: c.names[ev.sender] || ev.sender, senderId: ev.sender,
          isFromMe: ev.sender === me, at: new Date(ev.origin_server_ts).toISOString(), text: m.text,
        })
      }
    }

    if (encrypted) L.warn(`${person.display_name}: ${encrypted} encrypted message(s) in DM rooms could not be read. This source has no E2EE; point the homeserver URL at a pantalaimon proxy (see sources/matrix/README.md).`)

    const extracted = msgs.length && ctx.llm.enabled ? await extract(ctx, person, me, msgs).catch(e => { L.warn('extraction failed, storing plain mentions:', e.message); return {} }) : {}
    const out = []
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i], x = extracted[i] || {}
      const data = { text: m.text, provider: 'matrix', sender: m.sender, room: m.room, isFromMe: m.isFromMe }
      if (x.inferredPlace || x.inferredWindow) {
        // Whose plan is it? Top-level inferredPlace/inferredWindow mean "the owner will be there"
        // (that is how triggers like inTown read a mention), so a contact's plan goes under
        // contactPlan instead of being misattributed to the owner.
        const subject = x.subject || (m.isFromMe ? 'owner' : 'contact')
        if (subject === 'owner') { data.inferredPlace = x.inferredPlace || null; data.inferredWindow = x.inferredWindow || null }
        else data.contactPlan = { who: m.isFromMe ? m.room : m.sender, place: x.inferredPlace || null, window: x.inferredWindow || null }
      }
      if (x.urgent && !m.isFromMe) {
        data.urgent = true
        data.summary = x.summary || null
        const short = m.text.length > 80 ? m.text.slice(0, 77) + '…' : m.text
        await ctx.opportunities.add('matrix', {
          kind: 'messageElevation', participants: [person.id], primary: person.id,
          summary: `${m.sender} just messaged: "${short}" — this looks like a right-now coordination ask.${x.summary ? ` ${x.summary}` : ''}`,
          evidence: [{ room: m.room, sender: m.sender, text: m.text, at: m.at }],
          dedupeKey: `elev:${m.eventId}`, expiresAt: new Date(Date.now() + ELEVATION_TTL_MS).toISOString(),
        })
      }
      out.push({ kind: 'mention', at: m.at, until: data.inferredWindow?.end || null, dedupeKey: m.eventId, data })
    }

    if (sync.next_batch) ctx.db.kvSet(K.since, sync.next_batch)
    ctx.db.kvSet(K.rooms, cache)
    if (out.length) L.info(`${person.display_name}: ${out.length} message(s) from ${new Set(msgs.map(m => m.roomId)).size} room(s)`)
    return out
  },
}

// One call for the whole batch: whereabouts/plan mentions, and right-now coordination asks.
async function extract(ctx, person, me, msgs) {
  const out = await ctx.llm.json({
    system: `You read a batch of the owner's recent chat messages (Matrix/Beeper bridges). The owner is ${person.display_name || 'the owner'} (${me}); messages with isFromMe are theirs.
For each message decide:
(a) Does it state where someone will be, or what they plan to do, with a place and/or a time? e.g. "I'll be in Oakland Saturday", "flying to NYC next week", "we're at Dolores now". Extract inferredPlace (short place name) and inferredWindow ({ "start": ISO or null, "end": ISO or null, "label": the phrase as said }), and subject: "owner" if it is the owner who will be there (their own message, or a contact talking about the owner's plan), "contact" if it is the other person's plan. Resolve relative days against nowIso in the owner's timezone.
(b) Is it a real-time coordination ask addressed to the owner that deserves immediate attention? Someone wanting to meet, drop in, call, or do something NOW or within the next few hours: "hey I'm near your place, can I drop in?", "anyone want to grab dinner now?", "you around? 10 min away". Only messages NOT from the owner can be urgent, and only when acting within the hour matters. Ordinary chat, questions that can wait, and plans for other days are not urgent.
Output: { "items": [{ "i": <message index>, "inferredPlace": string|null, "inferredWindow": object|null, "subject": "owner"|"contact"|null, "urgent": boolean, "summary": "one line, only when urgent: who wants what by when" }] }. Include only messages where you extracted something.`,
    messages: [{ role: 'user', content: JSON.stringify({ nowIso: new Date().toISOString(), tz: person.tz, messages: msgs.map((m, i) => ({ i, room: m.room, sender: m.sender, isFromMe: m.isFromMe, at: m.at, text: m.text })) }) }],
    maxTokens: 2048,
  }, { personId: person.id, process: 'source:matrix' })
  const by = {}
  for (const it of out?.items || []) if (Number.isInteger(it?.i) && msgs[it.i]) by[it.i] = it
  return by
}

// m.text messages, following edits (m.replace) back to the original event so the
// observation updates in place instead of duplicating.
function textOf(ev) {
  const c = ev.content || {}
  const rel = c['m.relates_to']
  const edit = rel?.rel_type === 'm.replace' && rel.event_id && c['m.new_content']
  const body = edit ? c['m.new_content'] : c
  if (body.msgtype !== 'm.text' || typeof body.body !== 'string') return null
  const text = body.body.trim()
  if (!text) return null
  return { eventId: edit ? rel.event_id : ev.event_id, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text }
}

// Member count comes from the room summary (only sent when it changes); fall back to one
// /joined_members call per room we have never counted.
async function isDm(api, roomId, c) {
  if (c.members == null) {
    const r = await api.get(`/rooms/${encodeURIComponent(roomId)}/joined_members`)
    c.members = Object.keys(r.joined || {}).length
    for (const [id, m] of Object.entries(r.joined || {})) if (m?.display_name) c.names[id] = m.display_name
  }
  return c.members > 0 && c.members <= DM_MAX_MEMBERS
}

const label = (c, roomId, me) => c.name || (c.heroes || []).filter(h => h !== me).map(h => c.names[h] || h).join(', ') || roomId

function parseRooms(v) {
  if (!v) return null
  const list = (Array.isArray(v) ? v : String(v).split(',')).map(s => String(s).trim()).filter(Boolean)
  return list.length ? list : null
}

function client({ homeserver, accessToken }) {
  let base = String(homeserver || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('matrix: homeserver URL missing')
  if (!/^https?:\/\//.test(base)) base = 'https://' + base
  if (!accessToken) throw new Error('matrix: access token missing')
  return {
    async get(path, params = {}) {
      const u = new URL(base + API + path)
      for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v))
      const r = await fetch(u, { headers: { authorization: `Bearer ${accessToken}` } })
      if (!r.ok) {
        let code = ''
        try { code = (await r.json()).errcode || '' } catch {}
        throw new Error(`matrix ${path} → ${r.status}${code ? ' ' + code : ''}${r.status === 401 ? ' (access token rejected; log in again and re-paste it)' : ''}`)
      }
      return r.json()
    },
  }
}
