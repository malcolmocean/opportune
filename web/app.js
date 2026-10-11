// The opportune app. One page: onboarding → home (my porchlight + friends' porchlights) → nudges,
// with People/Review embedded from the manage page, the map from map.js, and settings.
// Works in any browser; inside the Android shell it uses window.opportuneNative (web/app/bridge.js).
import { fetchMap, mountMap } from '/web/map.js'
import { lanternEl } from '/web/app/lantern.js'
import { isNative, bridge, currentLocation, browserPermissions, onPermissions, onResume, onNudge } from '/web/app/bridge.js'

// ---------- tiny helpers ----------
const $ = (sel, root = document) => root.querySelector(sel)
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'html') el.innerHTML = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k))
  return el
}
const ls = {
  get: k => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch {} },
}
const KEY = 'opportune.token'
let toastT
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true }, 2200) }
const fail = e => toast(e?.message || 'something went wrong')
const fmtMin = m => (m == null ? '' : m < 1 ? 'less than a minute' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`)
const when = iso => {
  const d = new Date(iso), diff = (Date.now() - d) / 60e3
  if (diff < 1) return 'just now'
  if (diff < 60) return `${Math.round(diff)}m ago`
  if (diff < 24 * 60) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

// ---------- state ----------
let token = null       // the one credential: a source token (tail of ingestUrl) or a manage token
let session = null     // POST /api/app/session
let state = null       // GET /api/app/state
let perms = null       // native permissions, or the browser's best guess
let extraNudges = []   // pushed in by the shell while open (onNativeNudge), until the next refresh has them
let mapHandle = null, frame = null, refreshT = null

async function req(url, { method = 'GET', body, auth = true } = {}) {
  const r = await fetch(url, { method, headers: { ...(auth && token ? { 'x-manage-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText || `http ${r.status}`), { status: r.status })
  return data
}
// POST to my ingest URL (same shapes the Android shell posts). Relative, so dev nodes with a different NODE_URL still work.
const ingest = body => req(new URL(session.ingestUrl, location.href).pathname, { method: 'POST', body, auth: false })

// ---------- theme ----------
const themePref = () => ls.get('opportune.theme') || 'system'
const isDark = () => themePref() === 'dark' || (themePref() !== 'light' && !matchMedia('(prefers-color-scheme: light)').matches)
function applyTheme() {
  const p = themePref()
  if (p === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = p
  $('meta[name=theme-color]')?.setAttribute('content', isDark() ? '#090b22' : '#f6f5ff')
  if (frame?.contentDocument) frame.contentDocument.documentElement.dataset.theme = isDark() ? 'dark' : 'light'
}
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme)

// ---------- screens & tabs ----------
const TABS = ['home', 'nudges', 'people', 'map', 'settings']
const SCREEN = { onboard: 's-onboard', perms: 's-perms', home: 's-home', nudges: 's-nudges', people: 's-embed', review: 's-embed', map: 's-map', settings: 's-settings' }
let current = null
function show(name) {
  current = name
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== SCREEN[name]
  const tab = name === 'review' ? 'nudges' : name
  for (const b of document.querySelectorAll('#tabbar [role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab))
  if (name in SCREEN && !['onboard', 'perms'].includes(name) && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`)
  if (name === 'map') renderMap()
  else if (mapHandle) setTimeout(() => mapHandle.map.invalidateSize(), 0)
  if (name === 'people' || name === 'review') renderEmbed(name)
  if (name === 'settings') renderSettings()
  window.scrollTo({ top: 0 })
}
const tabFromHash = () => { const t = location.hash.slice(1); return TABS.includes(t) || t === 'review' ? t : 'home' }
$('#tabbar').addEventListener('click', e => { const b = e.target.closest('[role=tab]'); if (b) show(b.dataset.tab) })
window.addEventListener('hashchange', () => { if (state) show(tabFromHash()) })

// ---------- bottom sheet ----------
function openSheet(...kids) {
  const body = $('#sheetBody'); body.replaceChildren(h('div', { class: 'grip' }), ...kids)
  $('#sheet').hidden = false
}
const closeSheet = () => { $('#sheet').hidden = true }
$('#scrim').addEventListener('click', closeSheet)
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet() })

// ======================================================================
// Onboarding (no token yet)
// ======================================================================
function renderOnboard(msg) {
  $('#tabbar').hidden = true; $('#who').textContent = ''
  const root = $('#s-onboard'); root.replaceChildren()
  const u = new URL(location.href)
  const invite = (u.searchParams.get('invite') || '').trim()
  const nodeHost = location.host

  root.append(h('h1', {}, 'Hanging out ', h('em', {}, 'should be cheap.')),
    h('p', { class: 'lede' }, 'opportune notices when it is: a friend a block away with the porchlight on, the same party on Saturday, both free Thursday. Only people who opt in to each other. Nothing public.'))
  if (msg) root.append(h('div', { class: 'banner' }, msg))

  const ways = []
  const way = (id, title, sub, form) => {
    const btn = h('button', { class: 'way', 'aria-expanded': 'false', onclick: () => open(id) }, h('b', {}, title), h('span', {}, sub))
    const box = h('div', { class: 'way-form' }, form); box.hidden = true
    ways.push({ id, btn, box }); root.append(btn, box)
  }
  const open = id => { for (const w of ways) { const on = w.id === id; w.btn.setAttribute('aria-expanded', String(on)); w.box.hidden = !on; if (on) w.box.querySelector('input')?.focus() } }
  const err = () => h('div', { class: 'err' })
  const submit = (form, errEl, fn) => async e => {
    e.preventDefault(); errEl.textContent = ''
    const b = form.querySelector('button[type=submit]'); b.disabled = true
    try { await fn() } catch (ex) { errEl.textContent = ex.message } finally { b.disabled = false }
  }

  // 1. invite code
  { const e = err(), code = h('input', { type: 'text', class: 'code', name: 'code', placeholder: 'invite code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: 24 })
    code.value = invite
    const name = h('input', { type: 'text', name: 'name', placeholder: 'What should friends call you?', autocomplete: 'name' })
    const form = h('form', { onsubmit: null }, code, name, e, h('button', { type: 'submit', class: 'btn block' }, 'Join'))
    form.addEventListener('submit', submit(form, e, () => register({ inviteCode: code.value.trim(), displayName: name.value.trim() })))
    way('invite', 'I have an invite code', 'Someone wants to see more of you.', form) }
  // 2. telegram claim
  { const e = err(), code = h('input', { type: 'text', class: 'code', name: 'code', placeholder: '6 letters', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', maxlength: 6 })
    const form = h('form', {}, h('p', { class: 'small muted', style: 'margin:0' }, 'Send ', h('code', {}, '/sources'), ' to the bot, pick the app, and type the code it shows. It lasts 15 minutes.'), code, e, h('button', { type: 'submit', class: 'btn block volt' }, 'Link'))
    form.addEventListener('submit', submit(form, e, () => claim(code.value.trim())))
    way('telegram', 'I already use the Telegram bot', 'Same person, now with a porchlight on your phone.', form) }
  // 3. fresh
  { const e = err(), name = h('input', { type: 'text', name: 'name', placeholder: 'What should friends call you?', autocomplete: 'name' })
    const form = h('form', {}, name, e, h('button', { type: 'submit', class: 'btn block ghost' }, 'Start'))
    form.addEventListener('submit', submit(form, e, () => register({ displayName: name.value.trim() })))
    way('fresh', 'Start fresh', 'No code. Invite people once you\'re in.', form) }

  open(invite ? 'invite' : 'fresh')
  root.append(h('div', { class: 'nodeline' }, `node: ${nodeHost} · `, h('button', { class: 'link', onclick: () => {
    const v = prompt('Your node\'s address (your friends\' invites tell you theirs):', `https://${nodeHost}`)
    if (!v) return
    try { const nu = new URL(/^https?:/.test(v) ? v : `https://${v}`); location.href = `${nu.origin}/app${invite ? `?invite=${encodeURIComponent(invite)}` : ''}` } catch { toast('that doesn\'t look like a URL') }
  } }, 'different node')))
  show('onboard')
}

async function register({ inviteCode, displayName }) {
  if (!displayName) throw new Error('a name, so friends know who\'s there')
  if (inviteCode === '') inviteCode = undefined
  const r = await req('/app/register', { method: 'POST', body: { inviteCode, displayName, device: bridge.deviceInfo() }, auth: false })
  await finishOnboarding(r)
}
async function claim(code) {
  if (!/^[A-Za-z0-9]{6}$/.test(code)) throw new Error('the code is 6 letters or digits')
  const r = await req('/app/claim', { method: 'POST', body: { code: code.toUpperCase() }, auth: false })
  await finishOnboarding(r)
}
async function finishOnboarding(bundle) {
  token = bundle.ingestUrl.split('/').pop()
  ls.set(KEY, token); ls.set('opportune.signedOut', null)
  ls.set('opportune.telegramLink', bundle.telegramLink || null)
  ls.set('opportune.hello', bundle.inviter ? `${bundle.inviter} wants to see more of you. Flip your porchlight on when you're around.` : 'You\'re in. Set your porchlight, then invite someone from People.')
  bridge.setIngestUrl(bundle.ingestUrl)   // the shell starts its services; location only if already granted, so we ask next
  const u = new URL(location.href); u.searchParams.delete('invite'); u.searchParams.delete('token'); history.replaceState(null, '', u.pathname + u.search + '#home')
  await start()
  if (isNative && !perms?.location) renderPerms()
}

// Native only: one line of why, then requestLocation() runs the shell's permission chain; onNativePermissions moves us on.
function renderPerms() {
  const root = $('#s-perms'); root.replaceChildren()
  const lamp = h('div', { class: 'lamp' }, lanternEl('open', { size: 110 }))
  root.append(h('div', { class: 'card perm' }, lamp,
    h('h1', {}, 'Let it see where you are'),
    h('p', {}, 'Location is how opportune notices you\'re a block from a friend whose porchlight is on. It stays on your node; friends see "home" or "a block away", never a pin.'),
    h('button', { class: 'btn', onclick: () => { bridge.requestLocation(); toast('answer the Android prompt') } }, 'Allow location'),
    h('button', { class: 'btn ghost', onclick: () => show('home') }, 'Not now')))
  $('#tabbar').hidden = true
  show('perms')
}
// The shell reports permissions once after load and after every prompt; keep `perms` current and move on.
onPermissions(p => {
  perms = p
  if (current === 'perms' && p?.location) { $('#tabbar').hidden = false; show('home') }
  else if (current === 'settings') renderSettings()
})

// ======================================================================
// Home: my porchlight + friends' porchlights
// ======================================================================
const STATE_WORDS = { open: 'Porchlight on', ask: 'Ask me first', closed: 'Porchlight off' }
const STRENGTH_WORDS = { steady: 'on', strong: 'strong', fading: 'fading', 'last-call': 'last call' }

function renderHome() {
  const root = $('#s-home'); root.replaceChildren()
  const me = state.me, pl = me.porchlight
  const hello = ls.get('opportune.hello')
  if (hello) root.append(h('div', { class: 'banner' }, hello, h('button', { class: 'x', 'aria-label': 'dismiss', onclick: e => { ls.set('opportune.hello', null); e.target.closest('.banner').remove() } }, '×')))

  // hero
  const lamp = h('div', { class: 'lamp' }, lanternEl(pl.state, { strength: pl.strength, size: 118 }))
  if (pl.until && pl.remainingMin != null) {
    const saved = JSON.parse(ls.get('opportune.porch.total') || 'null')
    const total = saved?.until === pl.until ? saved.min : Math.max(pl.remainingMin, pl.state === 'closed' ? 720 : 360)
    const C = 2 * Math.PI * 47, frac = Math.max(0, Math.min(1, pl.remainingMin / total))
    const ring = h('div', { class: 'ring', html: `<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="47"/><circle class="fill" cx="50" cy="50" r="47" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - frac)).toFixed(1)}"/></svg>` })
    lamp.append(ring)
  }
  const sub = pl.state === 'open'
    ? (pl.until ? `${fmtMin(pl.remainingMin)} left${pl.strength === 'last-call' ? ' · last call' : pl.strength === 'fading' ? ' · fading' : ''}` : pl.source === 'window' ? 'from your drop-in window' : 'your default')
    : pl.state === 'ask' ? 'Friends who come by trigger a yes-or-veto nudge to you.'
      : (pl.until ? `for another ${fmtMin(pl.remainingMin)}` : pl.source === 'default' ? 'your default' : '')
  const hero = h('div', { class: 'card hero', 'data-state': pl.state, role: 'button', tabindex: '0', 'aria-label': 'change my porchlight', onclick: openPorchSheet, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPorchSheet() } } },
    lamp, h('h1', {}, STATE_WORDS[pl.state] || pl.state), h('div', { class: 'sub' }, sub),
    pl.note && h('div', { class: 'note' }, `“${pl.note}”`),
    h('div', { class: 'hint' }, 'tap to change'))
  root.append(hero)

  if (!me.hasHome) {
    root.append(h('div', { class: 'card' }, h('h3', {}, 'No home set yet'),
      h('p', { class: 'muted' }, 'Your porchlight needs a place to shine from. Friends only ever see "home" or "out", never where that is.'),
      h('button', { class: 'btn volt', onclick: setHome }, 'Set home here')))
  } else if (!me.atHome && pl.state === 'open') {
    root.append(h('p', { class: 'small muted', style: 'margin:-4px 0 12px 4px' }, 'You\'re out right now, so drop-ins read "unlikely" until you\'re back.'))
  }

  // friends
  root.append(h('h2', {}, 'Friends\' porchlights'))
  if (!state.friends.length) root.append(h('div', { class: 'card empty' }, 'No one has shared a porchlight with you yet. Invite someone from People, or ask a friend for an invite.'))
  for (const f of state.friends) root.append(friendCard(f))
}

function friendCard(f) {
  const pl = f.porchlight
  const stateLine = pl.state === 'open'
    ? `Porchlight on${pl.strength && pl.strength !== 'steady' ? ` · ${STRENGTH_WORDS[pl.strength]}` : ''}${pl.remainingMin != null ? ` · ${fmtMin(pl.remainingMin)} left` : ''}`
    : pl.state === 'ask' ? 'Ask first' : 'Porchlight off'
  const whereWords = { home: 'home', out: 'out', unknown: f.hasHome ? 'not sure if home' : 'no home set' }
  const where = [f.distanceBand, whereWords[f.home]].filter(Boolean).join(' · ')
  const card = h('div', { class: 'card friend', 'data-state': pl.state, 'data-id': f.id },
    lanternEl(pl.state, { strength: pl.strength, size: 52 }),
    h('div', {}, h('div', { class: 'name' }, h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, f.name), f.wantMore && h('span', { class: 'star', title: 'you want to see more of them' }, '★'), f.theyWantMore && !f.wantMore && h('span', { class: 'small muted' }, 'wants more of you')),
      h('div', { class: 'state' }, stateLine), where && h('div', { class: 'where' }, where), pl.note && h('div', { class: 'note' }, `“${pl.note}”`)))
  if (pl.state === 'open') {
    const act = h('div', { class: 'act' })
    const btn = h('button', { class: 'btn small', onclick: async () => {
      btn.disabled = true; btn.textContent = 'asking…'
      try {
        const a = await req(`/api/app/friends/${f.id}/dropin`, { method: 'POST', body: { text: 'heading over now' } })
        act.querySelector('.answer')?.remove()
        act.append(h('div', { class: `answer ${a.answer}` }, h('b', {}, answerWords(a, f)), a.reason ? ` — ${a.reason}` : ''))
      } catch (e) { fail(e) } finally { btn.disabled = false; btn.textContent = 'Heading over' }
    } }, 'Heading over')
    act.append(btn, h('span', { class: 'small muted' }, 'asks their agent first'))
    card.append(act)
  }
  return card
}
const answerWords = (a, f) => ({ yes: 'Come on by', likely: 'Probably fine, they\'re being asked', unlikely: 'Not a great moment', no: 'Not now', unsupported: 'Their agent can\'t say' }[a.answer] || a.answer)

// Set / change my porchlight. POSTs { status } to the ingest URL; the server picks the window.
function openPorchSheet() {
  const pl = state.me.porchlight
  const note = h('input', { type: 'text', placeholder: 'note for friends: “come by the back”', maxlength: 140 })
  note.value = pl.note || ''
  const chip = (label, cls, status, on) => h('button', { class: `chip ${cls}${on ? ' on' : ''}`, onclick: () => setPorch(status(), note.value.trim()) }, label)
  const tonight = () => {
    const d = new Date(); const until = new Date(d); until.setHours(23, 30, 0, 0)
    if (until - d < 45 * 60e3) until.setDate(until.getDate() + 1), until.setHours(2, 0, 0, 0)
    return { porchlight: 'open', until: until.toISOString(), hours: Math.max(1, (until - d) / 3600e3) }
  }
  openSheet(h('h3', {}, 'Your porchlight'), h('p', { class: 'small muted', style: 'margin:0' }, 'Open means friends nearby can just come by. Ask means you get a yes-or-veto nudge first.'),
    h('div', { class: 'lbl' }, 'Open for'),
    h('div', { class: 'chips' }, chip('1h', '', () => ({ porchlight: 'open', hours: 1 })), chip('2h', '', () => ({ porchlight: 'open', hours: 2 }), pl.state === 'open'), chip('4h', '', () => ({ porchlight: 'open', hours: 4 })), chip('tonight', '', tonight)),
    h('div', { class: 'lbl' }, 'Or'),
    h('div', { class: 'chips' }, chip('Ask me', 'volt', () => ({ porchlight: 'ask' }), pl.state === 'ask'), chip('Closed', 'dark', () => ({ porchlight: 'closed' }), pl.state === 'closed')),
    h('div', { class: 'lbl' }, 'Note'), note,
    h('div', { class: 'foot' }, h('button', { class: 'btn ghost small', onclick: closeSheet }, 'Cancel')))
}
async function setPorch(status, note) {
  try {
    const payload = { porchlight: status.porchlight, note: note || undefined }
    if (status.until) payload.until = status.until; else if (status.hours) payload.hours = status.hours
    await ingest({ status: payload })
    const mins = status.hours ? Math.round(status.hours * 60) : null
    if (mins) ls.set('opportune.porch.total', JSON.stringify({ min: mins, until: null }))
    closeSheet(); toast(status.porchlight === 'open' ? 'porchlight on' : status.porchlight === 'ask' ? 'they\'ll ask first' : 'porchlight off')
    await refresh()
    // remember the full window so the ring can show remaining / total
    if (mins && state.me.porchlight.until) ls.set('opportune.porch.total', JSON.stringify({ min: mins, until: state.me.porchlight.until }))
  } catch (e) { fail(e) }
}
async function setHome() {
  try {
    toast('getting a fix…')
    const loc = await currentLocation()
    await ingest({ home: { lat: loc.lat, lng: loc.lng } })
    toast('home set'); await refresh()
  } catch (e) { fail(e) }
}

// ======================================================================
// Nudges
// ======================================================================
const allNudges = () => { const seen = new Set(); return [...extraNudges, ...(state?.nudges || [])].filter(n => n?.id && !seen.has(n.id) && seen.add(n.id)) }
function renderNudges() {
  const root = $('#s-nudges'); root.replaceChildren()
  root.append(h('div', { class: 'screen-head' }, h('h2', {}, 'Nudges'), h('button', { class: 'link small', onclick: () => show('review') }, 'what it kept quiet about →')))
  const list = allNudges()
  if (!list.length) root.append(h('div', { class: 'card empty' }, 'Nothing yet. When something is worth a buzz, it lands here (and on your phone, and in Telegram).'))
  for (const n of list) root.append(nudgeCard(n))
  const open = list.filter(n => !n.response && !expired(n) && Date.now() - new Date(n.created_at) < 24 * 3600e3).length
  const badge = $('#nudgeBadge'); badge.hidden = !open; badge.textContent = open
}
const expired = n => n.expires_at && new Date(n.expires_at) < Date.now()
function nudgeCard(n) {
  const done = !!n.response, gone = !done && expired(n)
  let actions = Array.isArray(n.actions) ? n.actions : []
  if (n.decision_id && !actions.some(a => a.key === 'bad')) actions = [...actions, { key: 'bad', label: 'Shouldn\'t have bugged me', quiet: true }]
  const card = h('div', { class: `card nudge${done || gone ? ' done' : ''}${n.fresh ? ' fresh' : ''}` },
    h('div', { class: 'text' }, n.text), h('div', { class: 'when' }, `${when(n.created_at)}${n.channel ? ` · ${n.channel}` : ''}${gone ? ' · expired' : ''}`))
  if (done) {
    const a = actions.find(x => x.key === n.response)
    card.append(h('div', { class: `you${n.response === 'bad' ? ' bad' : ''}` }, `you: ${a?.label || n.response}`))
  } else if (!gone && actions.length) {
    card.append(h('div', { class: 'acts' }, actions.map((a, i) => h('button', { class: `btn small${i === 0 && !a.quiet ? '' : ' ghost'}`, onclick: async e => {
      for (const b of card.querySelectorAll('button')) b.disabled = true
      try {
        await ingest({ nudgeResponse: { nudgeId: n.id, key: a.key } })
        n.response = a.key; n.responded_at = new Date().toISOString(); n.fresh = false
        card.replaceWith(nudgeCard(n)); toast(a.key === 'bad' ? 'noted, adjusting' : 'sent'); renderNudges()
      } catch (err) { fail(err); for (const b of card.querySelectorAll('button')) b.disabled = false }
    } }, a.label || a.key))))
  }
  return card
}
// A push arrived while open: { nudgeId, text, actions: [{key,label}] } (actions already parsed; tolerate a string anyway).
onNudge(n => {
  if (!n?.nudgeId) return
  let actions = n.actions; if (typeof actions === 'string') { try { actions = JSON.parse(actions) } catch { actions = [] } }
  extraNudges.unshift({ id: n.nudgeId, text: n.text, actions: actions || [], created_at: new Date().toISOString(), fresh: true })
  if (state) renderNudges()
  if (current !== 'nudges') toast(n.text)
})

// ======================================================================
// People / Review: the manage page, embedded and re-skinned (same origin, so we can style inside it)
// ======================================================================
const EMBED_CSS = `
  .top, .tabs { display: none !important }
  html, body { height: auto !important; min-height: 0 !important; background: transparent !important }
  main { padding: 0 !important; max-width: none !important }
  :root[data-theme="dark"] { --bg: #090b22; --card: #121539; --fg: #eeedf8; --muted: #a4a8cf; --line: rgba(190,196,255,.16); --acc: #4a74ff; --acc-ink: #fff; --warm: #ff6b3d; --ok: #4ad99a; --chip: rgba(255,255,255,.07); --shadow: 0 1px 2px rgba(0,0,0,.35) }
  :root[data-theme="light"] { --bg: #f6f5ff; --card: #fff; --fg: #15173a; --muted: #5a5e8a; --line: rgba(20,24,80,.14); --acc: #4a74ff; --acc-ink: #fff; --warm: #ff6b3d; --ok: #1f9d64; --chip: rgba(20,24,80,.05); --shadow: 0 1px 2px rgba(20,24,80,.06) }
  body { font-family: "Figtree", "Helvetica Neue", system-ui, sans-serif !important }
  .card { border: 1px solid var(--line) }
  .btn { border-radius: 12px; min-height: 40px }
  .toggle[aria-checked="true"] { background: #4ad99a }
`
function renderEmbed(tab) {
  const root = $('#s-embed')
  if (!frame) {
    frame = h('iframe', { class: 'embed', title: 'manage', src: `/web/manage?token=${encodeURIComponent(token)}#${tab}`, onload: styleFrame })
    root.replaceChildren(h('div', { class: 'screen-head' }, h('h2', { id: 'embedTitle' }, tab), tab === 'review' && h('button', { class: 'link small', onclick: () => show('nudges') }, '← nudges')), frame)
  } else {
    const head = root.querySelector('.screen-head'); head.replaceChildren(h('h2', {}, tab), tab === 'review' && h('button', { class: 'link small', onclick: () => show('nudges') }, '← nudges'))
    try { frame.contentWindow.location.hash = `#${tab}` } catch {}
  }
}
function styleFrame() {
  const d = frame.contentDocument, w = frame.contentWindow
  if (!d?.head) return
  d.documentElement.dataset.theme = isDark() ? 'dark' : 'light'
  d.head.append(Object.assign(d.createElement('style'), { textContent: EMBED_CSS }))
  const fit = () => { frame.style.height = `${Math.max(320, d.documentElement.scrollHeight)}px` }
  fit(); if (w.ResizeObserver) new w.ResizeObserver(fit).observe(d.body); else setInterval(fit, 1000)
  // the page inside wants a full-screen map; we have our own Map tab
  d.addEventListener('click', e => { const t = e.target.closest('a[href*="/web/map"]'); if (t) { e.preventDefault(); show('map') } })
}

// ======================================================================
// Map (trusted-tier live locations; map.js owns Leaflet)
// ======================================================================
async function renderMap() {
  const el = $('#mapEl'), legend = $('#mapLegend')
  try {
    const data = await fetchMap(token)
    if (!mapHandle) mapHandle = await mountMap(el, data, { legendEl: legend })
    else { mapHandle.update(data); mapHandle.map.invalidateSize() }
  } catch (e) { legend.textContent = e.message }
}

// ======================================================================
// Settings
// ======================================================================
async function renderSettings() {
  const root = $('#s-settings'); root.replaceChildren()
  if (!isNative) perms = await browserPermissions()
  else perms = bridge.permissions() || perms
  const me = session.me
  const row = (title, sub, right) => h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', {}, title), sub && h('span', {}, sub)), right)
  const status = (ok, onLabel = 'allowed', offLabel = 'not yet') => h('span', { class: 'small muted' }, h('i', { class: `dot ${ok ? 'on' : ok === false ? 'off' : ''}` }), ok ? onLabel : ok === false ? offLabel : 'unknown')

  // me
  root.append(h('h2', {}, 'You'), h('div', { class: 'card' },
    row(me.displayName || '(unnamed)', me.tz),
    row('Node', null, h('code', {}, new URL(me.nodeUrl || location.origin).host)),
    row('Telegram', session.telegramLinked ? 'linked: nudges and chat reach you there' : 'optional: chat with your agent ("who\'s around tonight?")',
      session.telegramLinked ? status(true, 'linked') : (session.telegramLink || ls.get('opportune.telegramLink'))
        ? h('button', { class: 'btn small volt', onclick: () => bridge.openExternal(session.telegramLink || ls.get('opportune.telegramLink')) }, 'Link Telegram')
        : h('span', { class: 'small muted' }, 'no bot on this node'))))

  // permissions
  const permCard = h('div', { class: 'card' })
  if (isNative) {
    const p = perms || {}
    const ask = (label, fn) => h('button', { class: 'btn small ghost', onclick: () => { fn(); toast('answer the Android prompt') } }, label)
    // notifications === false also covers "turned off in system settings"; requestNotifications() then opens that page
    const notif = p.notifications ? status(true) : h('span', { style: 'display:flex;align-items:center;gap:8px' }, h('span', { class: 'small muted' }, h('i', { class: 'dot off' }), 'off'), ask(p.notifications === false ? 'Open settings' : 'Allow', bridge.requestNotifications))
    permCard.append(
      row('Notifications', 'nudges as heads-up notifications with yes/veto', notif),
      row('Location', 'so it notices you\'re near a friend', p.location ? status(true) : ask('Allow', bridge.requestLocation)),
      row('Background location', '"all the time": the whole point, while the phone\'s in your pocket', p.backgroundLocation ? status(true) : ask('Allow', bridge.requestLocation)),
      row('Physical activity', 'walking vs driving, so a drive-by isn\'t a drop-in', p.activity ? status(true) : ask('Allow', bridge.requestLocation)),
      row('Share contacts', `names on guest lists get recognised. ${session.contactsSynced ? `${session.contactsSynced} synced.` : 'Synced daily, stays on your node.'}`,
        h('button', { class: 'toggle', role: 'switch', 'aria-checked': String(!!p.contacts), 'aria-label': 'share contacts', onclick: () => {
          if (p.contacts) { bridge.stopContacts(); toast('contacts sharing off'); perms = { ...p, contacts: false }; renderSettings() }
          else { bridge.requestContacts(); toast('answer the Android prompt') }
        } })),
      row('Push', null, status(session.pushBound, 'registered', 'waiting for the app to register')))
  } else {
    permCard.append(
      row('Location (this browser)', 'one-off fixes for "set home" and "heading over"', perms?.location ? status(true) : h('button', { class: 'btn small ghost', onclick: async () => { try { await currentLocation(); renderSettings() } catch (e) { fail(e) } } }, 'Allow')),
      row('Background location', 'browsers can\'t. Two ways to get it:', null),
      h('p', { class: 'small', style: 'margin:0 0 10px' }, h('a', { href: 'https://github.com/malcolmocean/opportune/tree/main/apps/android', target: '_blank', rel: 'noopener' }, 'Install the Android app'), ' and sign in with the same invite or the Telegram code; it keeps your porchlight honest and shows nudges with yes/veto buttons.'),
      h('p', { class: 'small', style: 'margin:0' }, 'On iPhone, ', h('a', { href: 'https://overland.p3k.app/', target: '_blank', rel: 'noopener' }, 'Overland'), ' (or OwnTracks in HTTP mode) can post to this URL:'))
    const urlBox = h('div')
    const showUrl = u => urlBox.replaceChildren(copyRow(u))
    if (session.locationPostUrl) showUrl(session.locationPostUrl)
    else urlBox.append(h('button', { class: 'btn small ghost', style: 'margin-top:8px', onclick: async e => {
      e.target.disabled = true
      try { const r = await req('/api/manage/sources', { method: 'POST', body: { sourceId: 'locationPost', config: { app: 'Overland (iOS)' } } }); session.locationPostUrl = r.ingestUrl; showUrl(r.ingestUrl) } catch (err) { fail(err); e.target.disabled = false }
    } }, 'Make me a location URL'))
    permCard.append(urlBox, row('Push', 'nudges arrive in Telegram or the Android app', status(session.pushBound || session.telegramLinked, session.pushBound ? 'app registered' : 'via Telegram', 'nowhere yet: link Telegram')))
  }
  root.append(h('h2', {}, isNative ? 'Permissions' : 'This device'), permCard)

  // more
  root.append(h('h2', {}, 'More'), h('div', { class: 'card' },
    row('Drop-in windows & quiet hours', 'when "open" applies by default; max nudges a day', h('button', { class: 'btn small ghost', onclick: () => { show('people'); setTimeout(() => { try { frame.contentWindow.location.hash = '#settings'; $('#embedTitle') && ($('#embedTitle').textContent = 'settings') } catch {} }, 50) } }, 'Open')),
    row('Sources', 'calendars, event mail, tweets', h('button', { class: 'btn small ghost', onclick: () => { show('people'); setTimeout(() => { try { frame.contentWindow.location.hash = '#sources'; $('#embedTitle') && ($('#embedTitle').textContent = 'sources') } catch {} }, 50) } }, 'Open')),
    row('The judge\'s calls', 'every nudge and every time it stayed quiet', h('button', { class: 'btn small ghost', onclick: () => show('review') }, 'Review')),
    row('Full management page', 'the same thing in a plain browser tab', h('a', { class: 'btn small ghost', href: session.manageUrl.replace(/^https?:\/\/[^/]+/, ''), target: '_blank', rel: 'noopener' }, 'Open'))))

  // appearance
  const seg = h('div', { class: 'seg' }, ['system', 'dark', 'light'].map(v => h('button', { 'aria-pressed': String(themePref() === v), onclick: () => { ls.set('opportune.theme', v === 'system' ? null : v); applyTheme(); renderSettings() } }, v)))
  root.append(h('h2', {}, 'Appearance'), h('div', { class: 'card' }, seg))

  // sign out
  root.append(h('div', { class: 'card', style: 'margin-top:20px' },
    row('Sign out', isNative ? 'forgets the token here; the app keeps posting location until you clear its data or sign in again' : 'forgets the token in this browser', h('button', { class: 'btn small ghost', onclick: signOut }, 'Sign out'))))
}
function copyRow(text) {
  return h('div', { class: 'copy' }, h('code', {}, text), h('button', { class: 'btn small ghost', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('copied') } catch { toast('long-press to copy') } } }, 'Copy'))
}
function signOut(msg) {
  if (!msg && !confirm('Sign out on this device?')) return
  for (const k of [KEY, 'opportune.telegramLink', 'opportune.hello', 'opportune.porch.total']) ls.set(k, null)
  ls.set('opportune.signedOut', '1')
  token = null; session = null; state = null; extraNudges = []
  clearInterval(refreshT)
  if (frame) { frame.remove(); frame = null }
  history.replaceState(null, '', location.pathname)
  renderOnboard(msg)
}

// ======================================================================
// Boot
// ======================================================================
async function refresh() {
  try {
    const s = await req('/api/app/state')
    state = s
    extraNudges = extraNudges.filter(x => !s.nudges.some(n => n.id === x.id))
    $('#who').textContent = s.me.name || ''
    renderHome(); renderNudges()
  } catch (e) {
    if (e.status === 401) return signOut('That link isn\'t valid any more. Sign in again.')
    if (!state) throw e
    toast('offline? couldn\'t refresh')
  }
}
async function start() {
  session = await req('/api/app/session', { method: 'POST', body: { device: bridge.deviceInfo() } })
  if (isNative && !bridge.ingestUrl()) bridge.setIngestUrl(session.ingestUrl)
  perms = isNative ? bridge.permissions() : await browserPermissions()
  await refresh()
  $('#tabbar').hidden = false
  show(tabFromHash())
  clearInterval(refreshT); refreshT = setInterval(() => { if (document.visibilityState === 'visible') refresh().catch(() => {}) }, 60e3)
}

function readToken() {
  const u = new URL(location.href)
  let t = u.searchParams.get('token')
  if (t) { ls.set(KEY, t); ls.set('opportune.signedOut', null); u.searchParams.delete('token'); history.replaceState(null, '', u.pathname + u.search + u.hash) }
  else t = ls.get(KEY)
  if (!t && isNative && !ls.get('opportune.signedOut')) { const iu = bridge.ingestUrl(); if (iu) { t = iu.split('/').pop(); ls.set(KEY, t) } }
  return t || null
}

applyTheme()
token = readToken()
if (!token) renderOnboard()
else {
  try { await start() } catch (e) {
    if (e.status === 401) signOut('That link isn\'t valid any more. Sign in again.')
    else { $('#s-onboard').hidden = false; $('#s-onboard').replaceChildren(h('div', { class: 'gate' }, h('h1', {}, 'Couldn\'t reach your node'), h('p', { class: 'muted' }, e.message), h('button', { class: 'btn', onclick: () => location.reload() }, 'Try again'))) }
  }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state) refresh().then(() => { if (current === 'map') renderMap() }).catch(() => {}) })
// foreground, or a nudge answered from a notification action while we're open: state + nudges again
onResume(() => { if (state) refresh().then(() => { if (current === 'map') renderMap() }).catch(() => {}) })
