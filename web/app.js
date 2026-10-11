// The opportune app. One page: onboarding → home (my porchlight + friends' porchlights) → nudges,
// people, sources, the judge's calls, the map (map.js) and settings. All native screens over
// /api/app/* and /api/manage/* with the one token. Works in any browser; inside the Android shell
// it uses window.opportuneNative (web/app/bridge.js).
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
const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null } catch { return null } }
let toastT
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true }, 2200) }
const fail = e => toast(e?.message || 'something went wrong')
const fmtMin = m => (m == null ? '' : m < 1 ? 'less than a minute' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`)
const ago = m => (m == null ? '' : m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`)
const when = iso => {
  const d = new Date(iso), diff = (Date.now() - d) / 60e3
  if (diff < 1) return 'just now'
  if (diff < 60) return `${Math.round(diff)}m ago`
  if (diff < 24 * 60) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }

// ---------- state ----------
let token = null       // the one credential: a source token (tail of ingestUrl) or a manage token
let session = null     // POST /api/app/session
let state = null       // GET /api/app/state
let manage = null      // GET /api/manage/me: friends, sources, decisions, nudges, policy (loaded lazily, then kept fresh)
let perms = null       // native permissions, or the browser's best guess
let extraNudges = []   // pushed in by the shell while open (onNativeNudge), until the next refresh has them
let mapHandle = null, refreshT = null

async function req(url, { method = 'GET', body, auth = true } = {}) {
  const r = await fetch(url, { method, headers: { ...(auth && token ? { 'x-manage-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText || `http ${r.status}`), { status: r.status })
  return data
}
const api = (path, opts) => req(`/api/manage${path}`, opts)
// POST to my ingest URL (same shapes the Android shell posts). Relative, so dev nodes with a different NODE_URL still work.
const ingest = body => req(new URL(session.ingestUrl, location.href).pathname, { method: 'POST', body, auth: false })
async function loadManage() { manage = await api('/me'); return manage }

// ---------- theme ----------
const themePref = () => ls.get('opportune.theme') || 'system'
const isDark = () => themePref() === 'dark' || (themePref() !== 'light' && !matchMedia('(prefers-color-scheme: light)').matches)
function applyTheme() {
  const p = themePref()
  if (p === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = p
  $('meta[name=theme-color]')?.setAttribute('content', isDark() ? '#090b22' : '#f6f5ff')
}
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', applyTheme)

// ---------- screens & tabs ----------
const TABS = ['home', 'nudges', 'people', 'map', 'settings']
const SCREEN = { onboard: 's-onboard', perms: 's-perms', home: 's-home', nudges: 's-nudges', review: 's-review', people: 's-people', sources: 's-sources', windows: 's-windows', map: 's-map', settings: 's-settings' }
const PARENT = { review: 'nudges', sources: 'settings', windows: 'settings' }   // sub-screens light up their tab
let current = null
function show(name) {
  if (!(name in SCREEN)) name = 'home'
  current = name
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== SCREEN[name]
  const tab = PARENT[name] || name
  for (const b of document.querySelectorAll('#tabbar [role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab))
  if (!['onboard', 'perms'].includes(name) && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`)
  if (name === 'map') renderMap()
  else if (mapHandle) setTimeout(() => mapHandle.map.invalidateSize(), 0)
  if (name === 'people') withManage(renderPeople)
  if (name === 'review') withManage(renderReview)
  if (name === 'sources') withManage(renderSources)
  if (name === 'windows') withManage(renderWindows)
  if (name === 'settings') renderSettings()
  window.scrollTo({ top: 0 })
}
const tabFromHash = () => { const t = location.hash.slice(1); return TABS.includes(t) || t in PARENT ? t : 'home' }
$('#tabbar').addEventListener('click', e => { const b = e.target.closest('[role=tab]'); if (b) show(b.dataset.tab) })
window.addEventListener('hashchange', () => { if (state) show(tabFromHash()) })
// Screens built from /api/manage/me: render what we have at once (if anything), then again with fresh data.
function withManage(render) {
  const name = current
  if (manage) render()
  else { const root = $(`#${SCREEN[name]}`); root.replaceChildren(h('div', { class: 'empty' }, 'Loading…')) }
  loadManage().then(() => { if (current === name) render() }).catch(e => { if (!manage) $(`#${SCREEN[name]}`).replaceChildren(h('div', { class: 'card empty' }, e.message)) })
}
const head = (title, back, right) => h('div', { class: 'screen-head' }, h('div', {}, back && h('button', { class: 'back', onclick: () => show(back[1]) }, back[0]), h('h2', {}, title)), right)

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
    const form = h('form', {}, code, name, e, h('button', { type: 'submit', class: 'btn block' }, 'Join'))
    form.addEventListener('submit', submit(form, e, () => register({ inviteCode: code.value.trim(), displayName: name.value.trim() })))
    way('invite', 'I have an invite code', 'Someone wants to see more of you.', form) }
  // 2. fresh
  { const e = err(), name = h('input', { type: 'text', name: 'name', placeholder: 'What should friends call you?', autocomplete: 'name' })
    const form = h('form', {}, name, e, h('button', { type: 'submit', class: 'btn block' }, 'Start'))
    form.addEventListener('submit', submit(form, e, () => register({ displayName: name.value.trim() })))
    way('fresh', 'Start fresh', 'No code. Invite people once you\'re in.', form) }
  // 3. email sign-in (an existing person on this node; the link lands back here as /app?claim=CODE)
  { const e = err(), email = h('input', { type: 'email', name: 'email', placeholder: 'you@example.com', autocomplete: 'email', inputmode: 'email' })
    const form = h('form', {}, h('p', { class: 'small muted', style: 'margin:0' }, 'Already on this node? A one-time sign-in link goes to the email on your account.'), email, e, h('button', { type: 'submit', class: 'btn block ghost' }, 'Send me a link'))
    form.addEventListener('submit', submit(form, e, async () => {
      const v = email.value.trim()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('that doesn\'t look like an email address')
      try { await req('/app/email/request', { method: 'POST', body: { email: v }, auth: false }) } catch (ex) { throw ex.status === 404 ? new Error('email sign-in isn\'t set up on this node yet') : ex }
      // Sent. Tapping the link lands back here; the 6-letter code from the same mail is the way in when it doesn't.
      const ce = err(), code = h('input', { type: 'text', class: 'code', name: 'code', placeholder: '6 letters from the email', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', maxlength: 6 })
      const codeForm = h('form', {}, h('p', { style: 'margin:0' }, h('b', {}, 'Check your mail.'), ` A sign-in link is on its way to ${v}. Tap it on this device, or type the code it shows:`), code, ce, h('button', { type: 'submit', class: 'btn block' }, 'Sign in'))
      codeForm.addEventListener('submit', submit(codeForm, ce, () => claim(code.value.trim(), { typed: true })))
      form.replaceWith(codeForm)
      code.focus()
    }))
    way('email', 'Sign in with email', 'A link in your inbox, no password.', form) }
  // 4. telegram claim
  { const e = err(), code = h('input', { type: 'text', class: 'code', name: 'code', placeholder: '6 letters', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', maxlength: 6 })
    const form = h('form', {}, h('p', { class: 'small muted', style: 'margin:0' }, 'Send ', h('code', {}, '/sources'), ' to the bot, pick the app, and type the code it shows. It lasts 15 minutes.'), code, e, h('button', { type: 'submit', class: 'btn block ghost' }, 'Link'))
    form.addEventListener('submit', submit(form, e, () => claim(code.value.trim(), { typed: true })))
    way('telegram', 'I already use the Telegram bot', 'Same person, now with a porchlight on your phone.', form) }

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
  const r = await req('/app/register', { method: 'POST', body: { inviteCode, displayName, device: bridge.deviceInfo(), tz: deviceTz() }, auth: false })
  await finishOnboarding(r)
}
// A code from the Telegram bot (6 chars, typed) or from an email sign-in link (/app?claim=CODE, any shape): same route, same bundle back.
async function claim(code, { typed = false } = {}) {
  if (typed && !/^[A-Za-z0-9]{6}$/.test(code)) throw new Error('the code is 6 letters or digits')
  if (!code) throw new Error('no code')
  const r = await req('/app/claim', { method: 'POST', body: { code: typed ? code.toUpperCase() : code }, auth: false })
  await finishOnboarding(r)
}
async function finishOnboarding(bundle) {
  token = bundle.ingestUrl.split('/').pop()
  ls.set(KEY, token); ls.set('opportune.signedOut', null)
  ls.set('opportune.telegramLink', bundle.telegramLink || null)
  ls.set('opportune.hello', bundle.inviter ? `${bundle.wantMore === false ? `You and ${bundle.inviter} are connected.` : `${bundle.inviter} wants to see more of you.`} Flip your porchlight on when you're around.`
    : bundle.displayName ? null : 'You\'re in. Set your porchlight, then invite someone from People.')   // a returning sign-in needs no banner; the name is in the header
  bridge.setIngestUrl(bundle.ingestUrl)   // the shell starts its services; location only if already granted, so we ask next
  const u = new URL(location.href); for (const k of ['invite', 'token', 'claim']) u.searchParams.delete(k); history.replaceState(null, '', u.pathname + u.search + '#home')
  await start()
  if (isNative && !perms?.location) renderPerms()
}

// Native only: one line of why, then requestLocation() runs the shell's permission chain; onNativePermissions moves us on.
function renderPerms() {
  const root = $('#s-perms'); root.replaceChildren()
  const lamp = h('div', { class: 'lamp' }, lanternEl('open', { size: 110 }))
  root.append(h('div', { class: 'card perm' }, lamp,
    h('h1', {}, 'Let it see where you are'),
    h('p', {}, 'Location is for the bumping-into part: noticing when you and a friend are near each other, or when you pass someone who\'s up for company. It stays on your node. Friends see "home" or "a block away", never a pin.'),
    h('p', { class: 'small muted' }, 'Your porchlight is a separate thing. It says whether you\'re open to drop-ins right now, and only you flip it.'),
    h('button', { class: 'btn', onclick: () => { bridge.requestLocation(); toast('answer the system prompt') } }, 'Allow location'),
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
const modeWord = m => ({ open: 'on', ask: 'ask me first', closed: 'off' }[m] || 'your default')
const clock = iso => { const d = new Date(iso), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); return d.toDateString() === new Date().toDateString() ? t : `${t} ${d.toLocaleDateString([], { weekday: 'short' })}` }

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
    : pl.state === 'ask' ? `Friends who come by trigger a yes-or-veto nudge to you.${pl.until ? ` Until ${clock(pl.until)}, then ${modeWord(pl.then)}.` : ''}`
      : (pl.until ? `until ${clock(pl.until)}, then ${modeWord(pl.then)}` : pl.source === 'default' ? 'your default' : 'until you change it')
  const hero = h('div', { class: 'card hero', 'data-state': pl.state, role: 'button', tabindex: '0', 'aria-label': 'change my porchlight', onclick: openPorchSheet, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPorchSheet() } } },
    lamp, h('h1', {}, STATE_WORDS[pl.state] || pl.state), h('div', { class: 'sub' }, sub),
    pl.note && h('div', { class: 'note' }, `“${pl.note}”`),
    h('div', { class: 'hint' }, 'tap to change'))
  root.append(hero, beliefCard())

  // sources progress, until everything is connected or declined (then it lives in Settings only)
  if (manage) { const { done, total } = sourceModel(); if (done < total) root.append(progressCard()) }

  if (isNative && !perms?.notifications) {
    root.append(h('div', { class: 'card' }, h('h3', {}, 'Let nudges reach you'),
      h('p', { class: 'muted' }, 'A nudge is a notification with yes and veto buttons. Without it the app can only tell you when you open it.'),
      h('button', { class: 'btn volt', onclick: () => { bridge.requestNotifications(); toast(perms?.notifications === false ? 'turn notifications on in the settings page' : 'answer the system prompt') } }, perms?.notifications === false ? 'Open notification settings' : 'Allow notifications')))
  }
  if (!me.hasHome) root.append(homeCard())
  else if (!me.atHome && pl.state === 'open') {
    root.append(h('p', { class: 'small muted', style: 'margin:-4px 0 12px 4px' }, 'You\'re out right now, so drop-ins read "unlikely" until you\'re back.'))
  }

  // friends
  root.append(h('h2', {}, 'Friends\' porchlights'))
  if (!state.friends.length) root.append(h('div', { class: 'card empty' }, 'No one has shared a porchlight with you yet. ', h('button', { class: 'link', onclick: openInviteSheet }, 'Invite someone'), ', or ask a friend for an invite.'))
  for (const f of state.friends) root.append(friendCard(f))
}

// "What I think is going on": one row per fact of state.me.belief, each with a quiet "wrong" button that files a
// correction (POST /api/app/corrections; they show up on the Review screen). A fact whose basis says a source is
// missing gets a link to the fix instead. This card is for auditing the node's picture of you, not a hero.
const corrected = new Map()   // key → the believed value the person disputed; the "corrected" tag stays while the belief still says that
const FACT_LABEL = { where: 'where', moving: 'moving', porchlight: 'porchlight', calendar: 'calendar' }
function beliefCard() {
  const b = state.me.belief
  if (!b?.facts?.length) return null
  const fix = f => {
    if (f.key === 'calendar' && f.value === 'no calendar connected') return ['connect', () => show('sources')]
    if (f.key === 'where' && f.value === 'no home set') return ['set home', () => { const c = $('#s-home .home-card'); c ? c.scrollIntoView({ block: 'center', behavior: 'smooth' }) : show('settings') }]
    if (f.key === 'where' && f.basis === 'no location from your phone yet') return ['allow location', () => show('settings')]
    return null
  }
  const card = h('div', { class: 'card belief' }, h('h3', {}, 'What I think is going on'))
  for (const f of b.facts) {
    if (corrected.has(f.key) && corrected.get(f.key) !== f.value) corrected.delete(f.key)   // the belief moved on
    const fx = fix(f)
    const right = fx ? h('button', { class: 'link small', onclick: fx[1] }, fx[0])
      : corrected.has(f.key) ? h('span', { class: 'tag' }, 'corrected')
        : h('button', { class: 'wrong', 'aria-label': `${FACT_LABEL[f.key] || f.key}: that's wrong`, onclick: () => openWrongSheet(f) }, 'wrong')
    card.append(h('div', { class: 'fact', 'data-key': f.key }, h('span', { class: 'k' }, FACT_LABEL[f.key] || f.key),
      h('div', { class: 'v' }, h('b', {}, f.value), h('span', { class: 'basis' }, f.basis)), right))
  }
  return card
}
function openWrongSheet(f) {
  const ta = h('textarea', { rows: 2, maxlength: 500, placeholder: 'optional: what is actually going on' })
  const btn = h('button', { class: 'btn block', onclick: async () => {
    btn.disabled = true
    try {
      const actually = ta.value.trim()
      await req('/api/app/corrections', { method: 'POST', body: { key: f.key, believed: f.value, actually: actually || undefined } })
      corrected.set(f.key, f.value); closeSheet(); toast('noted'); renderHome()
    } catch (e) { fail(e); btn.disabled = false }
  } }, 'Send')
  openSheet(h('h3', {}, 'What\'s actually going on?'), h('p', { class: 'small muted', style: 'margin:0' }, `It thinks ${FACT_LABEL[f.key] || f.key} is `, h('b', {}, f.value), ` (${f.basis}).`),
    h('div', { class: 'lbl' }, 'Actually'), ta, h('p', { class: 'small muted', style: 'margin:8px 0 12px' }, 'Corrections land under Review, so you can see what it keeps getting wrong.'), btn,
    h('div', { class: 'foot' }, h('button', { class: 'btn ghost small', onclick: closeSheet }, 'Cancel')))
  setTimeout(() => ta.focus(), 50)
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
      h('div', { class: 'state' }, stateLine), where && h('div', { class: 'where' }, where), pl.note && h('div', { class: 'note' }, `“${pl.note}”`), f.story && storyEl(f.story)))
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
// A friend's story (what they're generally up for and when), clamped to two lines with a "more" toggle when longer.
function storyEl(text) {
  const el = h('div', { class: 'story' }, text)
  if (text.length <= 110 && !text.includes('\n')) return el
  const more = h('button', { class: 'link small more', onclick: () => { const open = el.classList.toggle('open'); more.textContent = open ? 'less' : 'more' } }, 'more')
  return h('div', {}, el, more)
}
const answerWords = (a, f) => ({ yes: 'Come on by', likely: 'Probably fine, they\'re being asked', unlikely: 'Not a great moment', no: 'Not now', unsupported: 'Their agent can\'t say' }[a.answer] || a.answer)

// Set / change my porchlight. POSTs { status } to the ingest URL; the server picks the window.
function openPorchSheet() {
  const pl = state.me.porchlight, dn = state.me.defaultNote || ''
  // a note typed here is for this status only; blank keeps the standing note (shown as the placeholder)
  const note = h('input', { type: 'text', placeholder: dn || 'e.g. “come by the back”', maxlength: 140, 'aria-label': 'note for this time' })
  note.value = pl.source === 'status' && pl.note && pl.note !== dn ? pl.note : ''
  const chip = (label, cls, status, on) => h('button', { class: `chip ${cls}${on ? ' on' : ''}`, onclick: () => setPorch(status(), note.value.trim()) }, label)
  const tonight = () => {
    const d = new Date(); const until = new Date(d); until.setHours(23, 30, 0, 0)
    if (until - d < 45 * 60e3) until.setDate(until.getDate() + 1), until.setHours(2, 0, 0, 0)
    return { porchlight: 'open', until: until.toISOString(), hours: Math.max(1, (until - d) / 3600e3) }
  }
  openSheet(h('h3', {}, 'Your porchlight'), h('p', { class: 'small muted', style: 'margin:0' }, 'Open means friends nearby can just come by. Ask means you get a yes-or-veto nudge first.'),
    h('div', { class: 'lbl' }, 'Open for'),
    h('div', { class: 'chips' }, chip('1h', '', () => ({ porchlight: 'open', hours: 1 })), chip('2h', '', () => ({ porchlight: 'open', hours: 2 })), chip('4h', '', () => ({ porchlight: 'open', hours: 4 })), chip('tonight', '', tonight)),
    h('div', { class: 'lbl' }, 'Or'),
    h('div', { class: 'chips' }, chip('Ask me', 'volt', () => ({ porchlight: 'ask' }), pl.state === 'ask'), chip('Closed', 'dark', () => ({ porchlight: 'closed' }), pl.state === 'closed' && !pl.until), chip('Closed for the night', 'dark', () => ({ porchlight: 'closed', until: 'morning' }), pl.state === 'closed' && !!pl.until)),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Ask me and Closed hold until you change them. For the night ends when your quiet hours do.'),
    h('div', { class: 'lbl' }, 'Note for this time'), note,
    h('div', { class: 'standing small muted' }, dn ? ['Standing note: ', h('i', {}, `“${dn}”`), ' · '] : 'No standing note yet · ', h('button', { class: 'link', onclick: openDefaultNoteSheet }, dn ? 'change' : 'set one')),
    h('div', { class: 'foot' }, h('button', { class: 'btn ghost small', onclick: closeSheet }, 'Cancel')))
}
// The standing drop-in note: shown with the porchlight whenever a status has no note of its own (never under a closed one).
function openDefaultNoteSheet() {
  const dn = state.me.defaultNote || ''
  const inp = h('input', { type: 'text', placeholder: '“come round the back, door\'s open”', maxlength: 500, 'aria-label': 'standing note' })
  inp.value = dn
  const save = async v => {
    try { await ingest({ defaultNote: v }); toast(v ? 'standing note saved' : 'standing note cleared'); await refresh(); openPorchSheet() } catch (e) { fail(e) }
  }
  openSheet(h('h3', {}, 'Standing note'), h('p', { class: 'small muted', style: 'margin:0' }, 'Friends see this with your porchlight unless you give a status its own note. It stays after one-time notes expire.'),
    h('div', { class: 'lbl' }, 'Note'), inp,
    h('div', { class: 'foot', style: 'gap:8px' }, dn && h('button', { class: 'btn ghost small', onclick: () => save('') }, 'Clear'), h('button', { class: 'btn ghost small', onclick: openPorchSheet }, 'Back'), h('button', { class: 'btn small', onclick: () => save(inp.value.trim()) }, 'Save')))
  setTimeout(() => inp.focus(), 50)
}
async function setPorch(status, note) {
  try {
    const payload = { porchlight: status.porchlight }
    if (note) payload.note = note   // only when typed: blank keeps the standing note
    if (status.until) payload.until = status.until; else if (status.hours) payload.hours = status.hours
    await ingest({ status: payload })
    const mins = status.hours ? Math.round(status.hours * 60) : null
    if (mins) ls.set('opportune.porch.total', JSON.stringify({ min: mins, until: null }))
    closeSheet(); toast(status.porchlight === 'open' ? 'porchlight on' : status.porchlight === 'ask' ? 'they\'ll ask first' : status.until === 'morning' ? 'porchlight off for the night' : 'porchlight off')
    await refresh()
    // remember the full window so the ring can show remaining / total
    if (mins && state.me.porchlight.until) ls.set('opportune.porch.total', JSON.stringify({ min: mins, until: state.me.porchlight.until }))
  } catch (e) { fail(e) }
}
// "Set home to 123 Main St": find the phone first, name the place, then one tap confirms. If location isn't
// allowed yet the button asks for it first. Friends never see the address; it's only to confirm the fix is right.
function homeCard() {
  const btn = h('button', { class: 'btn volt' }, 'Finding where you are…')
  const sub = h('p', { class: 'muted' }, 'Your porchlight shines from home. Friends only ever see "home" or "out", never where that is.')
  let fix = null
  const arm = () => { btn.disabled = false; btn.onclick = async () => { btn.disabled = true; try { await ingest({ home: { lat: fix.lat, lng: fix.lng } }); toast('home set'); await refresh() } catch (e) { fail(e); btn.disabled = false } } }
  const locate = async () => {
    btn.disabled = true; btn.textContent = 'Finding where you are…'
    try {
      fix = await currentLocation()
      btn.textContent = 'Set home here'; arm()
      const addr = await reverseGeocode(fix).catch(() => null)
      if (addr) btn.textContent = `Set home to ${addr}`
    } catch (e) {
      btn.textContent = 'Use my location'; btn.disabled = false; btn.onclick = () => { locate() }
      if (e?.code !== 1) fail(e)   // 1 = permission denied; the button already says what to do
    }
  }
  if (perms?.location) locate()
  else { btn.textContent = 'Use my location'; btn.disabled = false; btn.onclick = () => { locate() } }
  return h('div', { class: 'card home-card' }, h('h3', {}, 'Where\'s home?'), sub, btn)
}
async function reverseGeocode({ lat, lng }) {
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error('no address')
  const a = (await r.json()).address || {}
  const street = [a.house_number, a.road || a.pedestrian || a.footway].filter(Boolean).join(' ')
  const town = a.city || a.town || a.village || a.suburb || a.neighbourhood
  return [street, town].filter(Boolean).join(', ') || null
}

// ======================================================================
// Nudges
// ======================================================================
const allNudges = () => { const seen = new Set(); return [...extraNudges, ...(state?.nudges || [])].filter(n => n?.id && !seen.has(n.id) && seen.add(n.id)) }
function renderNudges() {
  const root = $('#s-nudges'); root.replaceChildren()
  root.append(h('div', { class: 'screen-head' }, h('h2', {}, 'Nudges'), h('button', { class: 'link small', onclick: () => show('review') }, 'what it kept quiet about →')))
  const list = allNudges()
  if (!list.length) root.append(h('div', { class: 'card empty' }, 'Nothing yet. When something is worth a buzz, it lands here and on your phone.'))
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
// Review: the judge's calls, including what it kept quiet about (reachable from Nudges)
// ======================================================================
let quietOnly = false
function renderReview() {
  const root = $('#s-review'); root.replaceChildren()
  root.append(head('The judge\'s calls', ['Nudges', 'nudges']), correctionsBox())
  const cb = h('input', { type: 'checkbox', id: 'quietOnly', onchange: e => { quietOnly = e.target.checked; renderReview() } })
  cb.checked = quietOnly
  root.append(h('label', { class: 'filter' }, cb, 'only the quiet ones (things it decided not to tell me)'))
  const list = manage.decisions.filter(d => !quietOnly || d.verdict === 'suppress')
  if (!list.length) return root.append(h('div', { class: 'card empty' }, manage.decisions.length ? 'Nothing quiet lately.' : 'No judgement calls yet. They show up here, including the ones it keeps to itself.'))
  for (const d of list) root.append(decisionCard(d))
}
// What you told it was wrong (the belief card's "wrong" buttons): GET /api/app/corrections, newest first. Hidden when empty.
function correctionsBox() {
  const box = h('div', { class: 'card corrections' })
  box.hidden = true
  req('/api/app/corrections').then(list => {
    if (!list.length) return
    box.append(h('h3', {}, 'You corrected'))
    for (const c of list) box.append(h('div', { class: 'c' }, h('span', { class: 'k' }, FACT_LABEL[c.key] || c.key), h('span', {}, h('b', {}, c.believed || '(blank)'), ' → ', c.actually ? h('b', {}, c.actually) : h('span', { class: 'muted' }, 'wrong, no detail')), h('span', { class: 'when' }, when(c.at))))
    box.hidden = false
  }).catch(() => {})
  return box
}
function decisionCard(d) {
  const card = h('div', { class: 'card decision' })
  const rate = async rating => {
    let note
    if (rating === 'bad' && d.verdict !== 'suppress') note = prompt('Why was this a bad call? (optional)') || undefined
    try { const r = await api(`/decisions/${d.id}/rate`, { method: 'POST', body: { rating, note } }); Object.assign(d, r.decision); card.replaceWith(decisionCard(d)); toast(rating === 'good' ? 'thanks' : 'noted, adjusting') } catch (e) { fail(e) }
  }
  const icon = d.verdict === 'suppress' ? '🤫' : d.verdict === 'ask' ? '🙋' : '🔔'
  const nudge = d.nudgeId && manage.nudges.find(n => n.id === d.nudgeId)
  // for a suppression, 👍 means "right to stay quiet" and 👎 means "should have told me"
  const goodLbl = d.verdict === 'suppress' ? '👍 right to stay quiet' : '👍 good call'
  const badLbl = d.verdict === 'suppress' ? '👎 should have told me' : '👎 shouldn\'t have'
  card.append(h('div', { class: 'icon', title: d.verdict }, icon), h('div', {},
    h('div', { class: 'summary' }, d.opportunity.summary || `(${d.verdict})`),
    nudge && h('div', { class: 'small', style: 'margin-top:4px' }, '→ ', nudge.text, nudge.response ? h('span', { class: 'muted' }, ` · you: ${nudge.response}`) : null),
    h('div', { class: 'reason' }, d.reasoning),
    h('div', { class: 'when' }, `${when(d.createdAt)} · ${d.opportunity.kind || ''}`),
    h('div', { class: 'rate' },
      h('button', { 'aria-pressed': String(d.rating === 'good'), onclick: () => rate('good') }, goodLbl),
      h('button', { 'aria-pressed': String(d.rating === 'bad'), onclick: () => rate('bad') }, badLbl),
      d.ratingNote && h('span', { class: 'note' }, d.ratingNote))))
  return card
}

// ======================================================================
// People: tiers, grants, notes, and inviting someone new
// ======================================================================
const GRANTS = [
  ['askAvailability', 'Ask if I\'m free', 'Their agent can ask mine whether I\'m free; it answers from my calendar.'],
  ['askDropin', 'Ask to drop by', 'They can ask if dropping in right now is welcome.'],
  ['autoYesDropin', 'Auto-yes drop-ins', 'My agent says yes to their drop-ins without checking with me (within my windows).'],
  ['askWhereabouts', 'Ask where I am', 'They can ask roughly where I am (neighbourhood, not a pin).'],
  ['seeLocationLive', 'See my live location', 'They see my current location on their map, no asking.'],
  ['seePlans', 'See my plans', 'They can see what\'s on my calendar, not just whether I\'m busy.'],
]
const TIERS = ['acquaintance', 'friend', 'trusted']
const TRAVEL = ['not out of my way', 'a few blocks', 'across town', 'a real trip']
const THEIRS = { askAvailability: 'I can ask if they\'re free', askDropin: 'I can ask to drop by', autoYesDropin: 'auto-yes to my drop-ins', askWhereabouts: 'I can ask where they are', seeLocationLive: 'they share live location', seePlans: 'I can see their plans' }

function renderPeople() {
  const root = $('#s-people'); root.replaceChildren()
  const fs = manage.friends
  const on = fs.filter(f => !f.shadow), shadow = fs.filter(f => f.shadow)
  const stars = on.filter(f => f.rel.wantMore).length
  root.append(h('div', { class: 'screen-head' }, h('h2', {}, `People${on.length ? ` · ${on.length}${stars ? ` · ★ ${stars}` : ''}` : ''}`), h('button', { class: 'btn small', onclick: openInviteSheet }, '+ Invite')))
  if (!fs.length) root.append(h('div', { class: 'card empty' }, 'No one yet. An invite is a one-time link that says you want to see more of them.', h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: openInviteSheet }, 'Invite a friend'))))
  for (const f of on) root.append(personCard(f))
  if (shadow.length) {
    root.append(h('h2', {}, 'Not on opportune yet'), h('p', { class: 'small muted', style: 'margin:-4px 0 10px' }, 'They share their location with you in Google Maps. An invite brings them in.'))
    for (const f of shadow) root.append(personCard(f))
  }
}

function personCard(f, openState = []) {
  const card = h('div', { class: 'card person', 'data-id': f.id })
  const patch = async (body, okMsg) => {
    try {
      const { friend } = await api(`/friends/${f.id}`, { method: 'PATCH', body })
      Object.assign(f, friend)
      card.replaceWith(personCard(f, [...card.querySelectorAll('details')].map(d => d.open)))   // keep whichever sections were expanded
      if (okMsg) toast(okMsg)
    } catch (e) { fail(e) }
  }
  const star = h('button', { class: 'star', 'aria-pressed': String(f.rel.wantMore), title: 'I want to see more of them', 'aria-label': 'I want to see more of them', onclick: () => patch({ wantMore: !f.rel.wantMore }) }, '★')
  const tags = h('div', { class: 'tags' })
  if (f.shadow) tags.append(h('span', { class: 'tag' }, 'not on opportune'))
  if (f.remote) tags.append(h('span', { class: 'tag' }, 'other node'))
  if (f.lastLocationAgeMin != null) tags.append(h('span', { class: 'tag on' }, `● seen ${ago(f.lastLocationAgeMin)}`))
  if (f.theirs?.wantMore) tags.append(h('span', { class: 'tag' }, 'wants more of you'))
  card.append(h('div', { class: 'head' }, h('div', { class: 'name' }, f.displayName || '(unnamed)', tags.childElementCount ? tags : null), star))

  if (f.shadow) {
    const out = h('div')
    card.append(h('button', { class: 'btn small', style: 'margin-top:8px', onclick: async e => {
      e.target.disabled = true
      try { const inv = await api(`/friends/${f.id}/invite-link`, { method: 'POST' }); out.replaceChildren(shareRow(inv.url, f.displayName)) } catch (err) { fail(err) } finally { e.target.disabled = false }
    } }, 'Make invite link'), out)
  }

  // tier
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'tier' }, TIERS.map(t => h('button', { 'aria-pressed': String(f.rel.tier === t), onclick: () => f.rel.tier !== t && patch({ tier: t }) }, t)))
  card.append(h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('div', { class: 'lbl' }, h('b', {}, 'Tier'), h('span', {}, 'sets the default grants below')), seg))

  // travel
  const out = h('output', {}, TRAVEL[f.rel.travel ?? 1])
  const range = h('input', { type: 'range', min: 0, max: 3, step: 1, value: f.rel.travel ?? 1, 'aria-label': 'how far out of my way', oninput: e => { out.textContent = TRAVEL[e.target.value] }, onchange: e => patch({ travel: Number(e.target.value) }) })
  card.append(h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('div', { class: 'lbl' }, h('b', {}, 'How far out of my way'), h('span', {}, 'private: they never see this')), h('div', { class: 'slider' }, range, out)))

  // grants
  const grants = h('details', {}, h('summary', {}, 'What they may do with my data'))
  for (const [k, label, why] of GRANTS) {
    const eff = !!f.rel.effectiveGrants[k], custom = k in f.rel.grants
    grants.append(h('div', { class: 'row' },
      h('div', { class: 'lbl' }, h('b', {}, label, custom && h('button', { class: 'custom', title: 'back to tier default', onclick: () => patch({ grants: { [k]: null } }) }, 'custom · reset')), h('span', {}, why)),
      h('button', { class: 'toggle', role: 'switch', 'aria-checked': String(eff), 'aria-label': label, onclick: () => patch({ grants: { [k]: !eff } }) })))
  }
  card.append(grants)

  // what they've given me
  if (f.theirs) {
    const chips = Object.entries(THEIRS).filter(([k]) => f.theirs.effectiveGrants?.[k]).map(([, t]) => h('span', { class: 'chip on' }, t))
    card.append(h('details', {}, h('summary', {}, `What ${f.displayName || 'they'} lets me do`), h('div', { class: 'chips small', style: 'padding:4px 0 8px' }, chips.length ? chips : h('span', { class: 'chip' }, 'nothing yet'), h('span', { class: 'chip' }, `they rate me ${f.theirs.tier}`))))
  }

  // via
  const via = h('details', {}, h('summary', {}, `Friends of ${f.displayName || 'them'}`))
  const viaSeg = h('div', { class: 'seg' }, [[null, 'nothing'], ['acquaintance', 'acquaintance'], ['friend', 'friend']].map(([v, l]) => h('button', { 'aria-pressed': String((f.rel.via.tier || null) === v), onclick: () => patch({ via: { tier: v } }) }, l)))
  via.append(h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('div', { class: 'lbl' }, h('b', {}, 'Extend to people they vouch for'), h('span', {}, 'what their friends get from me before we\'ve met')), viaSeg))
  via.append(h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', {}, 'Open to intros'), h('span', {}, 'their friend is nearby and they bless it → I\'d hear about it')),
    h('button', { class: 'toggle', role: 'switch', 'aria-checked': String(f.rel.via.openToIntro), 'aria-label': 'open to intros', onclick: () => patch({ via: { openToIntro: !f.rel.via.openToIntro } }) })))
  via.append(h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', {}, 'Vouch for them'), h('span', {}, 'I\'m willing to be the path from them to my friends')),
    h('button', { class: 'toggle', role: 'switch', 'aria-checked': String(f.rel.vouch), 'aria-label': 'vouch for them', onclick: () => patch({ vouch: !f.rel.vouch }) })))
  card.append(via)

  // note
  const saved = h('div', { class: 'saved' })
  const save = debounce(async v => {
    try { const { friend } = await api(`/friends/${f.id}`, { method: 'PATCH', body: { note: v } }); f.rel.note = friend.rel.note; saved.textContent = 'saved' } catch (e) { saved.textContent = 'not saved'; fail(e) }
  }, 600)
  const ta = h('textarea', { placeholder: 'Note for my agent: lives near GO, hates mornings, has a kid…', rows: 2, oninput: e => { saved.textContent = '…'; save(e.target.value) } })
  ta.value = f.rel.note || ''
  card.append(h('div', { class: 'row', style: 'display:block' }, ta, saved))
  card.querySelectorAll('details').forEach((d, i) => { if (openState[i]) d.open = true })
  return card
}

// "+ Invite a friend": a name, whether you want more of them, then a one-time link to share however you like.
function openInviteSheet() {
  const name = h('input', { type: 'text', placeholder: 'Their name', autocomplete: 'off', maxlength: 40 })
  const want = h('button', { class: 'toggle', role: 'switch', 'aria-checked': 'true', 'aria-label': 'I want to see more of them', onclick: () => want.setAttribute('aria-checked', String(want.getAttribute('aria-checked') !== 'true')) })
  const out = h('div'), err = h('div', { class: 'err small', style: 'color:var(--ember)' })
  const btn = h('button', { class: 'btn block', onclick: async () => {
    err.textContent = ''
    const n = name.value.trim(); if (!n) { err.textContent = 'a name, so the link can say who it\'s for'; name.focus(); return }
    btn.disabled = true
    try {
      const inv = await req('/api/app/invites', { method: 'POST', body: { name: n, wantMore: want.getAttribute('aria-checked') === 'true' } })
      out.replaceChildren(h('p', { class: 'small muted', style: 'margin:12px 0 0' }, `One-time link for ${inv.name}. It lasts two weeks and says ${inv.wantMore ? 'you want to see more of them' : 'you\'re on opportune'}.`), shareRow(inv.url, inv.name))
      btn.textContent = 'Another'; name.value = ''
      if (manage) loadManage().catch(() => {})
    } catch (e) { err.textContent = e.message } finally { btn.disabled = false }
  } }, 'Make the link')
  openSheet(h('h3', {}, 'Invite a friend'), h('p', { class: 'small muted', style: 'margin:0' }, 'They get a link that brings them in and connects you two. Nothing public, no directory.'),
    h('div', { class: 'lbl' }, 'Name'), name,
    h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('b', {}, 'I want to see more of them'), h('div', { class: 'small muted' }, 'the whole filter: it only nudges about people you\'ve said this about')), want),
    err, btn, out,
    h('div', { class: 'foot' }, h('button', { class: 'btn ghost small', onclick: closeSheet }, 'Done')))
  setTimeout(() => name.focus(), 50)
}
// A link with Share (where the OS has a share sheet) and Copy.
function shareRow(url, forName) {
  const text = `${session?.me?.displayName || 'A friend'} wants to see more of you on opportune: ${url}`
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast('copied') } catch { toast('long-press to copy') } }
  const share = navigator.share ? h('button', { class: 'btn small', onclick: () => navigator.share({ title: `An invite for ${forName || 'you'}`, text, url }).catch(() => {}) }, 'Share') : null
  return h('div', { class: 'copy', style: 'flex-wrap:wrap' }, h('code', {}, url), share, h('button', { class: 'btn small ghost', onclick: copy }, 'Copy'))
}

// ======================================================================
// Sources: what the agent can see. Progress card (Home + Settings) → this screen.
// ======================================================================
// Each available source → { m, sc, kind: 'connected' | 'covered' | 'available', declined }.
// Inside the shell the app itself is the location source, so locationPost is "covered" (no setup to do).
// The opportuneApp source is connected for everyone using /app (the server does that), but it only means
// something once the Android app is on a phone: in a browser without one it's a step, not a tick.
function sourceModel() {
  const { connected, available } = manage.sources
  const declined = new Set(session.declinedSources || [])
  const items = available.map(m => {
    const sc = connected.find(c => c.sourceId === m.id && c.enabled)
    let kind = sc ? 'connected' : 'available'
    if (m.id === 'opportuneApp') kind = isNative || session.pushBound ? 'connected' : 'available'
    else if (m.id === 'locationPost' && isNative) kind = 'covered'
    return { m, sc, kind, declined: kind === 'available' && declined.has(m.id) }
  })
  const counted = items.filter(i => !i.declined)
  return { items, done: counted.filter(i => i.kind !== 'available').length, total: counted.length }
}
function progressCard() {
  const { done, total } = sourceModel()
  const all = done >= total
  const go = () => show('sources')
  return h('div', { class: `card progress${all ? ' done' : ''}`, role: 'button', tabindex: '0', 'aria-label': 'sources', onclick: go, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() } } },
    h('b', {}, all ? 'All sources connected' : `${done} of ${total} sources connected`),
    h('span', { class: 'arrow' }, '›'),
    h('div', { class: 'sub' }, all ? 'calendar, location, event mail… tap to check on them' : 'the more it can see, the more it can notice. Tap to add one.'),
    h('div', { class: 'bar' }, h('i', { style: `width:${total ? Math.round(100 * done / total) : 0}%` })))
}
function renderSources() {
  const root = $('#s-sources'); root.replaceChildren()
  root.append(head('Sources', ['Settings', 'settings']), progressCard(),
    h('p', { class: 'small muted', style: 'margin:-4px 0 14px 4px' }, 'Everything stays on your node. Friends\' agents only ever get answers ("likely free Thursday"), never the data.'))
  const { items } = sourceModel()
  const on = items.filter(i => i.kind !== 'available'), todo = items.filter(i => i.kind === 'available' && !i.declined), declined = items.filter(i => i.declined)
  if (on.length) { root.append(h('h2', {}, 'Connected')); for (const i of on) root.append(sourceCard(i)) }
  if (todo.length) { root.append(h('h2', {}, on.length ? 'Add one' : 'Pick one to start')); for (const i of todo) root.append(sourceCard(i)) }
  if (declined.length) {
    const d = h('details', { style: 'border:0;margin-top:14px' }, h('summary', { class: 'small muted' }, `Not for me (${declined.length})`))
    for (const i of declined) d.append(h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', {}, i.m.name), h('span', {}, i.m.description)), h('button', { class: 'btn small ghost', onclick: () => setDeclined(i.m.id, false) }, 'Undo')))
    root.append(d)
  }
}
async function setDeclined(id, on) {
  const cur = new Set(session.declinedSources || []); on ? cur.add(id) : cur.delete(id)
  try { const r = await req('/api/app/me', { method: 'PATCH', body: { declinedSources: [...cur] } }); session.declinedSources = r.declinedSources; toast(on ? 'hidden; undo at the bottom' : 'back in the list'); renderSources(); if (state) renderHome() } catch (e) { fail(e) }
}
// non-secret config at a glance (the API redacts secrets to bullets; those are left out)
const cfgSummary = sc => Object.entries(sc?.config || {}).filter(([k, v]) => k !== 'device' && k !== 'installed' && v !== '••••••').map(([k, v]) => `${k}: ${Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : String(v)}`).join(' · ')
function sourceCard({ m, sc, kind }) {
  const card = h('div', { class: 'card src', 'data-source': m.id })
  const tag = kind === 'covered' ? h('span', { class: 'tag on' }, 'covered by this app')
    : kind === 'connected' ? (sc?.lastError ? h('span', { class: 'tag err' }, 'error') : h('span', { class: 'tag on' }, m.id === 'opportuneApp' && isNative ? 'this phone' : 'on')) : null
  card.append(h('div', { class: 'head' }, h('div', { class: 'name' }, m.name), tag))

  if (m.id === 'opportuneApp') {
    if (kind === 'connected') card.append(h('p', { class: 'desc' }, isNative ? 'Location, notifications and contacts come through this app. Nothing to paste anywhere.' : 'An Android phone is registered for push and background location.'))
    else card.append(h('p', { class: 'desc' }, 'Background location and nudges with yes/veto buttons, from your pocket. This browser already counts as the app for everything else.'),
      h('div', { class: 'foot' }, h('button', { class: 'btn small', onclick: () => bridge.openExternal('https://github.com/malcolmocean/opportune/tree/main/apps/android') }, 'Get the Android app'), declineBtn(m.id)))
    return card
  }
  if (kind === 'covered') { card.append(h('p', { class: 'desc' }, 'Your location already arrives through this app. Overland and OwnTracks are for iPhones and browsers.')); return card }

  card.append(h('p', { class: 'desc' }, m.description))
  if (kind === 'connected') {
    const summary = cfgSummary(sc)
    if (summary) card.append(h('div', { class: 'cfg' }, summary))
    if (sc.lastPollAt) card.append(h('div', { class: 'cfg' }, `last checked ${when(sc.lastPollAt)}`))
    if (sc.lastError) card.append(h('div', { class: 'err' }, sc.lastError))
    if (sc.ingestUrl) {
      const instr = (m.setup || []).find(s => s.type === 'choice')?.instructions?.[sc.config?.app]
      card.append(h('div', { class: 'cfg', style: 'margin-top:8px' }, instr ? `${instr.replace(/the URL below/i, 'this URL')}` : 'Point the app at this URL:'), copyRow(sc.ingestUrl))
    }
    card.append(h('details', {}, h('summary', {}, 'Change settings'), setupForm(m, sc)))
  } else {
    card.append(h('details', {}, h('summary', {}, 'Set up'), setupForm(m, null)), h('div', { class: 'foot' }, declineBtn(m.id)))
  }
  return card
}
const declineBtn = id => h('button', { class: 'link small', onclick: () => setDeclined(id, true) }, 'Not for me')
// The manifest's setup steps as a form. Prefilled from the (redacted) config when reconnecting; a blank secret keeps the stored one.
function setupForm(m, sc) {
  const form = h('form', { onsubmit: async e => {
    e.preventDefault()
    const config = {}
    for (const s of m.setup || []) { const el = form.elements[s.key]; if (el && el.value !== '') config[s.key] = el.value }
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true
    try {
      const r = await api('/sources', { method: 'POST', body: { sourceId: m.id, config } })
      toast(`${m.name} ${sc ? 'updated' : 'connected'}`)
      await loadManage(); renderSources(); if (state) renderHome()
      if (r.ingestUrl) $(`#s-sources [data-source="${m.id}"]`)?.scrollIntoView({ block: 'center' })
    } catch (err) { fail(err); btn.disabled = false }
  } })
  for (const s of m.setup || []) {
    if (s.type === 'install-app') continue
    const id = `${m.id}-${s.key}`, cur = sc?.config?.[s.key]
    const field = h('div', { class: 'field' }, h('label', { for: id }, s.label))
    if (s.type === 'choice') {
      const instr = h('div', { class: 'instr' })
      const sel = h('select', { name: s.key, id, onchange: () => { instr.textContent = s.instructions?.[sel.value] || ''; instr.hidden = !instr.textContent } }, (s.choices || []).filter(c => c !== 'opportune Android app').map(c => h('option', { value: c }, c)))   // the Android app has its own source now
      if (cur && s.choices?.includes(cur)) sel.value = cur
      field.append(sel, instr); setTimeout(() => sel.dispatchEvent(new Event('change')), 0)
    } else if (s.type === 'secret') {
      field.append(h('input', { type: 'password', name: s.key, id, autocomplete: 'off', placeholder: sc && cur ? 'unchanged' : '' }))
    } else {
      const inp = h('input', { type: s.type === 'url' ? 'url' : 'text', name: s.key, id, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' })
      if (cur != null) inp.value = Array.isArray(cur) ? cur.join(cur.every(x => /^https?:/.test(String(x))) ? ' ' : ', ') : String(cur)
      field.append(inp)
    }
    form.append(field)
  }
  form.append(h('div', { class: 'form-foot' }, h('button', { type: 'submit', class: 'btn small' }, sc ? 'Save' : 'Connect'), m.repo && h('a', { class: 'small', href: m.repo, target: '_blank', rel: 'noopener' }, 'about this source')))
  return form
}

// ======================================================================
// Drop-in windows, quiet hours, max nudges, digest hour (PATCH /api/manage/policy)
// ======================================================================
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
function renderWindows() {
  const root = $('#s-windows'); root.replaceChildren()
  root.append(head('Nudges & drop-ins', ['Settings', 'settings']))
  const pol = structuredClone(manage.policy)
  const hourSel = (val, onchange, label) => h('select', { class: 'auto', 'aria-label': label, onchange: e => onchange(Number(e.target.value)) }, Array.from({ length: 24 }, (_, i) => { const o = h('option', { value: i }, `${i}:00`); if (i === val) o.selected = true; return o }))
  const save = async patch => { try { const { policy } = await api('/policy', { method: 'PATCH', body: patch }); manage.policy = policy; toast('saved') } catch (e) { fail(e) } }
  const row = (title, sub, right) => h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('div', { class: 'lbl' }, h('b', {}, title), sub && h('span', {}, sub)), right)

  root.append(h('h2', {}, 'Nudges'), h('div', { class: 'card' },
    row('Quiet hours', 'no nudges between these', h('div', { class: 'inline' }, hourSel(pol.quietHours?.start ?? 23, v => { pol.quietHours = { ...pol.quietHours, start: v }; save({ quietHours: pol.quietHours }) }, 'quiet from'), '–', hourSel(pol.quietHours?.end ?? 8, v => { pol.quietHours = { ...pol.quietHours, end: v }; save({ quietHours: pol.quietHours }) }, 'quiet until'))),
    row('Max nudges per day', null, h('input', { type: 'number', min: 0, max: 50, value: pol.maxNudgesPerDay ?? 6, 'aria-label': 'max nudges per day', onchange: e => save({ maxNudgesPerDay: Number(e.target.value) }) })),
    row('Morning digest at', 'what happened, and what it stayed quiet about', hourSel(pol.digestHour ?? 9, v => save({ digestHour: v }), 'digest hour'))))

  const drop = h('div', { class: 'card' })
  const seg = h('div', { class: 'seg' }, ['open', 'ask', 'closed'].map(v => h('button', { 'aria-pressed': String(pol.dropinDefault === v), onclick: () => { pol.dropinDefault = v; save({ dropinDefault: v }).then(renderWindows) } }, v)))
  drop.append(h('div', { class: 'row', style: 'display:block' }, h('div', { class: 'lbl' }, h('b', {}, 'Drop-ins by default'), h('span', { style: 'margin-bottom:8px' }, 'open = my agent says yes within the windows below; ask = it checks with me')), seg))
  const windows = h('div')
  const drawWindows = () => {
    windows.replaceChildren()
    pol.dropinWindows.forEach((w, i) => {
      const days = h('div', { class: 'days' }, DAYS.map((d, di) => h('button', { 'aria-pressed': String(w.days.includes(di)), 'aria-label': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][di], onclick: () => { w.days = w.days.includes(di) ? w.days.filter(x => x !== di) : [...w.days, di].sort(); save({ dropinWindows: pol.dropinWindows }); drawWindows() } }, d)))
      windows.append(h('div', { class: 'window' }, days, hourSel(w.start, v => { w.start = v; save({ dropinWindows: pol.dropinWindows }) }, 'from'), '–', hourSel(w.end, v => { w.end = v; save({ dropinWindows: pol.dropinWindows }) }, 'until'),
        h('button', { class: 'x', title: 'remove', 'aria-label': 'remove window', onclick: () => { pol.dropinWindows.splice(i, 1); save({ dropinWindows: pol.dropinWindows }); drawWindows() } }, '×')))
    })
    windows.append(h('button', { class: 'btn small ghost', style: 'margin-top:8px', onclick: () => { pol.dropinWindows.push({ days: [1, 2, 3, 4, 5], start: 18, end: 22 }); save({ dropinWindows: pol.dropinWindows }); drawWindows() } }, '+ window'))
  }
  drawWindows()
  drop.append(h('div', { class: 'row', style: 'display:block' }, h('div', { class: 'lbl' }, h('b', {}, 'Drop-in windows'), h('span', {}, 'when "open" applies without you saying so')), windows))
  root.append(h('h2', {}, 'Drop-ins'), drop)
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
// Settings. Sections in the order a later onboarding pass can lift them: sources, you, permissions, people, nudges.
// ======================================================================
async function renderSettings() {
  const root = $('#s-settings'); root.replaceChildren()
  if (!isNative) perms = await browserPermissions()
  else perms = bridge.permissions() || perms
  const me = session.me
  const row = (title, sub, right, icon) => h('div', { class: 'row' }, icon && ico(icon), h('div', { class: 'lbl' }, h('b', {}, title), sub && h('span', {}, sub)), right)
  const status = (ok, onLabel = 'allowed', offLabel = 'not yet') => h('span', { class: 'small muted' }, h('i', { class: `dot ${ok ? 'on' : ok === false ? 'off' : ''}` }), ok ? onLabel : ok === false ? offLabel : 'unknown')
  const goBtn = (label, to) => h('button', { class: 'btn small ghost', onclick: () => show(to) }, label)

  // sources: the thing that makes everything else work (the people section below also needs /api/manage/me; re-render once it's here)
  if (manage) root.append(progressCard())
  else { const ph = h('div', { class: 'card progress' }, h('b', {}, 'Sources'), h('span', { class: 'arrow' }, '›'), h('div', { class: 'sub' }, 'loading…')); root.append(ph); loadManage().then(() => { if (current === 'settings') renderSettings() }).catch(() => { ph.querySelector('.sub').textContent = 'couldn\'t load'; ph.onclick = () => show('sources') }) }

  // me
  root.append(h('h2', {}, 'You'), h('div', { class: 'card' },
    row(me.displayName || '(unnamed)', null),
    row('Email', me.email ? 'for sign-in links on a new device' : 'so you can sign in on another device', me.email ? h('span', { class: 'small muted' }, me.email) : emailForm()),
    row('Timezone', 'from this device; quiet hours and digests follow it', h('span', { class: 'small muted' }, me.tz)),
    storyRow(),
    row('Node', null, h('code', {}, new URL(me.nodeUrl || location.origin).host))))

  // permissions
  const permCard = h('div', { class: 'card' })
  if (isNative) {
    const p = perms || {}
    const ask = (label, fn) => h('button', { class: 'btn small ghost', onclick: () => { fn(); toast('answer the system prompt') } }, label)
    // notifications === false also covers "turned off in system settings"; requestNotifications() then opens that page
    const notif = p.notifications ? status(true) : h('span', { style: 'display:flex;align-items:center;gap:8px' }, h('span', { class: 'small muted' }, h('i', { class: 'dot off' }), 'off'), ask(p.notifications === false ? 'Open settings' : 'Allow', bridge.requestNotifications))
    permCard.append(
      row('Notifications', 'nudges as heads-up notifications with yes/veto', notif, 'bell'),
      row('Location', 'so it notices you\'re near a friend', p.location ? status(true) : ask('Allow', bridge.requestLocation), 'pin'),
      row('Background location', '"all the time": the whole point, while the phone\'s in your pocket', p.backgroundLocation ? status(true) : ask('Allow', bridge.requestLocation), 'pocket'),
      row('Physical activity', 'walking vs driving, so a drive-by isn\'t a drop-in', p.activity ? status(true) : ask('Allow', bridge.requestLocation), 'walk'),
      row('Share contacts', `names on guest lists get recognised. ${session.contactsSynced ? `${session.contactsSynced} synced.` : 'Synced daily, stays on your node.'}`,
        h('button', { class: 'toggle', role: 'switch', 'aria-checked': String(!!p.contacts), 'aria-label': 'share contacts', onclick: () => {
          if (p.contacts) { bridge.stopContacts(); toast('contacts sharing off'); perms = { ...p, contacts: false }; renderSettings() }
          else { bridge.requestContacts(); toast('answer the system prompt') }
        } }), 'people'),
      row('Push', null, status(session.pushBound, 'registered', 'waiting for the app to register'), 'push'))
  } else {
    permCard.append(
      row('Location (this browser)', 'one-off fixes for "set home" and "heading over"', perms?.location ? status(true) : h('button', { class: 'btn small ghost', onclick: async () => { try { await currentLocation(); renderSettings() } catch (e) { fail(e) } } }, 'Allow'), 'pin'),
      row('Background location', 'browsers can\'t. The Android app does it; on iPhone, Overland posts to your node. Both are under Sources.', goBtn('Sources', 'sources'), 'pocket'),
      row('Push', 'nudges arrive in the Android app (or Telegram, if linked)', status(session.pushBound || session.telegramLinked, session.pushBound ? 'app registered' : 'via Telegram', 'nowhere yet'), 'push'))
  }
  root.append(h('h2', {}, isNative ? 'Permissions' : 'This device'), permCard)

  // people
  const fs = manage?.friends || [], onF = fs.filter(f => !f.shadow)
  root.append(h('h2', {}, 'People'), h('div', { class: 'card' },
    row(onF.length ? `${onF.length} ${onF.length === 1 ? 'person' : 'people'}` : 'No one yet', onF.length ? `★ ${onF.filter(f => f.rel.wantMore).length} you want more of · tiers, grants and notes` : 'invite someone to get started', goBtn('People', 'people')),
    row('Invite a friend', 'a one-time link that says you want to see more of them', h('button', { class: 'btn small', onclick: openInviteSheet }, '+ Invite'))))

  // nudges
  root.append(h('h2', {}, 'Nudges'), h('div', { class: 'card' },
    row('Drop-in windows & quiet hours', 'when "open" applies by default; max nudges a day; digest time', goBtn('Open', 'windows')),
    row('The judge\'s calls', 'every nudge and every time it stayed quiet; rate them', goBtn('Review', 'review'))))

  // telegram: optional, never the default
  root.append(h('h2', {}, 'Optional'), h('div', { class: 'card' },
    row('Telegram', session.telegramLinked ? 'linked: nudges and chat with your agent reach you there too' : 'chat with your agent in Telegram ("who\'s around tonight?"). Everything else is here in the app.',
      session.telegramLinked ? status(true, 'linked') : (session.telegramLink || ls.get('opportune.telegramLink'))
        ? h('button', { class: 'btn small ghost', onclick: () => bridge.openExternal(session.telegramLink || ls.get('opportune.telegramLink')) }, 'Link')
        : h('span', { class: 'small muted' }, 'no bot on this node'))))

  // appearance
  const seg = h('div', { class: 'seg' }, ['system', 'dark', 'light'].map(v => h('button', { 'aria-pressed': String(themePref() === v), onclick: () => { ls.set('opportune.theme', v === 'system' ? null : v); applyTheme(); renderSettings() } }, v)))
  root.append(h('h2', {}, 'Appearance'), h('div', { class: 'card' }, seg))

  // sign out
  root.append(h('div', { class: 'card', style: 'margin-top:20px' },
    row('Sign out', isNative ? 'forgets this sign-in and stops sharing location from this phone' : 'forgets the token in this browser', h('button', { class: 'btn small ghost', onclick: signOut }, 'Sign out'))))
}
// Settings → You → "What you're generally up for": state.me.story, plain text friends and agents read. ingest({ story }); '' clears.
const STORY_HINT = 'Usually free weeknights after 8, love a walk, hate phone calls…'
function storyRow() {
  const story = state?.me?.story || ''
  const sub = h('span', { class: story ? 'story' : 'story muted' }, story || STORY_HINT)
  return h('div', { class: 'row', role: 'button', tabindex: '0', style: 'cursor:pointer', onclick: openStorySheet, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStorySheet() } } },
    h('div', { class: 'lbl' }, h('b', {}, 'What you\'re generally up for'), sub), h('span', { class: 'arrow muted' }, '›'))
}
function openStorySheet() {
  const ta = h('textarea', { rows: 5, maxlength: 2000, placeholder: STORY_HINT, 'aria-label': 'what you\'re generally up for' })
  ta.value = state?.me?.story || ''
  const btn = h('button', { class: 'btn block', onclick: async () => {
    btn.disabled = true
    try { await ingest({ story: ta.value.trim() }); closeSheet(); toast('saved'); await refresh(); if (current === 'settings') renderSettings() } catch (e) { fail(e); btn.disabled = false }
  } }, 'Save')
  openSheet(h('h3', {}, 'What you\'re generally up for'), h('p', { class: 'small muted', style: 'margin:0' }, 'Plain text, in your words: when you\'re usually free, what you\'re up for, what you\'d rather not. Friends can read it, and your agent weighs it.'),
    h('div', { class: 'lbl' }, 'Your story'), ta, btn,
    h('div', { class: 'foot' }, h('button', { class: 'btn ghost small', onclick: closeSheet }, 'Cancel')))
  setTimeout(() => ta.focus(), 50)
}
// Settings → You → Email: POST /api/app/email { email } sends a verification link; the address shows once it's confirmed.
function emailForm() {
  const inp = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email', inputmode: 'email', 'aria-label': 'email', style: 'min-height:40px;padding:6px 12px;border-radius:10px' })
  const btn = h('button', { class: 'btn small ghost', onclick: async () => {
    const v = inp.value.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return toast('that doesn\'t look like an email address')
    btn.disabled = true
    try { await req('/api/app/email', { method: 'POST', body: { email: v } }); toast(`check ${v} for a verification link`) }
    catch (e) { toast(e.status === 404 ? 'email sign-in isn\'t set up on this node yet' : e.message) } finally { btn.disabled = false }
  } }, 'Add')
  return h('div', { style: 'display:flex;gap:6px;align-items:center;max-width:60%' }, inp, btn)
}
// Small line icons for settings rows, same stroke style as the tab bar.
const ICONS = {
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
  pocket: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10 18h4"/><path d="M12 7.5s-2 2-2 3.6a2 2 0 0 0 4 0c0-1.6-2-3.6-2-3.6z"/>',
  walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2-6-2-2 1-5 3 1 2 3"/><path d="M11 8l-3 3 1 3"/><path d="M14 13l2 2 1 6"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.2"/><path d="M15.5 19a4.5 4.5 0 0 1 5.5-4"/>',
  push: '<path d="M4 12a8 8 0 0 1 16 0"/><path d="M7 12a5 5 0 0 1 10 0"/><circle cx="12" cy="12" r="1.5"/><path d="M12 13.5V21"/>',
}
const ico = name => h('span', { class: 'ico', 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24">${ICONS[name] || ''}</svg>` })
function copyRow(text) {
  return h('div', { class: 'copy' }, h('code', {}, text), h('button', { class: 'btn small ghost', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('copied') } catch { toast('long-press to copy') } } }, 'Copy'))
}
function signOut(msg) {
  if (!msg && !confirm('Sign out on this device?')) return
  for (const k of [KEY, 'opportune.telegramLink', 'opportune.hello', 'opportune.porch.total']) ls.set(k, null)
  ls.set('opportune.signedOut', '1')
  token = null; session = null; state = null; manage = null; extraNudges = []
  clearInterval(refreshT)
  if (isNative) bridge.signOut()   // clears the ingest URL and stops the location service
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
    if (manage) loadManage().catch(() => {})   // keep source status / people fresh for the next time those screens open
    renderHome(); renderNudges()
  } catch (e) {
    if (e.status === 401) return signOut('That link isn\'t valid any more. Sign in again.')
    if (!state) throw e
    toast('offline? couldn\'t refresh')
  }
}
async function start() {
  session = await req('/api/app/session', { method: 'POST', body: { device: bridge.deviceInfo(), tz: deviceTz() } })
  if (isNative && !bridge.ingestUrl()) bridge.setIngestUrl(session.ingestUrl)
  perms = isNative ? bridge.permissions() : await browserPermissions()
  loadManage().then(() => { if (state && current === 'home') renderHome() }).catch(() => {})   // the sources progress card on Home
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
const claimCode = new URL(location.href).searchParams.get('claim')
if (claimCode) {
  // a sign-in link (email) or a code someone pasted into the URL: claim it, then carry on as that person
  const u = new URL(location.href); u.searchParams.delete('claim'); history.replaceState(null, '', u.pathname + u.search + u.hash)
  try { await claim(claimCode.trim()) } catch (e) { renderOnboard(e.status === 404 ? 'That sign-in link has been used or expired. Ask for a fresh one.' : e.message) }
} else {
  token = readToken()
  if (!token) renderOnboard()
  else {
    try { await start() } catch (e) {
      if (e.status === 401) signOut('That link isn\'t valid any more. Sign in again.')
      else { $('#s-onboard').hidden = false; $('#s-onboard').replaceChildren(h('div', { class: 'gate' }, h('h1', {}, 'Couldn\'t reach your node'), h('p', { class: 'muted' }, e.message), h('button', { class: 'btn', onclick: () => location.reload() }, 'Try again'))) }
    }
  }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state) refresh().then(() => { if (current === 'map') renderMap() }).catch(() => {}) })
// foreground, or a nudge answered from a notification action while we're open: state + nudges again
onResume(() => { if (state) refresh().then(() => { if (current === 'map') renderMap() }).catch(() => {}) })
