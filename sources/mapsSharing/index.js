// Google Maps location sharing, read through the owner's own Google account (locationsharinglib).
// The N=1 win: friends who already share Maps location with you need to install nothing.
//
// Twist: the observations this source produces are mostly about OTHER people (the contacts),
// not the owner. poll() ingests each contact's location directly under that contact's person
// id (matching an existing friend by name, or creating a "shadow" person), and returns only
// the owner's own location, which core ingests for the owner as usual.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const DIR = dirname(fileURLToPath(import.meta.url))
export const SOURCE_ID = 'mapsSharing'
// locationsharinglib refuses a cookie jar without one of these; Google needs the rest of the google.com set too.
export const REQUIRED_COOKIES = ['__Secure-1PSID', '__Secure-3PSID']

export default {
  id: SOURCE_ID,
  name: 'Google Maps location sharing',
  description: 'Friends who already share their Google Maps location with you show up here with live location. Nothing for them to install. Polled every 5 minutes from your own Google account.',
  repo: 'https://github.com/malcolmocean/opportune/tree/main/sources/mapsSharing',
  kinds: ['location'],
  intervalMin: 5,
  setup: [
    { key: 'email', type: 'text', label: 'Which Google account do your friends share their Maps location with? (the Gmail address)', parse: v => v.trim().toLowerCase() },
    {
      key: 'cookies', type: 'secret',
      label: 'Now the cookies that account is logged in with. In a desktop browser where you are logged into that Google account, open google.com, use a cookies.txt exporter extension (e.g. "Get cookies.txt LOCALLY") to export cookies for google.com in Netscape format, open the file, and paste its contents here. It must contain __Secure-1PSID and __Secure-3PSID. Paste only the google.com lines if the file is long.',
      parse: normalizeCookies,
    },
  ],
  fetch: fetchShared,   // swappable in tests

  init(ctx) {
    const L = ctx.log(SOURCE_ID)
    const py = pythonBin(ctx.env)
    L.info(`python: ${py}${py === 'python3' ? ' (no .venv found; run sources/mapsSharing/setup.sh if polls fail with missing_dependency)' : ''}`)
  },

  async poll(ctx, owner, config) {
    validateCookies(config.cookies)
    const L = ctx.log(SOURCE_ID)
    const data = await (this?.fetch || fetchShared)(config, { python: pythonBin(ctx.env) })
    const r = await ingestContacts(ctx, owner, data.contacts || [])
    if (r.created.length) L.info(`new shadow people for ${owner.display_name}: ${r.created.join(', ')}`)
    L.debug(`${owner.display_name}: ${data.contacts?.length || 0} contacts, ${r.ingested} new, ${r.skipped} unchanged`)
    return ownerObservations(ctx, owner, data.me)
  },
}

// ---------- cookies ----------

// Keep only google.com cookie lines, un-comment `#HttpOnly_` prefixed lines (the lib would skip them), normalize newlines.
export function normalizeCookies(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => l.replace(/^#HttpOnly_/, ''))
    .filter(l => !l.startsWith('#'))
    .filter(l => /(^|\.)google\.com$/.test(l.split(/\s+/)[0]))
  return lines.join('\n') + (lines.length ? '\n' : '')
}

export function validateCookies(text) {
  const names = new Set(String(text || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.split(/\s+/)[5]).filter(Boolean))
  if (!REQUIRED_COOKIES.some(n => names.has(n))) {
    throw Object.assign(new Error(`cookies must include one of ${REQUIRED_COOKIES.join(', ')} for google.com (export while logged in, Netscape format)`), { code: 'invalid_cookies' })
  }
  return [...names]
}

// ---------- python bridge ----------

export function pythonBin(env = process.env) {
  if (env?.MAPS_SHARING_PYTHON) return env.MAPS_SHARING_PYTHON
  const venv = join(DIR, '.venv', 'bin', 'python')
  return existsSync(venv) ? venv : 'python3'
}

// Writes the cookies to a 0600 temp file, runs fetch.py, parses its JSON, always deletes the file.
export async function fetchShared(config, { python = pythonBin(), script = join(DIR, 'fetch.py'), timeoutMs = 60e3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opportune-maps-'))
  const file = join(dir, 'cookies.txt')
  try {
    const text = String(config.cookies || '')
    writeFileSync(file, text.endsWith('\n') ? text : text + '\n', { mode: 0o600 })
    let stdout
    try {
      ({ stdout } = await run(python, [script, '--cookies', file, '--email', config.email || 'unknown@gmail.com'], { timeout: timeoutMs, maxBuffer: 16e6 }))
    } catch (e) {
      const parsed = tryJson(e.stdout)
      if (parsed?.error) throw Object.assign(new Error(`${parsed.error}: ${parsed.message}`), { code: parsed.error })
      if (e.code === 'ENOENT') throw Object.assign(new Error(`python not found at "${python}"; run sources/mapsSharing/setup.sh or set MAPS_SHARING_PYTHON`), { code: 'no_python' })
      throw Object.assign(new Error(`fetch.py failed (${e.code ?? e.signal}): ${String(e.stderr || e.message || '').trim().slice(-400)}`), { code: 'fetch_failed' })
    }
    const out = tryJson(stdout)
    if (!out || typeof out !== 'object') throw Object.assign(new Error('fetch.py returned non-JSON output'), { code: 'fetch_failed' })
    if (out.error) throw Object.assign(new Error(`${out.error}: ${out.message}`), { code: out.error })
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const tryJson = s => { try { return JSON.parse(String(s || '').trim()) } catch { return null } }

// ---------- contacts → people → observations ----------

// For each contact: resolve to a person, skip if we already have this fix, ingest under their id.
export async function ingestContacts(ctx, owner, contacts = []) {
  const summary = { ingested: 0, skipped: 0, created: [], matched: [] }
  for (const c of contacts) {
    if (c?.lat == null || c?.lng == null) { summary.skipped++; continue }
    const { person, created } = resolveContact(ctx, owner, c)
    if (created) summary.created.push(person.display_name)
    else summary.matched.push(person.display_name)
    const obs = toObservation(ctx, owner, person, c)
    const last = ctx.observations.latest(person.id, 'location')
    if (last && last.at === obs.at) { summary.skipped++; continue }
    const rows = await ctx.observations.ingest(person.id, SOURCE_ID, [obs])
    if (rows.length) summary.ingested++
    else summary.skipped++
  }
  return summary
}

// Existing friend whose display name matches the contact's full name (case-insensitive), else a shadow person.
// Remembers google id → person id in kv so renames on either side don't mint duplicates.
export function resolveContact(ctx, owner, contact) {
  const key = contact.id ? `${SOURCE_ID}:${owner.id}:${contact.id}` : null
  if (key) {
    const knownId = ctx.db.kvGet(key)
    const known = knownId && ctx.people.get(knownId)
    if (known) return { person: known, created: false }
  }
  const friends = ctx.people.friendsOf(owner.id)
  let person = friends.find(f => sameName(f.display_name, contact.fullName))
    || friends.find(f => contact.nickname && sameName(f.display_name, contact.nickname))
  let created = false
  if (!person) {
    const displayName = (contact.fullName || contact.nickname || '').trim() || `Maps contact ${String(contact.id || '').slice(-6) || '?'}`
    person = ctx.people.create({ displayName, tz: owner.tz })
    ctx.people.update(person.id, { onboarding: { step: 'shadow', via: SOURCE_ID, ownerId: owner.id, googleId: contact.id || null, pictureUrl: contact.pictureUrl || null } })
    ctx.people.setRel(owner.id, person.id, { tier: 'friend', wantMore: false, note: 'shares Google Maps location with you' })
    created = true
  }
  if (key) ctx.db.kvSet(key, person.id)
  return { person, created }
}

const sameName = (a, b) => !!a && !!b && norm(a) === norm(b)
const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, ' ')

// One location observation; placeName comes from the person's own places or the owner's (prefixed with the owner's name).
export function toObservation(ctx, owner, person, c) {
  const at = c.at || (c.timestamp != null ? new Date(Number(c.timestamp)).toISOString() : new Date().toISOString())
  const near = nearestPlace(ctx, owner, person, c)
  return {
    kind: 'location', at,
    dedupeKey: `loc@${c.timestamp ?? at}`,
    data: {
      lat: c.lat, lng: c.lng, acc: c.acc ?? null, speed: null,
      placeId: near?.id || null, placeName: near?.name || null,
      address: c.address || null, battery: c.battery ?? null, charging: c.charging ?? null,
    },
  }
}

function nearestPlace(ctx, owner, person, pt) {
  const seen = new Set()
  const candidates = []
  for (const pl of ctx.people.places(person.id)) if (!seen.has(pl.id)) { seen.add(pl.id); candidates.push(pl) }
  if (owner.id !== person.id) for (const pl of ctx.people.places(owner.id)) if (!seen.has(pl.id)) { seen.add(pl.id); candidates.push(pl) }
  let best = null, bestD = Infinity
  for (const pl of candidates) {
    const d = ctx.geo.distanceM(pt, pl)
    if (d <= (pl.radius_m || 150) && d < bestD) { best = pl; bestD = d }
  }
  if (!best) return null
  const mine = best.owner_id === person.id || !best.owner_id
  return { id: best.id, name: mine ? best.name : `${ctx.people.get(best.owner_id)?.display_name || 'their friend'}'s ${best.name}` }
}

// The owner's own fix from get_authenticated_person(), returned so core ingests it for the owner. Deduped on `at`.
function ownerObservations(ctx, owner, me) {
  if (!me || me.lat == null || me.lng == null) return []
  const obs = toObservation(ctx, owner, owner, me)
  const last = ctx.observations.latest(owner.id, 'location')
  if (last && last.at === obs.at) return []
  return [obs]
}
