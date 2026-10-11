import { randomInt } from 'node:crypto'
import { normEmail } from '../../core/people.js'
import { personForToken } from '../../web/routes.js'

// Email: magic-link sign-in so nobody has to go through Telegram, plus nudges as plain-text mail
// for people who have no push and no Telegram. Sends through Resend's HTTP API (no SDK).
//
// Sign-in reuses the app-link code that Telegram already hands out: the emailed link is
// `${NODE_URL}/app?claim=CODE` and the existing POST /app/claim turns CODE into the app's
// credential bundle. Verification (binding a new address to a signed-in person) goes through
// GET /app/email/verify/CODE, which binds the identity and then redirects to the same claim URL.
//
// kv: applink:<CODE>     → { id: <opportuneApp source id>, exp, verifyEmail? }   (consumed by /app/claim)
//     emailverify:<CODE> → { personId, email, exp }                             (consumed by /app/email/verify)
//
// Env: RESEND_API_KEY (unset → channel disabled, routes answer 503), EMAIL_FROM ("opportune <hello@opportune.club>").

const RESEND_URL = 'https://api.resend.com/emails'
const CODE_TTL_MS = 15 * 60e3
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'   // no 0/O, 1/I: people type these
const LIMITS = { address: [3, 10 * 60e3], ip: [10, 10 * 60e3] }   // [count, window]
const DISABLED = { error: 'email sign-in is not set up on this node' }

const enabled = ctx => !!ctx.env?.RESEND_API_KEY
const fromAddress = ctx => ctx.env?.EMAIL_FROM || 'opportune <onboarding@resend.dev>'
const appUrl = ctx => `${ctx.people.nodeUrl}/app`

export default {
  id: 'email', name: 'Email (magic-link sign-in)',
  description: 'Sign in with a one-time link sent to your email; nudges arrive as plain-text mail when nothing else is set up.',
  repo: 'https://github.com/malcolmocean/opportune/tree/main/channels/email',
  setup: [{ key: 'email', type: 'text', label: 'Your email address' }],

  async start(ctx) {
    const L = ctx.log('email')
    if (!enabled(ctx)) return L.warn('RESEND_API_KEY missing; email sign-in disabled (/app/email/* answers 503)')
    L.info(`sending as ${fromAddress(ctx)}`)
  },

  // Nudge as a short plain-text email. Actions can't be taken from the mail itself (no signed action links yet);
  // the person opens the app to answer. nudges.js tries fcm and telegram first, so this is the fallback.
  async send(ctx, person, identity, nudge) {
    if (!enabled(ctx)) throw new Error('email channel not configured')
    const actions = (nudge.actions || []).filter(a => a.key !== 'bad').map(a => a.label).filter(Boolean)
    const text = [nudge.text, '', actions.length ? `Answer in the app (${actions.join(' / ')}): ${appUrl(ctx)}` : `Open the app: ${appUrl(ctx)}`].join('\n')
    const html = `<p>${esc(nudge.text).replace(/\n/g, '<br>')}</p><p><a href="${appUrl(ctx)}">${actions.length ? `Answer in the app (${esc(actions.join(' / '))})` : 'Open the app'}</a></p>`
    const r = await sendEmail(ctx, { to: identity.external_id, subject: subjectFor(nudge.text), text, html })
    return { externalId: r?.id || null }
  },
}

// ---- routes: mounted by server.js next to /app/register and /app/claim ----
export function mountEmail(app, ctx) {
  const L = ctx.log('email')
  const gate = (req, res, next) => (enabled(ctx) ? next() : res.status(503).json(DISABLED))
  const clientIp = req => (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.ip || 'unknown'   // Caddy fronts the node; req.ip would be 127.0.0.1 for everyone

  // Sign in: always 200 so the route can't be used to find out who has an account.
  app.post('/app/email/request', gate, async (req, res) => {
    const email = normEmail(req.body?.email)
    if (!email || !looksLikeEmail(email)) return res.status(400).json({ error: 'email required' })
    if (!limiter.allow(`addr:${email}`, ...LIMITS.address) || !limiter.allow(`ip:${clientIp(req)}`, ...LIMITS.ip)) return res.status(429).json({ error: 'too many sign-in emails; try again in a few minutes' })
    const person = ctx.people.identify('email', email)
    if (!person || person.remote) { L.debug(`sign-in requested for unknown address ${email}`); return res.json({ ok: true }) }
    try {
      const code = issueSignIn(ctx, person)
      await sendEmail(ctx, signInMail(ctx, { to: email, name: person.display_name, url: `${appUrl(ctx)}?claim=${code}`, code }))
      L.info(`sign-in link sent to ${person.display_name}`)
    } catch (e) { L.error(`sign-in mail to ${email} failed:`, e.message) }   // still 200: the person is told to check their inbox either way
    res.json({ ok: true })
  })

  // Add/verify an address for the signed-in person (same token auth as the other /api/app routes).
  app.post('/api/app/email', gate, (req, res, next) => {
    const me = personForToken(ctx, req.get('x-manage-token') || req.query.token)
    if (!me) return res.status(401).json({ error: 'bad or missing token' })
    req.me = me
    next()
  }, async (req, res) => {
    const me = req.me
    const email = normEmail(req.body?.email)
    if (!email || !looksLikeEmail(email)) return res.status(400).json({ error: 'email required' })
    const owner = ctx.people.identify('email', email)
    if (owner && owner.id !== me.id) return res.status(409).json({ error: 'that address already belongs to another account' })
    if (owner) return res.json({ ok: true, verified: true })   // already theirs; nothing to prove
    if (!limiter.allow(`addr:${email}`, ...LIMITS.address) || !limiter.allow(`person:${me.id}`, ...LIMITS.address)) return res.status(429).json({ error: 'too many verification emails; try again in a few minutes' })
    try {
      const code = issueVerify(ctx, me, email)
      await sendEmail(ctx, verifyMail(ctx, { to: email, name: me.display_name, url: `${ctx.people.nodeUrl}/app/email/verify/${code}`, code }))
      L.info(`verification link sent for ${me.display_name}`)
      res.json({ ok: true })
    } catch (e) { L.error(`verification mail to ${email} failed:`, e.message); res.status(502).json({ error: 'could not send the email; try again' }) }
  })

  // The verification link lands here: bind the address, then hand off to the app's claim flow.
  app.get('/app/email/verify/:code', gate, (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase()
    const pending = code && ctx.db.kvGet(`emailverify:${code}`)
    if (!pending || pending.exp < Date.now()) { if (pending) ctx.db.kvSet(`emailverify:${code}`, null); return res.status(410).type('html').send(expiredPage(ctx)) }
    const owner = ctx.people.identify('email', pending.email)
    if (owner && owner.id !== pending.personId) return res.status(409).type('html').send(takenPage(ctx))
    ctx.people.bind(pending.personId, 'email', pending.email, { verifiedAt: new Date().toISOString() })
    ctx.db.kvSet(`emailverify:${code}`, null)
    L.info(`${ctx.people.get(pending.personId)?.display_name} verified ${pending.email}`)
    res.redirect(302, `/app?claim=${code}`)
  })
}

// ---- codes ----
// Same shape and storage as ctx.sources.linkCode (6 chars, applink:<CODE>, 15 min) so POST /app/claim accepts it.
export function makeCode(ctx) {
  for (;;) {
    let code = ''
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    if (!ctx.db.kvGet(`applink:${code}`) && !ctx.db.kvGet(`emailverify:${code}`)) return code
  }
}

// The app's credential is its opportuneApp source; a Telegram-first person gets one connected here (as /api/app/session does).
export function appSource(ctx, person) {
  return ctx.sources.forPerson(person.id).find(s => s.source_id === 'opportuneApp' && s.enabled) || ctx.sources.connect(person.id, 'opportuneApp', {})
}

export function issueSignIn(ctx, person) {
  const code = makeCode(ctx)
  ctx.db.kvSet(`applink:${code}`, { id: appSource(ctx, person).id, exp: Date.now() + CODE_TTL_MS })
  return code
}

export function issueVerify(ctx, person, email) {
  const code = makeCode(ctx)
  const exp = Date.now() + CODE_TTL_MS
  ctx.db.kvSet(`emailverify:${code}`, { personId: person.id, email, exp })
  ctx.db.kvSet(`applink:${code}`, { id: appSource(ctx, person).id, exp, verifyEmail: email })
  return code
}

// ---- sending ----
// POST https://api.resend.com/emails. globalThis.fetch is read at call time so tests can stub it.
export async function sendEmail(ctx, { to, subject, text, html }) {
  if (!enabled(ctx)) throw new Error('email channel not configured')
  const r = await globalThis.fetch(RESEND_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: fromAddress(ctx), to, subject, text, html }),
  })
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`)
  return r.json().catch(() => ({}))
}

// ---- the two sign-in mails ----
// One shared layout: a short greeting, one big button, and the 6-letter code spelled out for anyone whose
// mail client opens links in the wrong place (the Android shell claims typed codes too). Table layout and
// inline styles because that is what mail clients honour; no images, no web fonts, nothing to load.
export const signInMail = (ctx, { to, name, url, code }) => ({
  to, subject: 'Sign in to opportune',
  text: [
    `${name ? `Hi ${name}. ` : ''}Here's your way back in:`, '', url, '',
    `Or open the app and type this code: ${code}`, '',
    'The link and the code work once and go dark in 15 minutes.',
    'If you didn\'t ask for this, nothing happens. Just ignore it.', '',
  ].join('\n'),
  html: mailHtml({
    eyebrow: 'opportune', title: name ? `Come on in, ${esc(name)}.` : 'Come on in.',
    lead: '', cta: 'Open opportune', url, code, codeHint: 'Or open the app and type this code',
    foot: 'The link and the code work once and go dark in 15 minutes. If you didn\'t ask for this, nothing happens; just ignore it.',
  }),
})

export const verifyMail = (ctx, { to, name, url, code }) => ({
  to, subject: 'Confirm your email for opportune',
  text: [
    `Is this you${name ? `, ${name}` : ''}? Confirm that ${to} is your address on opportune:`, '', url, '',
    `Or open the app and type this code: ${code}`, '',
    'Friends never see your email. It is only how you get back in.',
    'The link and the code work once and go dark in 15 minutes. If you didn\'t ask for this, just ignore it.', '',
  ].join('\n'),
  html: mailHtml({
    eyebrow: 'opportune', title: name ? `Is this you, ${esc(name)}?` : 'Is this you?',
    lead: `Tap to confirm that <b>${esc(to)}</b> is yours on opportune. Friends never see it; it's only how you get back in.`,
    cta: 'Yes, that\'s me', url, code, codeHint: 'Or open the app and type this code',
    foot: 'The link and the code work once and go dark in 15 minutes. If you didn\'t ask for this, nothing happens; just ignore it.',
  }),
})

// Night-navy card on a pale page, one ember button, the code in spaced mono. Lead is already-escaped HTML.
export function mailHtml({ eyebrow, title, lead, cta, url, code, codeHint, foot }) {
  const navy = '#15173a', ember = '#e85a2c', pale = '#f6f5ff', muted = '#5a5e8a', line = '#e1e0f2'
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"
  const mono = "font-family:'SF Mono',Menlo,Consolas,'Liberation Mono',monospace"
  const spaced = esc(String(code || '')).split('').join(' ')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${pale};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${pale};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid ${line};border-radius:16px;">
<tr><td style="padding:28px 28px 8px;${font};font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${ember};font-weight:600;">&#128075; ${esc(eyebrow)}</td></tr>
<tr><td style="padding:0 28px;${font};font-size:28px;line-height:1.15;font-weight:800;color:${navy};letter-spacing:-.01em;">${title}</td></tr>
${lead ? `<tr><td style="padding:12px 28px 0;${font};font-size:16px;line-height:1.55;color:${navy};">${lead}</td></tr>` : ''}
<tr><td style="padding:24px 28px 0;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${ember};border-radius:12px;">
    <a href="${esc(url)}" style="display:inline-block;padding:14px 26px;${font};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">${esc(cta)} &rarr;</a>
  </td></tr></table>
</td></tr>
${code ? `<tr><td style="padding:28px 28px 0;${font};font-size:13px;color:${muted};">${esc(codeHint)}</td></tr>
<tr><td style="padding:8px 28px 0;"><div style="display:inline-block;padding:12px 18px;background:${pale};border:1px solid ${line};border-radius:10px;${mono};font-size:26px;letter-spacing:.18em;font-weight:600;color:${navy};">${spaced}</div></td></tr>` : ''}
<tr><td style="padding:28px 28px 28px;${font};font-size:13px;line-height:1.5;color:${muted};">${esc(foot)}</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;"><tr><td style="padding:16px 8px 0;${font};font-size:12px;line-height:1.5;color:${muted};">If the button doesn't work, paste this into your browser:<br><a href="${esc(url)}" style="color:${muted};word-break:break-all;">${esc(url)}</a></td></tr></table>
</td></tr></table>
</body></html>`
}

const subjectFor = text => { const s = String(text || '').replace(/\s+/g, ' ').trim(); return s.length > 70 ? `${s.slice(0, 67)}...` : s || 'A nudge from opportune' }
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const looksLikeEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254
const page = (ctx, title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h2>${title}</h2><p>${body}</p><p><a href="${appUrl(ctx)}">Back to opportune</a></p>`
const expiredPage = ctx => page(ctx, 'That link has expired', 'Verification links work once and last 15 minutes. Open the app and add your email again.')
const takenPage = ctx => page(ctx, 'That address is taken', 'That email already belongs to another opportune account.')

// ---- in-memory rate limit: key → recent timestamps ----
export const limiter = {
  hits: new Map(),
  allow(key, max, windowMs) {
    const t = Date.now()
    const recent = (this.hits.get(key) || []).filter(x => t - x < windowMs)
    if (recent.length >= max) { this.hits.set(key, recent); return false }
    recent.push(t); this.hits.set(key, recent)
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some(x => t - x < windowMs)) this.hits.delete(k)
    return true
  },
  reset() { this.hits.clear() },
}
