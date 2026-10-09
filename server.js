import express from 'express'
import { readFileSync } from 'node:fs'
import { buildContext } from './core/context.js'
import { startCron } from './core/cron.js'
import { log } from './core/log.js'

const L = log('server')
const ctx = await buildContext()
const app = express()
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf.toString() } }))
app.use(express.urlencoded({ extended: true }))
app.use('/web', express.static('web'))
app.use('/', express.static('site', { index: 'index.html' }))   // landing page, if present

// ---- federation surface ----
app.get('/.well-known/opportune', (_req, res) => res.json(ctx.federation.wellKnown()))
app.post('/friend/accept', (req, res) => { const r = ctx.federation.acceptIncoming(req.body); res.status(r.error ? 400 : 200).json(r) })   // signed by a not-yet-known key, so verified by invite code instead
app.post('/q', (req, res, next) => ctx.federation.verify(req, res, next), async (req, res) => {
  const { to, kind, text, window, context } = req.body
  res.json(await ctx.query.answerLocal({ from: req.fromPerson.id, to, kind, text, window, context }))
})
app.post('/nudge', (req, res, next) => ctx.federation.verify(req, res, next), async (req, res) => {
  const { to, text, actions, expiresAt } = req.body
  const target = ctx.people.get(to)
  if (!target || target.remote) return res.status(404).json({ error: 'not here' })
  res.json({ ok: true, id: (await ctx.nudges.send(to, { text: `${req.fromPerson.display_name}'s node: ${text}`, actions, expiresAt })).id })
})
app.post('/suggest', (req, res, next) => ctx.federation.verify(req, res, next), async (req, res) => {
  const { to, plugin, repo, setup, why } = req.body
  ctx.events.emit('federation:suggest', { from: req.fromPerson, to: ctx.people.get(to), suggest: { plugin, repo, setup }, why })
  res.json({ ok: true })
})
app.post('/observe', (req, res, next) => ctx.federation.verify(req, res, next), async (req, res) => {
  // a remote node pushing observations its person granted us (e.g. trusted-tier live location)
  const { observations } = req.body
  res.json({ inserted: (await ctx.observations.ingest(req.fromPerson.id, `remote:${req.fromPerson.node_url}`, observations)).length })
})

// ---- data ingest from sources / native apps ----
app.post('/ingest/:source/:token', async (req, res) => {
  try { res.json({ inserted: (await ctx.sources.ingest(req.params.source, req.params.token, req.body, req)).length }) }
  catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})
app.get('/ingest/:source/:token', (req, res) => res.json({ ok: true, source: req.params.source }))   // for apps that probe

// ---- app-first start: the Android app registers itself, optionally with an invite code ----
// Returns the ingest URL (which is the app's credential), a manage link, and a Telegram deep link that binds chat to the same person.
app.post('/app/register', async (req, res) => {
  const { inviteCode, displayName, device } = req.body || {}
  const inv = inviteCode && ctx.people.peekInvite(inviteCode)
  const p = ctx.people.create({ displayName: displayName || inv?.invitee_name || 'New person' })
  ctx.people.update(p.id, { onboarding: { step: 'sources', via: 'app', pendingInvite: inv ? inviteCode : null } })
  if (inv) ctx.people.acceptInvite(inviteCode, p.id)
  const sc = ctx.sources.connect(p.id, 'opportuneApp', { device: device || {} })
  const { manageUrl } = await import('./web/routes.js')
  const tg = ctx.plugins.channels.telegram?.deepLink?.(ctx, `link-${sc.token}`)
  res.json({ personId: p.id, ingestUrl: ctx.sources.ingestUrl(sc), manageUrl: manageUrl(ctx, p.id), telegramLink: tg, inviter: inv ? ctx.people.get(inv.inviter_id)?.display_name : null })
})

// ---- inline comments for the onboarding flow page (site/onboarding.html); kv-backed, no auth, dev only ----
app.get('/api/flow-comments', (_req, res) => res.json(ctx.db.kvGet('flowComments') || []))
app.post('/api/flow-comments', (req, res) => {
  const list = ctx.db.kvGet('flowComments') || []
  const { node, text, author } = req.body || {}
  if (!node || !text) return res.status(400).json({ error: 'node and text required' })
  const c = { id: Date.now().toString(36), node, text: String(text).slice(0, 2000), author: String(author || 'anon').slice(0, 40), at: new Date().toISOString() }
  list.push(c); ctx.db.kvSet('flowComments', list); res.json(c)
})
app.delete('/api/flow-comments/:id', (req, res) => { ctx.db.kvSet('flowComments', (ctx.db.kvGet('flowComments') || []).filter(c => c.id !== req.params.id)); res.json({ ok: true }) })

// ---- invites land here; hand off to a channel's onboarding ----
app.get('/i/:code', (req, res) => {
  const inv = ctx.people.peekInvite(req.params.code)
  if (!inv) return res.status(404).send('This invite has been used or expired.')
  const inviter = ctx.people.get(inv.inviter_id)
  const tg = ctx.plugins.channels.telegram?.deepLink?.(ctx, req.params.code)
  res.type('html').send(readFileSync('web/invite.html', 'utf8')
    .replaceAll('{{inviter}}', inviter.display_name || 'A friend').replaceAll('{{name}}', inv.invitee_name || 'you')
    .replaceAll('{{tg}}', tg || '#').replaceAll('{{code}}', req.params.code).replaceAll('{{node}}', ctx.people.nodeUrl))
})

// ---- local/debug API ----
app.get('/api/health', (_req, res) => res.json({ ok: true, people: ctx.people.all().length, llm: ctx.llm.enabled }))
app.get('/api/people', (_req, res) => res.json(ctx.people.all().map(p => ({ id: p.id, name: p.display_name, friends: ctx.people.friendsOf(p.id).length }))))
app.post('/api/dev/opportunity', async (req, res) => res.json(await ctx.opportunities.add('dev', req.body)))

// ---- web management UI (web/routes.js is built as an addon; optional) ----
try { const { mountWeb } = await import('./web/routes.js'); await mountWeb(app, ctx) } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') L.error('web routes failed:', e.message) }

// ---- channels start (telegram long-polls; fcm just needs creds) ----
for (const ch of Object.values(ctx.plugins.channels)) {
  try { await ch.start?.(ctx) } catch (e) { L.error(`channel ${ch.id} failed to start:`, e.message) }
}
startCron(ctx)

const port = Number(process.env.PORT || 3400)
app.listen(port, () => L.info(`opportune node at ${ctx.people.nodeUrl} (port ${port}), llm ${ctx.llm.enabled ? 'on' : 'OFF'}`))
