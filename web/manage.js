import { tokenFromPage, fetchMap, mountMap } from '/web/map.js'

// ---------- state & api ----------
const token = tokenFromPage()
let state = null
let mapHandle = null

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

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/api/manage${path}`, { method, headers: { 'x-manage-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status })
  return data
}

let toastT
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true }, 1800)
}
const fail = e => toast(e.message || 'something went wrong')

const ago = m => (m == null ? '' : m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`)
const when = iso => {
  const d = new Date(iso), diff = (Date.now() - d) / 60e3
  if (diff < 60) return `${Math.max(0, Math.round(diff))}m ago`
  if (diff < 24 * 60) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }

// ---------- tabs ----------
function showTab(name) {
  for (const b of document.querySelectorAll('#tabs [role=tab]')) b.setAttribute('aria-selected', b.dataset.tab === name)
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== name
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`)
  if (name === 'map') renderMap()
  else if (mapHandle) setTimeout(() => mapHandle.map.invalidateSize(), 0)
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[role=tab]'); if (b) showTab(b.dataset.tab) })
const TABS = ['people', 'sources', 'review', 'map', 'settings']
const tabFromHash = () => (TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'people')
window.addEventListener('hashchange', () => { if (state) showTab(tabFromHash()) })

// ---------- people ----------
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
  const root = $('#p-people'); root.replaceChildren()
  const fs = state.friends
  if (!fs.length) return root.append(h('div', { class: 'empty' }, 'No one yet. Ask your agent for an invite link: ', h('code', {}, '/invite Name')))
  const on = fs.filter(f => !f.shadow), shadow = fs.filter(f => f.shadow)
  const stars = on.filter(f => f.rel.wantMore).length
  root.append(h('div', { class: 'group-title' }, h('h2', {}, 'People'), h('span', { class: 'small' }, `${on.length} · ★ ${stars} want more`)))
  for (const f of on) root.append(friendCard(f))
  if (shadow.length) {
    root.append(h('div', { class: 'group-title' }, h('h2', {}, 'Not on opportune yet'), h('span', { class: 'small' }, 'seen via Maps sharing')))
    for (const f of shadow) root.append(friendCard(f))
  }
}

function friendCard(f, openState = []) {
  const card = h('div', { class: 'card', 'data-id': f.id })
  const patch = async (body, okMsg) => {
    try {
      const { friend } = await api(`/friends/${f.id}`, { method: 'PATCH', body })
      Object.assign(f, friend)
      // re-render in place, keeping whichever sections were expanded
      card.replaceWith(friendCard(f, [...card.querySelectorAll('details')].map(d => d.open)))
      if (okMsg) toast(okMsg)
    } catch (e) { fail(e) }
  }
  const star = h('button', { class: 'star', 'aria-pressed': String(f.rel.wantMore), title: 'I want to see more of them', onclick: () => patch({ wantMore: !f.rel.wantMore }) }, '★')
  const meta = h('div', { class: 'meta' })
  if (f.shadow) meta.append(h('span', { class: 'badge' }, 'not on opportune'))
  if (f.remote) meta.append(h('span', { class: 'badge' }, 'other node'))
  if (f.lastLocationAgeMin != null) meta.append(h('span', { class: 'badge live' }, `● seen ${ago(f.lastLocationAgeMin)}`))
  if (f.theirs?.wantMore) meta.append(h('span', { class: 'badge' }, 'wants more of you'))
  card.append(h('div', { class: 'card-head' }, h('div', { class: 'name' }, f.displayName || '(unnamed)', ' ', meta), star))

  if (f.shadow) {
    const out = h('div')
    card.append(h('p', { class: 'small muted' }, 'They share their location with you in Google Maps but aren\'t on opportune. An invite says you want to see more of them.'),
      h('button', { class: 'btn small', onclick: async e => {
        e.target.disabled = true
        try { const { url } = await api(`/friends/${f.id}/invite-link`, { method: 'POST' }); out.replaceChildren(copyRow(url)) } catch (err) { fail(err) } finally { e.target.disabled = false }
      } }, 'Make invite link'), out)
  }

  // tier
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'tier' }, TIERS.map(t => h('button', { 'aria-pressed': String(f.rel.tier === t), onclick: () => f.rel.tier !== t && patch({ tier: t }) }, t)))
  card.append(h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', {}, 'Tier'), h('span', {}, 'sets the default grants below'))), seg)

  // travel
  const out = h('output', {}, TRAVEL[f.rel.travel ?? 1])
  const range = h('input', { type: 'range', min: 0, max: 3, step: 1, value: f.rel.travel ?? 1, oninput: e => { out.textContent = TRAVEL[e.target.value] }, onchange: e => patch({ travel: Number(e.target.value) }) })
  card.append(h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', {}, 'How far out of my way'), h('span', {}, 'private: they never see this'))), h('div', { class: 'slider' }, range, out))

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
    card.append(h('details', {}, h('summary', {}, `What ${f.displayName || 'they'} lets me do`), h('div', { class: 'chips' }, chips.length ? chips : h('span', { class: 'chip' }, 'nothing yet'), h('span', { class: 'chip' }, `they rate me ${f.theirs.tier}`))))
  }

  // via
  const via = h('details', {}, h('summary', {}, `Friends of ${f.displayName || 'them'}`))
  const viaSeg = h('div', { class: 'seg' }, [[null, 'nothing'], ['acquaintance', 'acquaintance'], ['friend', 'friend']].map(([v, l]) => h('button', { 'aria-pressed': String((f.rel.via.tier || null) === v), onclick: () => patch({ via: { tier: v } }) }, l)))
  via.append(h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', {}, 'Extend to people they vouch for'), h('span', {}, 'what their friends get from me before we\'ve met'))), viaSeg)
  via.append(h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', {}, 'Open to intros'), h('span', {}, 'their friend is nearby and they bless it → I\'d hear about it')),
    h('button', { class: 'toggle', role: 'switch', 'aria-checked': String(f.rel.via.openToIntro), onclick: () => patch({ via: { openToIntro: !f.rel.via.openToIntro } }) })))
  via.append(h('div', { class: 'row' }, h('div', { class: 'lbl' }, h('b', {}, 'Vouch for them'), h('span', {}, 'I\'m willing to be the path from them to my friends')),
    h('button', { class: 'toggle', role: 'switch', 'aria-checked': String(f.rel.vouch), onclick: () => patch({ vouch: !f.rel.vouch }) })))
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

function copyRow(text) {
  return h('div', { class: 'copy' }, h('code', {}, text), h('button', { class: 'btn small ghost', onclick: async () => {
    try { await navigator.clipboard.writeText(text); toast('copied') } catch { toast('long-press to copy') }
  } }, 'Copy'))
}

// ---------- sources ----------
function renderSources() {
  const root = $('#p-sources'); root.replaceChildren()
  const { connected, available } = state.sources
  root.append(h('h2', {}, 'Connected'))
  if (!connected.length) root.append(h('p', { class: 'muted small' }, 'Nothing yet. Each source below is one step.'))
  for (const sc of connected) {
    const cfg = Object.entries(sc.config || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length + ' item(s)' : String(v)}`).join(' · ')
    root.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', { class: 'name' }, sc.name), sc.lastError ? h('span', { class: 'badge', style: 'color:var(--warm)' }, 'error') : h('span', { class: 'badge live' }, 'on')),
      cfg && h('div', { class: 'small muted' }, cfg),
      sc.lastPollAt && h('div', { class: 'small muted' }, `last poll ${when(sc.lastPollAt)}`),
      sc.lastError && h('div', { class: 'small', style: 'color:var(--warm)' }, sc.lastError),
      sc.ingestUrl && h('div', {}, h('div', { class: 'small muted', style: 'margin-top:8px' }, 'Paste this into the app:'), copyRow(sc.ingestUrl))))
  }
  root.append(h('h2', {}, 'Available'))
  for (const m of available) root.append(sourceCard(m, connected.some(c => c.sourceId === m.id)))
}

function sourceCard(m, already) {
  const form = h('form', { class: 'setup-form', onsubmit: async e => {
    e.preventDefault()
    const config = {}
    for (const s of m.setup || []) { const el = form.elements[s.key]; if (el && el.value !== '') config[s.key] = el.value }
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true
    try {
      const r = await api('/sources', { method: 'POST', body: { sourceId: m.id, config } })
      toast(`${m.name} connected`)
      await load()
      showTab('sources')
      if (r.ingestUrl) { const card = $(`#p-sources [data-source="${m.id}"]`); card?.scrollIntoView({ block: 'center' }) }
    } catch (err) { fail(err) } finally { btn.disabled = false }
  } })
  for (const s of m.setup || []) {
    const field = h('div', { class: 'field' }, h('label', { for: `${m.id}-${s.key}` }, s.label))
    if (s.type === 'choice') {
      const instr = h('div', { class: 'instructions' })
      const sel = h('select', { name: s.key, id: `${m.id}-${s.key}`, onchange: () => { instr.textContent = s.instructions?.[sel.value] || ''; instr.hidden = !instr.textContent } }, (s.choices || []).map(c => h('option', { value: c }, c)))
      field.append(sel, instr); setTimeout(() => sel.dispatchEvent(new Event('change')), 0)
    } else if (s.type === 'install-app') {
      field.append(h('p', { class: 'small muted' }, 'Connect first, then paste the URL you get into the app.'))
    } else {
      field.append(h('input', { type: s.type === 'secret' ? 'password' : s.type === 'url' ? 'url' : 'text', name: s.key, id: `${m.id}-${s.key}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }))
    }
    form.append(field)
  }
  form.append(h('div', { style: 'margin-top:10px;display:flex;gap:8px;align-items:center' }, h('button', { type: 'submit', class: 'btn small' }, already ? 'Reconnect' : 'Connect'), m.repo && h('a', { class: 'small', href: m.repo, target: '_blank', rel: 'noopener' }, 'about')))
  return h('div', { class: 'card', 'data-source': m.id },
    h('div', { class: 'card-head' }, h('div', { class: 'name' }, m.name), already && h('span', { class: 'badge live' }, '✓ connected')),
    h('p', { class: 'small muted', style: 'margin:4px 0 8px' }, m.description),
    h('details', {}, h('summary', {}, already ? 'Change settings' : 'Set up'), form))
}

// ---------- review ----------
let quietOnly = false
function renderReview() {
  const root = $('#p-review'); root.replaceChildren()
  const cb = h('input', { type: 'checkbox', id: 'quietOnly', onchange: e => { quietOnly = e.target.checked; renderReview() } })
  cb.checked = quietOnly
  root.append(h('label', { class: 'filter' }, cb, 'only the quiet ones (things it decided not to tell me)'))
  const list = state.decisions.filter(d => !quietOnly || d.verdict === 'suppress')
  if (!list.length) return root.append(h('div', { class: 'empty' }, state.decisions.length ? 'Nothing quiet lately.' : 'No judgement calls yet. They show up here, including the ones it keeps to itself.'))
  for (const d of list) root.append(decisionCard(d))
}

function decisionCard(d) {
  const card = h('div', { class: 'card decision' })
  const rate = async (rating) => {
    let note
    if (rating === 'bad' && d.verdict !== 'suppress') note = prompt('Why was this a bad call? (optional)') || undefined
    try { const r = await api(`/decisions/${d.id}/rate`, { method: 'POST', body: { rating, note } }); Object.assign(d, r.decision); card.replaceWith(decisionCard(d)); toast(rating === 'good' ? 'thanks' : 'noted, adjusting') } catch (e) { fail(e) }
  }
  const icon = d.verdict === 'suppress' ? '🤫' : d.verdict === 'ask' ? '🙋' : '🔔'
  const nudge = d.nudgeId && state.nudges.find(n => n.id === d.nudgeId)
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

// ---------- map ----------
async function renderMap() {
  const el = $('#mapEl'), legend = $('#mapLegend')
  try {
    const data = await fetchMap(token)
    if (!mapHandle) mapHandle = await mountMap(el, data, { legendEl: legend })
    else { mapHandle.update(data); mapHandle.map.invalidateSize() }
  } catch (e) { legend.textContent = e.message }
}
setInterval(() => { if (mapHandle && !$('#p-map').hidden) renderMap() }, 60e3)

// ---------- settings ----------
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
function renderSettings() {
  const root = $('#p-settings'); root.replaceChildren()
  const pol = structuredClone(state.policy)
  const hourSel = (val, onchange) => h('select', { style: 'width:auto', onchange: e => onchange(Number(e.target.value)) }, Array.from({ length: 24 }, (_, i) => { const o = h('option', { value: i }, `${i}:00`); if (i === val) o.selected = true; return o }))
  const save = async (patch) => { try { const { policy } = await api('/policy', { method: 'PATCH', body: patch }); state.policy = policy; toast('saved') } catch (e) { fail(e) } }

  const card = h('div', { class: 'card' })
  card.append(h('div', { class: 'field' }, h('label', {}, 'Quiet hours', h('span', {}, 'no nudges between these')),
    h('div', { class: 'inline' }, hourSel(pol.quietHours?.start ?? 23, v => { pol.quietHours = { ...pol.quietHours, start: v }; save({ quietHours: pol.quietHours }) }), '–', hourSel(pol.quietHours?.end ?? 8, v => { pol.quietHours = { ...pol.quietHours, end: v }; save({ quietHours: pol.quietHours }) }))))
  card.append(h('div', { class: 'field' }, h('label', {}, 'Max nudges per day'),
    h('input', { type: 'number', min: 0, max: 50, value: pol.maxNudgesPerDay ?? 6, onchange: e => save({ maxNudgesPerDay: Number(e.target.value) }) })))
  card.append(h('div', { class: 'field' }, h('label', {}, 'Morning digest at', h('span', {}, 'what happened, and what it stayed quiet about')),
    hourSel(pol.digestHour ?? 9, v => save({ digestHour: v }))))
  root.append(h('h2', {}, 'Nudges'), card)

  const drop = h('div', { class: 'card' })
  const seg = h('div', { class: 'seg' }, ['open', 'ask', 'closed'].map(v => h('button', { 'aria-pressed': String(pol.dropinDefault === v), onclick: () => { pol.dropinDefault = v; save({ dropinDefault: v }).then(renderSettings) } }, v)))
  drop.append(h('div', { class: 'field', style: 'flex-direction:column;align-items:stretch' }, h('label', {}, 'Drop-ins by default', h('span', {}, 'open = my agent says yes within the windows below; ask = it checks with me')), seg))
  const windows = h('div')
  const drawWindows = () => {
    windows.replaceChildren()
    pol.dropinWindows.forEach((w, i) => {
      const days = h('div', { class: 'days' }, DAYS.map((d, di) => h('button', { 'aria-pressed': String(w.days.includes(di)), onclick: () => { w.days = w.days.includes(di) ? w.days.filter(x => x !== di) : [...w.days, di].sort(); save({ dropinWindows: pol.dropinWindows }); drawWindows() } }, d)))
      windows.append(h('div', { class: 'window' }, days, hourSel(w.start, v => { w.start = v; save({ dropinWindows: pol.dropinWindows }) }), '–', hourSel(w.end, v => { w.end = v; save({ dropinWindows: pol.dropinWindows }) }),
        h('button', { class: 'x', title: 'remove', onclick: () => { pol.dropinWindows.splice(i, 1); save({ dropinWindows: pol.dropinWindows }); drawWindows() } }, '×')))
    })
    windows.append(h('button', { class: 'btn small ghost', style: 'margin-top:8px', onclick: () => { pol.dropinWindows.push({ days: [1, 2, 3, 4, 5], start: 18, end: 22 }); save({ dropinWindows: pol.dropinWindows }); drawWindows() } }, '+ window'))
  }
  drawWindows()
  drop.append(h('div', { class: 'field', style: 'flex-direction:column;align-items:stretch' }, h('label', {}, 'Drop-in windows', h('span', {}, 'when "open" applies')), windows))
  root.append(h('h2', {}, 'Drop-ins'), drop)

  const about = h('div', { class: 'card' })
  about.append(h('div', { class: 'field' }, h('label', {}, 'Contacts synced', h('span', {}, 'from the Android app; used to recognise names on guest lists')), h('b', {}, String(state.person.contactsSynced ?? 0))))
  about.append(h('div', { class: 'field' }, h('label', {}, 'Timezone'), h('span', { class: 'muted' }, state.person.tz)))
  about.append(h('div', { class: 'field' }, h('label', {}, 'Node'), h('code', {}, state.person.nodeUrl)))
  about.append(h('div', { class: 'field' }, h('label', {}, 'Full-screen map'), h('a', { href: `/web/map?token=${encodeURIComponent(token)}` }, 'open')))
  root.append(h('h2', {}, 'About me'), about)
}

// ---------- boot ----------
async function load() {
  state = await api('/me')
  $('#who').textContent = state.person.displayName || ''
  renderPeople(); renderSources(); renderReview(); renderSettings()
}
const gate = (msg) => { $('#gateMsg').textContent = msg; $('#gate').hidden = false }
if (!token) gate('This page needs a link from your agent. Ask it for /manage in Telegram.')
else {
  try {
    await load()
    showTab(tabFromHash())
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load().then(() => { if (!$('#p-map').hidden) renderMap() }).catch(() => {}) })
  } catch (e) {
    try { localStorage.removeItem('opportune.token') } catch {}
    gate(e.status === 401 ? 'That link is not valid any more. Ask your agent for a fresh one (/manage).' : e.message)
  }
}
