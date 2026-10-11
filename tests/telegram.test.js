import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCallback, nudgeCallbackData, resolveNudgeAction, CALLBACK_MAX_BYTES, escapeMdV2, reviewMessage, setupPrompt, applySetupStep, acceptReply, HELP_TEXT } from '../channels/telegram/index.js'

test('parseCallback keeps colons in the action key', () => {
  assert.deepEqual(parseCallback('n:nudge1:grant:autoYesDropin:friend9'), { t: 'n', a: 'nudge1', b: 'grant:autoYesDropin:friend9' })
  assert.deepEqual(parseCallback('wish:dec1:nudge1'), { t: 'wish', a: 'dec1', b: 'nudge1' })
  assert.deepEqual(parseCallback('pl:open'), { t: 'pl', a: 'open', b: '' })
  assert.deepEqual(parseCallback(''), { t: '', a: undefined, b: '' })
})

test('nudgeCallbackData: short keys inline, wish keys carry the nudge id', () => {
  const stored = []
  const store = (k, v) => stored.push([k, v])
  assert.equal(nudgeCallbackData('n1', 'yes', store), 'n:n1:yes')
  assert.equal(nudgeCallbackData('n1', 'grant:autoYesDropin:f1', store), 'n:n1:grant:autoYesDropin:f1')
  assert.equal(nudgeCallbackData('n1', 'wish:d1', store), 'wish:d1:n1')
  assert.equal(stored.length, 0)
})

test('nudgeCallbackData: keys over 64 bytes are parked in kv and resolved on tap', () => {
  const kv = new Map()
  const store = (k, v) => kv.set(k, v), lookup = k => kv.get(k)
  const nudgeId = 'a'.repeat(20), fromId = 'b'.repeat(40)
  const key = `grant:autoYesDropin:${fromId}`
  const d = nudgeCallbackData(nudgeId, key, store)
  assert.ok(Buffer.byteLength(d) <= CALLBACK_MAX_BYTES, `${d} too long`)
  assert.ok(d.startsWith(`n:${nudgeId}:k:`))
  assert.equal(kv.size, 1)
  const { t, a, b } = parseCallback(d)
  assert.equal(t, 'n'); assert.equal(a, nudgeId)
  assert.equal(resolveNudgeAction(b, lookup), key)
  assert.equal(resolveNudgeAction('yes', lookup), 'yes')
  assert.equal(resolveNudgeAction('k:missing', lookup), null)
})

test('nudgeCallbackData: an oversize wish key also goes through kv', () => {
  const kv = new Map()
  const d = nudgeCallbackData('n'.repeat(30), `wish:${'d'.repeat(40)}`, (k, v) => kv.set(k, v))
  assert.ok(Buffer.byteLength(d) <= CALLBACK_MAX_BYTES)
  const { b } = parseCallback(d)
  assert.equal(resolveNudgeAction(b, k => kv.get(k)), `wish:${'d'.repeat(40)}`)
})

test('escapeMdV2 escapes every MarkdownV2 special character', () => {
  assert.equal(escapeMdV2('a_b*c[d](e)~f`g>h#i+j-k=l|m{n}o.p!q\\r'), 'a\\_b\\*c\\[d\\]\\(e\\)\\~f\\`g\\>h\\#i\\+j\\-k\\=l\\|m\\{n\\}o\\.p\\!q\\\\r')
  assert.equal(escapeMdV2('plain words'), 'plain words')
  assert.equal(escapeMdV2(null), '')
})

test('reviewMessage: plain text, reasoning on its own line, verdict-appropriate buttons', () => {
  const sup = reviewMessage({ id: 'd1', verdict: 'suppress', summary: 'Jess_is a *block* away', reasoning: 'quiet hours [late]', rating: null })
  assert.equal(sup.text, '🤫 Jess_is a *block* away\n— quiet hours [late]')
  assert.deepEqual(sup.buttons, [{ label: '👍 right to stay quiet', data: 'rate:d1:good' }, { label: '👎 should have told me', data: 'rate:d1:bad' }])
  const nud = reviewMessage({ id: 'd2', verdict: 'nudge', summary: 'Both free Thursday', reasoning: 'time-sensitive', rating: 'good' })
  assert.equal(nud.text, '🔔 Both free Thursday\n— time-sensitive\n(rated good)')
  assert.deepEqual(nud.buttons, [{ label: '👍 good call', data: 'rate:d2:good' }, { label: "👎 shouldn't have bugged me", data: 'rate:d2:bad' }])
  assert.equal(reviewMessage({ id: 'd3', verdict: 'nudge', summary: null, reasoning: null }).text, '🔔 (no summary)')
})

test('setupPrompt mentions default and skip', () => {
  assert.equal(setupPrompt({ key: 'x', type: 'text', label: 'Thing' }), 'Thing')
  assert.equal(setupPrompt({ key: 'x', type: 'text', label: 'Thing', optional: true }), "Thing (or 'skip')")
  assert.equal(setupPrompt({ key: 'x', type: 'url', label: 'Server', default: 'https://a.example', optional: true }), "Server (default: https://a.example) (or 'skip')")
  // label that already names the default isn't repeated
  assert.equal(setupPrompt({ key: 'x', type: 'url', label: 'Server (default https://a.example)', default: 'https://a.example' }), 'Server (default https://a.example)')
})

test('applySetupStep: optional steps accept skip / - / none and leave the key unset', () => {
  const step = { key: 'rooms', type: 'text', label: 'Rooms', optional: true, parse: v => v.split(',') }
  for (const t of ['skip', 'SKIP', '-', 'none', '', null]) assert.deepEqual(applySetupStep(step, t), { ok: true, unset: true }, `text=${t}`)
  assert.deepEqual(applySetupStep(step, 'a,b'), { ok: true, value: ['a', 'b'] })
})

test('applySetupStep: required steps refuse skip and re-prompt', () => {
  const step = { key: 'email', type: 'text', label: 'Your email' }
  const r = applySetupStep(step, 'skip')
  assert.equal(r.ok, false); assert.match(r.error, /needed/); assert.match(r.error, /Your email/)
  assert.deepEqual(applySetupStep(step, '  me@x.io '), { ok: true, value: 'me@x.io' })
})

test('applySetupStep: a throwing parse() re-asks with the error instead of propagating', () => {
  const step = { key: 'url', type: 'url', label: 'Server URL', parse: v => { if (!v.startsWith('https://')) throw new Error('must be https'); return v } }
  const r = applySetupStep(step, 'http://x')
  assert.equal(r.ok, false); assert.match(r.error, /must be https/); assert.match(r.error, /Server URL/)
  assert.deepEqual(applySetupStep(step, 'https://x'), { ok: true, value: 'https://x' })
})

test('applySetupStep: choice must match; install-app stores nothing', () => {
  const ch = { key: 'app', type: 'choice', label: 'Which app?', choices: ['OwnTracks', 'Overland'] }
  assert.deepEqual(applySetupStep(ch, 'OwnTracks'), { ok: true, value: 'OwnTracks' })
  assert.equal(applySetupStep(ch, 'skip').ok, false)
  assert.deepEqual(applySetupStep({ key: 'installed', type: 'install-app', label: 'Install it' }, null), { ok: true, unset: true })
})

test('acceptReply names the inviter and their node\'s sources', () => {
  const msg = acceptReply({ display_name: 'Eileen', node_url: 'https://op.eileen.example' }, { sources: [{ id: 'icsCalendar', name: 'Calendar (ICS)' }, { id: 'x' }] })
  assert.match(msg, /Linked with Eileen \(on https:\/\/op\.eileen\.example\)/)
  assert.match(msg, /Calendar \(ICS\), x/)
  assert.match(acceptReply({ display_name: 'Bo' }, {}), /nothing listed yet/)
})

test('HELP_TEXT lists every command', () => {
  for (const cmd of ['/whosaround', '/porchlight', '/invite', '/accept', '/friends', '/sources', '/home', '/phone', '/review', '/manage', '/me']) assert.ok(HELP_TEXT.includes(cmd), cmd)
})
