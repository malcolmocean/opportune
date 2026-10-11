import express from 'express'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TIER_DEFAULTS } from '../core/people.js'
import { isValidTz } from '../core/geo.js'

// Web surface: /app (web/app.js) is the whole UI: porchlight, nudges, people, sources, review, map, settings.
// /api/manage/* and /api/app/* are its JSON, authenticated by one token (a manage token or the app's own ingest token).

const here = dirname(fileURLToPath(import.meta.url))
const TIERS = ['acquaintance', 'friend', 'trusted']
const GRANT_KEYS = Object.keys(TIER_DEFAULTS.trusted)
const POLICY_KEYS = ['quietHours', 'maxNudgesPerDay', 'dropinDefault', 'dropinWindows', 'digestHour']
const LOCATION_WINDOW_MS = 3 * 3600e3
const isShadow = p => p?.onboarding?.step === 'shadow'

// Generate (or reuse) a manage token for a person.
// Stored twice in kv: manage:<token> → { personId, created } and manage:person:<id> → token.
export function manageToken(ctx, personId) {
  const person = ctx.people.get(personId)
  if (!person) throw new Error('no such person')
  let token = ctx.db.kvGet(`manage:person:${personId}`)
  if (!token || ctx.db.kvGet(`manage:${token}`)?.personId !== personId) {
    token = randomBytes(18).toString('base64url')
    ctx.db.kvSet(`manage:${token}`, { personId, created: new Date().toISOString() })
    ctx.db.kvSet(`manage:person:${personId}`, token)
  }
  return token
}
// The app, signed in: /app?token=<manage token>[#screen]. The app reads ?token= once and keeps it.
export const appUrl = (ctx, personId, hash = '') => `${ctx.people.nodeUrl}/app?token=${manageToken(ctx, personId)}${hash ? `#${hash}` : ''}`
// Legacy name and shape (links already sent out, cron hints): /web/manage?token= redirects to /app?token=.
export const manageUrl = (ctx, personId) => `${ctx.people.nodeUrl}/web/manage?token=${manageToken(ctx, personId)}`

// Resolve a token to a local, non-shadow person: a manage token, or the opportune app's own ingest token.
// Other sources' ingest tokens (OwnTracks, Overland, ...) sit in third-party apps and don't carry manage rights.
export function personForToken(ctx, token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null
  const sc = ctx.sources.byToken(token)
  const personId = ctx.db.kvGet(`manage:${token}`)?.personId || (sc?.source_id === 'opportuneApp' && sc.enabled ? sc.person_id : null)
  if (!personId) return null
  const p = ctx.people.get(personId)
  if (!p || p.remote || isShadow(p)) return null
  return p
}

export async function mountWeb(app, ctx) {
  const L = ctx.log('web')
  const page = name => (_req, res) => res.type('html').send(readFileSync(join(here, name), 'utf8'))
  app.get('/web/map', page('map.html'))
  app.get('/app', page('app.html'))   // the user-facing app (web/app.js); see docs/APP-BRIDGE.md
  // the old management page is folded into the app; old links (and #people/#review/#sources hashes, which browsers keep across a redirect) still land
  app.get('/web/manage', (req, res) => res.redirect(302, `/app${req.query.token ? `?token=${encodeURIComponent(String(req.query.token))}` : ''}`))

  const auth = (req, res, next) => {
    const token = req.get('x-manage-token') || req.query.token
    const me = personForToken(ctx, token)
    if (!me) return res.status(401).json({ error: 'bad or missing token' })
    req.me = me
    next()
  }
  const api = express.Router()
  api.use(express.json({ limit: '256kb' }))
  api.use(auth)

  const friendView = (me, f) => {
    const mine = { tier: f.tier, want_more: f.want_more, travel: f.travel, note: f.note, grants: f.grants || {}, via: f.via || {}, vouch: f.vouch }
    const theirs = ctx.people.rel(f.id, me.id)
    const shadow = isShadow(f)
    const out = {
      id: f.id, displayName: f.display_name, remote: !!f.remote, shadow, nodeUrl: f.node_url,
      rel: {
        tier: mine.tier, wantMore: !!mine.want_more, travel: mine.travel, note: mine.note || '',
        grants: mine.grants, effectiveGrants: { ...TIER_DEFAULTS[mine.tier], ...mine.grants },
        via: { tier: mine.via.tier || null, openToIntro: !!mine.via.openToIntro }, vouch: !!mine.vouch,
      },
      // their edge toward me: never includes their travel or note
      theirs: theirs ? { tier: theirs.tier, wantMore: !!theirs.want_more, effectiveGrants: theirs.effectiveGrants, vouch: !!theirs.vouch } : null,
      lastLocationAgeMin: null,
    }
    if (theirs?.effectiveGrants?.seeLocationLive) {
      const loc = ctx.observations.latest(f.id, 'location', { within: LOCATION_WINDOW_MS })
      if (loc) out.lastLocationAgeMin = ctx.geo.minutesAgo(loc.at)
    }
    return out
  }
  const manifestView = m => ({ id: m.id, name: m.name, description: m.description, kinds: m.kinds, repo: m.repo, hasIngest: !!m.ingest, hasPoll: !!m.poll,
    setup: (m.setup || []).map(s => ({ key: s.key, type: s.type, label: s.label, choices: s.choices, instructions: s.instructions })) })
  const decisionsFor = (id, limit = 50) => ctx.judge.reviewable(id, null, { limit })
    .map(d => ({ id: d.id, verdict: d.verdict, reasoning: d.reasoning, rating: d.rating, ratingNote: d.rating_note, ratedAt: d.rated_at, createdAt: d.created_at,
      nudgeId: d.nudge_id, opportunity: { summary: d.summary, kind: d.kind, trigger: d.trigger_id, expiresAt: d.expires_at } }))

  api.get('/me', (req, res) => {
    const me = req.me
    const connected = ctx.sources.forPerson(me.id).map(sc => {
      const m = ctx.plugins.sources[sc.source_id]
      return { id: sc.id, sourceId: sc.source_id, name: m?.name || sc.source_id, config: redact(sc.config, m), enabled: !!sc.enabled, lastPollAt: sc.last_poll_at, lastError: sc.last_error, ingestUrl: m?.ingest ? ctx.sources.ingestUrl(sc) : null }
    })
    const contacts = ctx.db.get('select count(*) c from contacts where owner_id = ?', me.id)?.c ?? 0
    res.json({
      person: { id: me.id, displayName: me.display_name, tz: me.tz, nodeUrl: me.node_url, contactsSynced: contacts },
      policy: ctx.people.policy(me.id),
      tierDefaults: TIER_DEFAULTS,
      friends: ctx.people.friendsOf(me.id).map(f => friendView(me, f)).sort(byName),
      sources: { connected, available: Object.values(ctx.plugins.sources).map(manifestView) },
      decisions: decisionsFor(me.id),
      nudges: ctx.nudges.recent(me.id, 30).map(n => ({ id: n.id, text: n.text, decisionId: n.decision_id, channel: n.channel, response: n.response, respondedAt: n.responded_at, createdAt: n.created_at })),
    })
  })

  api.patch('/friends/:id', (req, res) => {
    const me = req.me, fid = req.params.id
    const existing = ctx.people.rel(me.id, fid)
    if (!existing || !ctx.people.get(fid)) return res.status(404).json({ error: 'not a friend' })
    const b = req.body || {}, patch = {}
    if ('tier' in b) { if (!TIERS.includes(b.tier)) return res.status(400).json({ error: 'bad tier' }); patch.tier = b.tier }
    if ('wantMore' in b) patch.wantMore = !!b.wantMore
    if ('vouch' in b) patch.vouch = !!b.vouch
    if ('travel' in b) { const t = Number(b.travel); if (!Number.isInteger(t) || t < 0 || t > 3) return res.status(400).json({ error: 'travel is 0..3' }); patch.travel = t }
    if ('note' in b) { if (typeof b.note !== 'string' || b.note.length > 4000) return res.status(400).json({ error: 'bad note' }); patch.note = b.note }
    if ('grants' in b) {
      if (!b.grants || typeof b.grants !== 'object') return res.status(400).json({ error: 'grants must be an object' })
      const g = { ...(existing.grants || {}) }
      for (const [k, v] of Object.entries(b.grants)) {
        if (!GRANT_KEYS.includes(k)) return res.status(400).json({ error: `unknown grant ${k}` })
        if (v === null) delete g[k]; else g[k] = !!v      // null = back to the tier default
      }
      patch.grants = g
    }
    if ('via' in b) {
      if (!b.via || typeof b.via !== 'object') return res.status(400).json({ error: 'via must be an object' })
      const v = { ...(existing.via || {}) }
      if ('tier' in b.via) { if (b.via.tier != null && !['acquaintance', 'friend'].includes(b.via.tier)) return res.status(400).json({ error: 'via.tier is acquaintance|friend' }); if (b.via.tier == null) delete v.tier; else v.tier = b.via.tier }
      if ('openToIntro' in b.via) v.openToIntro = !!b.via.openToIntro
      patch.via = v
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change' })
    ctx.people.setRel(me.id, fid, patch)
    const f = ctx.people.friendsOf(me.id).find(x => x.id === fid)
    res.json({ friend: friendView(me, f) })
  })

  api.post('/friends/:id/invite-link', (req, res) => {
    const me = req.me, fid = req.params.id
    const rel = ctx.people.rel(me.id, fid), f = ctx.people.get(fid)
    if (!rel || !f) return res.status(404).json({ error: 'not a friend' })
    const inv = ctx.people.invite(me.id, { inviteeName: f.display_name, wantMore: !!rel.want_more, tier: rel.tier })
    res.json(inv)
  })

  api.post('/decisions/:id/rate', (req, res) => {
    const { rating, note } = req.body || {}
    if (!['good', 'bad'].includes(rating)) return res.status(400).json({ error: 'rating is good|bad' })
    const d = ctx.db.get('select id from decisions where id = ? and person_id = ?', req.params.id, req.me.id)
    if (!d) return res.status(404).json({ error: 'no such decision' })
    ctx.judge.rate(d.id, rating, typeof note === 'string' ? note.slice(0, 1000) : undefined)
    res.json({ decision: decisionsFor(req.me.id, 500).find(x => x.id === d.id) })
  })

  api.patch('/policy', (req, res) => {
    const b = req.body || {}, patch = {}
    const hour = h => Number.isInteger(h) && h >= 0 && h <= 23
    for (const k of Object.keys(b)) if (!POLICY_KEYS.includes(k)) return res.status(400).json({ error: `unknown policy key ${k}` })
    if ('quietHours' in b) {
      if (b.quietHours === null) patch.quietHours = { start: null, end: null }
      else if (!b.quietHours || !hour(b.quietHours.start) || !hour(b.quietHours.end)) return res.status(400).json({ error: 'quietHours needs start/end 0..23' })
      else patch.quietHours = { start: b.quietHours.start, end: b.quietHours.end }
    }
    if ('maxNudgesPerDay' in b) { const n = Number(b.maxNudgesPerDay); if (!Number.isInteger(n) || n < 0 || n > 50) return res.status(400).json({ error: 'maxNudgesPerDay 0..50' }); patch.maxNudgesPerDay = n }
    if ('dropinDefault' in b) { if (!['open', 'closed', 'ask'].includes(b.dropinDefault)) return res.status(400).json({ error: 'dropinDefault open|closed|ask' }); patch.dropinDefault = b.dropinDefault }
    if ('digestHour' in b) { if (!hour(b.digestHour)) return res.status(400).json({ error: 'digestHour 0..23' }); patch.digestHour = b.digestHour }
    if ('dropinWindows' in b) {
      if (!Array.isArray(b.dropinWindows) || b.dropinWindows.length > 14) return res.status(400).json({ error: 'dropinWindows must be an array' })
      const ws = []
      for (const w of b.dropinWindows) {
        const days = [...new Set((w?.days || []).map(Number))].filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort()
        if (!days.length || !hour(w.start) || !hour(w.end)) return res.status(400).json({ error: 'each window needs days[], start, end' })
        ws.push({ days, start: w.start, end: w.end })
      }
      patch.dropinWindows = ws
    }
    const merged = { ...ctx.people.policy(req.me.id), ...patch }
    ctx.people.update(req.me.id, { policy: merged })
    res.json({ policy: ctx.people.policy(req.me.id) })
  })

  api.post('/sources', (req, res) => {
    const { sourceId, config } = req.body || {}
    const m = ctx.plugins.sources[sourceId]
    if (!m) return res.status(404).json({ error: 'unknown source' })
    if (config != null && typeof config !== 'object') return res.status(400).json({ error: 'config must be an object' })
    // "Change settings" on a connected source resubmits the form; the API never echoes secrets, so a blank secret means keep the one we have
    const existing = ctx.sources.forPerson(req.me.id).find(s => s.source_id === sourceId)
    const cfg = {}
    for (const step of m.setup || []) {
      let v = config?.[step.key]
      if (v == null || v === '') { if (step.type === 'secret' && existing?.config?.[step.key] != null) cfg[step.key] = existing.config[step.key]; continue }
      if (step.type === 'choice' && !step.choices?.includes(v)) return res.status(400).json({ error: `${step.key}: pick one of ${step.choices.join(', ')}` })
      if (step.parse && typeof v === 'string') { try { v = step.parse(v) } catch (e) { return res.status(400).json({ error: `${step.key}: ${e.message}` }) } }
      cfg[step.key] = v
    }
    const sc = ctx.sources.connect(req.me.id, sourceId, cfg)
    L.info(`${req.me.display_name} connected ${sourceId} via web`)
    res.json({ id: sc.id, sourceId, config: redact(sc.config, m), ingestUrl: m.ingest ? ctx.sources.ingestUrl(sc) : null })
  })

  api.get('/map', (req, res) => {
    const me = req.me
    const loc = p => {
      const o = ctx.observations.latest(p.id, 'location', { within: LOCATION_WINDOW_MS })
      return o ? { lat: o.data.lat, lng: o.data.lng, acc: o.data.acc ?? null, placeName: o.data.placeName || null, at: o.at, ageMin: ctx.geo.minutesAgo(o.at) } : null
    }
    const friends = []
    for (const f of ctx.people.friendsOf(me.id)) {
      const theirs = ctx.people.rel(f.id, me.id)
      if (!theirs?.effectiveGrants?.seeLocationLive) continue
      const l = loc(f)
      if (l) friends.push({ id: f.id, displayName: f.display_name, tier: theirs.tier, ...l })
    }
    res.json({ me: { id: me.id, displayName: me.display_name, location: loc(me) }, friends: friends.sort(byName), windowHours: LOCATION_WINDOW_MS / 3600e3 })
  })

  const onError = (err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad json' })
    L.error(err)
    res.status(err.status || 500).json({ error: err.message || 'error' })
  }
  api.use(onError)
  app.use('/api/manage', api)

  // ---- /api/app/*: what web/app.js needs beyond /api/app/state (server.js) and the ingest URL. Same token auth. ----
  const appApi = express.Router()
  appApi.use(express.json({ limit: '64kb' }))
  appApi.use(auth)

  // Everything the app needs to start a session: its ingest URL (the credential it POSTs status/home/nudge
  // responses to), whether Telegram/push are bound, and a Telegram deep link if not. A person who arrived with
  // a manage token (Telegram-first) gets an opportuneApp source connected here so the app has somewhere to post.
  appApi.post('/session', (req, res) => {
    const me = req.me
    const tz = req.body?.tz
    if (isValidTz(tz) && tz !== me.tz) { ctx.people.update(me.id, { tz }); me.tz = tz; L.info(`${me.display_name} is now in ${tz}`) }
    const mine = () => ctx.sources.forPerson(me.id)
    let sc = mine().find(s => s.source_id === 'opportuneApp' && s.enabled)
    if (!sc) { sc = ctx.sources.connect(me.id, 'opportuneApp', { device: req.body?.device || {} }); L.info(`${me.display_name} connected the app via /app`) }
    const identities = ctx.people.identities(me.id)
    const telegramLinked = identities.some(i => i.channel === 'telegram')
    const loc = mine().find(s => s.source_id === 'locationPost' && s.enabled)
    res.json({
      me: { id: me.id, displayName: me.display_name, tz: me.tz, nodeUrl: me.node_url || ctx.people.nodeUrl, onboarding: me.onboarding?.step || null,
        email: identities.find(i => i.channel === 'email')?.external_id || null },
      ingestUrl: ctx.sources.ingestUrl(sc),
      manageUrl: appUrl(ctx, me.id),
      declinedSources: declined(me.id),
      telegramLinked,
      telegramLink: telegramLinked ? null : ctx.plugins.channels.telegram?.deepLink?.(ctx, `link-${sc.token}`) || null,
      pushBound: identities.some(i => i.channel === 'fcm'),
      locationPostUrl: loc ? ctx.sources.ingestUrl(loc) : null,
      contactsSynced: ctx.db.get('select count(*) c from contacts where owner_id = ?', me.id)?.c ?? 0,
    })
  })

  // "Heading over": ask the friend's agent the dropin question on my behalf and relay the structured answer.
  // The dropin query itself enforces their askDropin grant, rate limits, and the veto nudge in the 'ask' state.
  appApi.post('/friends/:id/dropin', async (req, res) => {
    const me = req.me, f = ctx.people.get(req.params.id)
    if (!f || isShadow(f) || !ctx.people.rel(f.id, me.id)) return res.status(404).json({ error: 'not a friend' })
    const text = typeof req.body?.text === 'string' && req.body.text.trim() ? req.body.text.trim().slice(0, 200) : 'heading over now'
    const ans = await ctx.query.ask({ from: me.id, to: f.id, kind: 'dropin', text })
    L.info(`${me.display_name} → ${f.display_name} dropin: ${ans.answer}`)
    res.json({ friend: { id: f.id, name: f.display_name }, answer: ans.answer, reason: ans.reason || null, text: ans.text || null, confidence: ans.confidence ?? null, revealed: ans.revealed || {} })
  })

  // Sources the person has said "not for me" to: hidden on the Sources screen and out of the progress denominator. kv, not a column.
  appApi.patch('/me', (req, res) => {
    const b = req.body || {}
    if (!('declinedSources' in b)) return res.status(400).json({ error: 'nothing to change' })
    if (!Array.isArray(b.declinedSources) || b.declinedSources.some(x => typeof x !== 'string')) return res.status(400).json({ error: 'declinedSources must be an array of source ids' })
    const ids = [...new Set(b.declinedSources.filter(x => ctx.plugins.sources[x]))]
    ctx.db.kvSet(`declined:${req.me.id}`, ids)
    res.json({ declinedSources: ids })
  })

  // "+ invite a friend" in the app: a one-time link that says I want to see more of them. Same as Telegram's /invite.
  appApi.post('/invites', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/[^\w\s'.-]/g, '').slice(0, 40) : ''
    if (!name) return res.status(400).json({ error: 'a name, so the link can say who it\'s for' })
    const wantMore = req.body?.wantMore == null ? true : !!req.body.wantMore
    const inv = ctx.people.invite(req.me.id, { inviteeName: name, wantMore })
    L.info(`${req.me.display_name} made an invite link for ${name} via /app`)
    res.json({ name, wantMore, ...inv })
  })

  appApi.use(onError)
  app.use('/api/app', appApi)
  L.info('app at /app')

  function declined(personId) { const v = ctx.db.kvGet(`declined:${personId}`); return Array.isArray(v) ? v : [] }
}

const byName = (a, b) => (a.displayName || '').localeCompare(b.displayName || '')
// Hide secret setup values when echoing config back to the browser.
function redact(config, manifest) {
  const out = { ...(config || {}) }
  for (const s of manifest?.setup || []) if (s.type === 'secret' && out[s.key]) out[s.key] = '••••••'
  return out
}
