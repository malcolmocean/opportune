// Your own chats via opjack (client.opjack.com), a hosted bridge-first chat client: one
// account, one read token, every network it bridges (WhatsApp, Signal, Telegram, ...).
// Owner-only source for DESIGN patterns 20 (message elevation) and 21 (plan inference from chat).
// Replaces sources/matrix for anyone whose chats come through opjack: no /sync, no E2EE
// problem (opjack holds the Matrix session), just GET /v1/activity since a stored timestamp.
//
// Privacy: everything here stays on the owner's node. Observations are 'mention' rows on the
// owner, never revealed by any query plugin; message text is clipped to 500 chars; the only
// thing this source emits beyond observations is an opportunity addressed to the owner alone.
const DEFAULT_URL = 'https://client.opjack.com'
const MAX_TEXT = 500
const DM_MAX_PARTICIPANTS = 3        // you + them, plus the bridge puppet/bot opjack counts in
const FIRST_POLL_WINDOW_MS = 60 * 60e3   // no stored cursor yet: only look at the last hour
const PAGE = 200
const MAX_PAGES = 10                 // 2000 messages per poll, then pick up next time
const ELEVATION_TTL_MS = 45 * 60e3
const DM_TYPES = new Set(['dm', 'single'])
const NEVER_TYPES = new Set(['self', 'bridge-mgmt'])

export default {
  id: 'opjack',
  name: 'Chats (opjack)',
  description: 'Reads your own DMs from your opjack account (WhatsApp, Signal, Telegram… through one hosted bridge client). Finds plans people tell you about and elevates right-now coordination asks. Owner-only: nothing from here is ever shared with friends\' nodes.',
  repo: 'https://github.com/malcolmocean/opportune/tree/main/sources/opjack',
  kinds: ['mention'],
  intervalMin: 3,
  setup: [
    { key: 'url', type: 'url', label: `opjack server URL (default ${DEFAULT_URL}; blank = OPJACK_URL from the node's env, or the default)`, default: DEFAULT_URL, optional: true },
    { key: 'token', type: 'secret', label: 'Read-only opjack token: mint one at https://client.opjack.com/account with just the "read" scope (blank = OPJACK_TOKEN from the node\'s env, which is the node owner\'s own token)', optional: true },
    { key: 'networks', type: 'text', label: 'Networks to watch, comma-separated (whatsapp,signal,telegram…; optional, default all)', optional: true, parse: parseList },
  ],

  async poll(ctx, person, config, lastPollIso) {
    const L = ctx.log('opjack')
    const api = client(config, ctx.env)
    const K = { since: `opjack:${person.id}:since` }
    const networks = parseList(config.networks)?.map(s => s.toLowerCase()) || null

    const stored = ctx.db.kvGet(K.since)
    let since = stored || lastPollIso || new Date(Date.now() - FIRST_POLL_WINDOW_MS).toISOString()
    let newest = null
    const msgs = []
    let encrypted = 0
    const chatIds = new Set()
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await api.get('/v1/activity', { since, limit: PAGE })
      for (const group of r.chats || []) {
        const chat = group.chat || {}
        if (!isDm(chat, networks)) continue
        if (chat.isEncrypted) { encrypted += (group.messages || []).length; continue }
        const names = {}
        for (const p of chat.participants?.items || []) if (p?.id) names[p.id] = p.fullName || p.username || null
        for (const m of group.messages || []) {
          const text = textOf(m)
          if (!text) continue
          chatIds.add(chat.id)
          msgs.push({
            id: m.id, chatId: chat.id, chat: chat.title || chat.id, network: chat.network || null,
            sender: m.senderName || names[m.senderID] || m.senderID, senderId: m.senderID,
            isFromMe: !!m.isSender, at: m.timestamp, text,
          })
        }
      }
      if (r.newestTimestamp) newest = r.newestTimestamp
      if (!r.hasMore || !r.newestTimestamp || r.newestTimestamp === since) break
      since = r.newestTimestamp
    }

    if (encrypted) L.warn(`${person.display_name}: ${encrypted} message(s) in encrypted DM chats could not be read (opjack does no E2EE; see sources/opjack/README.md).`)

    const extracted = msgs.length && ctx.llm.enabled ? await extract(ctx, person, msgs).catch(e => { L.warn('extraction failed, storing plain mentions:', e.message); return {} }) : {}
    const out = []
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i], x = extracted[i] || {}
      const data = { text: m.text, provider: 'opjack', network: m.network, sender: m.sender, chat: m.chat, isFromMe: m.isFromMe }
      if (x.inferredPlace || x.inferredWindow) {
        // Whose plan is it? Top-level inferredPlace/inferredWindow mean "the owner will be there"
        // (that is how triggers like inTown read a mention), so a contact's plan goes under
        // contactPlan instead of being misattributed to the owner.
        const subject = x.subject || (m.isFromMe ? 'owner' : 'contact')
        if (subject === 'owner') { data.inferredPlace = x.inferredPlace || null; data.inferredWindow = x.inferredWindow || null }
        else data.contactPlan = { who: m.isFromMe ? m.chat : m.sender, place: x.inferredPlace || null, window: x.inferredWindow || null }
      }
      if (x.urgent && !m.isFromMe) {
        data.urgent = true
        data.summary = x.summary || null
        const short = m.text.length > 80 ? m.text.slice(0, 77) + '…' : m.text
        await ctx.opportunities.add('opjack', {
          kind: 'messageElevation', participants: [person.id], primary: person.id,
          summary: `${m.sender} just messaged (${m.network || 'chat'}): "${short}" — this looks like a right-now coordination ask.${x.summary ? ` ${x.summary}` : ''}`,
          evidence: [{ chat: m.chat, sender: m.sender, text: m.text, at: m.at, network: m.network }],
          dedupeKey: `elev:${m.id}`, expiresAt: new Date(Date.now() + ELEVATION_TTL_MS).toISOString(),
        })
      }
      out.push({ kind: 'mention', at: m.at, until: data.inferredWindow?.end || null, dedupeKey: m.id, data })
    }

    if (newest) ctx.db.kvSet(K.since, newest)
    else if (!stored) ctx.db.kvSet(K.since, since)   // nothing yet: remember where we started looking
    if (out.length) L.info(`${person.display_name}: ${out.length} message(s) from ${chatIds.size} chat(s)`)
    return out
  },
}

// One call for the whole batch: whereabouts/plan mentions, and right-now coordination asks.
async function extract(ctx, person, msgs) {
  const out = await ctx.llm.json({
    system: `You read a batch of the owner's recent chat messages (opjack: WhatsApp, Signal, Telegram and other bridged networks). The owner is ${person.display_name || 'the owner'}; messages with isFromMe are theirs.
For each message decide:
(a) Does it state where someone will be, or what they plan to do, with a place and/or a time? e.g. "I'll be in Oakland Saturday", "flying to NYC next week", "we're at Dolores now". Extract inferredPlace (short place name) and inferredWindow ({ "start": ISO or null, "end": ISO or null, "label": the phrase as said }), and subject: "owner" if it is the owner who will be there (their own message, or a contact talking about the owner's plan), "contact" if it is the other person's plan. Resolve relative days against nowIso in the owner's timezone.
(b) Is it a real-time coordination ask addressed to the owner that deserves immediate attention? Someone wanting to meet, drop in, call, or do something NOW or within the next few hours: "hey I'm near your place, can I drop in?", "anyone want to grab dinner now?", "you around? 10 min away". Only messages NOT from the owner can be urgent, and only when acting within the hour matters. Ordinary chat, questions that can wait, and plans for other days are not urgent.
Output: { "items": [{ "i": <message index>, "inferredPlace": string|null, "inferredWindow": object|null, "subject": "owner"|"contact"|null, "urgent": boolean, "summary": "one line, only when urgent: who wants what by when" }] }. Include only messages where you extracted something.`,
    messages: [{ role: 'user', content: JSON.stringify({ nowIso: new Date().toISOString(), tz: person.tz, messages: msgs.map((m, i) => ({ i, chat: m.chat, network: m.network, sender: m.sender, isFromMe: m.isFromMe, at: m.at, text: m.text })) }) }],
    maxTokens: 2048,
  }, { personId: person.id, process: 'source:opjack' })
  const by = {}
  for (const it of out?.items || []) if (Number.isInteger(it?.i) && msgs[it.i]) by[it.i] = it
  return by
}

// Plain text messages only; opjack already followed edits into the original row (same id) and
// marks redactions isDeleted. Images, voice notes, stickers and bridge notices are skipped.
function textOf(m) {
  if (!m || m.isDeleted || (m.type && m.type !== 'text') || typeof m.text !== 'string') return null
  const text = m.text.trim()
  if (!text || text === '(encrypted message)') return null
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text
}

// DM-ish: opjack's 'single' (or a plain 'dm'), or any chat with ≤3 participants (you, them,
// and the bridge puppet). Never the owner's self chat or a bridge management room.
function isDm(chat, networks) {
  if (!chat?.id || NEVER_TYPES.has(chat.type)) return false
  if (networks && !networks.includes(String(chat.network || '').toLowerCase())) return false
  if (DM_TYPES.has(chat.type)) return true
  const n = chat.participants?.total ?? chat.participants?.items?.length
  return n != null && n > 0 && n <= DM_MAX_PARTICIPANTS
}

function parseList(v) {
  if (!v) return null
  const list = (Array.isArray(v) ? v : String(v).split(',')).map(s => String(s).trim()).filter(Boolean)
  return list.length ? list : null
}

function client({ url, token } = {}, env = {}) {
  let base = String(url || env.OPJACK_URL || DEFAULT_URL).trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) base = 'https://' + base
  const bearer = String(token || '').trim() || String(env.OPJACK_TOKEN || '').trim()
  if (!bearer) throw Object.assign(new Error('opjack: no token (paste a read-only token from https://client.opjack.com/account, or set OPJACK_TOKEN)'), { code: 'bad_token' })
  return {
    async get(path, params = {}) {
      const u = new URL(base + path)
      for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v))
      const r = await fetch(u, { headers: { authorization: `Bearer ${bearer}` } })
      if (!r.ok) {
        let code = ''
        try { code = (await r.json()).code || '' } catch {}
        const msg = `opjack ${path} → ${r.status}${code ? ' ' + code : ''}`
        if (r.status === 401) throw Object.assign(new Error(`${msg} (token rejected; mint a new read-only token at ${base}/account and re-paste it)`), { code: 'bad_token', status: 401 })
        if (r.status === 403) throw Object.assign(new Error(`${msg} (token lacks the "read" scope)`), { code: 'bad_token', status: 403 })
        throw Object.assign(new Error(msg), { status: r.status })
      }
      return r.json()
    },
  }
}
