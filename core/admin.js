// Admin overview: who's signed up, which connectors, how many friends, and LLM token spend.
// Guarded by ADMIN_TOKEN (query ?token= or x-admin-token header). Mounted by server.js.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const DAY = 864e5

// Is this request carrying the admin token? False when no ADMIN_TOKEN is configured.
export function adminOk(ctx, req) {
  const token = ctx.env?.ADMIN_TOKEN || process.env.ADMIN_TOKEN
  return !!token && (req.query?.token === token || req.get?.('x-admin-token') === token)
}

// Dev-only routes: open outside production, admin-token-gated in production.
export const devOk = (ctx, req) => (ctx.env?.NODE_ENV || process.env.NODE_ENV) !== 'production' || adminOk(ctx, req)
const ago = ms => new Date(Date.now() - ms).toISOString()

// since: ISO string, or relative like '7d' / '36h'. Default 30 days.
export function parseSince(s, fallbackMs = 30 * DAY) {
  if (!s) return ago(fallbackMs)
  const m = /^(\d+)([dh])$/.exec(String(s))
  if (m) return ago(Number(m[1]) * (m[2] === 'd' ? DAY : 3600e3))
  const d = new Date(s)
  return isNaN(d) ? ago(fallbackMs) : d.toISOString()
}

export function mountAdmin(app, ctx) {
  // admin.html lives in core/ (not under the /web static mount) so it is only ever served through this check
  app.get('/web/admin', (req, res) => adminOk(ctx, req) ? res.sendFile(join(here, 'admin.html')) : res.status(401).send('admin token required: /web/admin?token=…'))

  app.get('/api/admin/overview', (req, res) => {
    if (!adminOk(ctx, req)) return res.status(401).json({ error: 'admin token required' })
    const db = ctx.db
    const since7d = ago(7 * DAY), since30d = ago(30 * DAY)
    const usage7d = Object.fromEntries(ctx.llm.usage({ since: since7d, groupBy: 'person' }).map(r => [r.person_id, r]))
    const people = db.all('select * from people order by created_at desc').map(p => {
      const onboarding = JSON.parse(p.onboarding || '{}')
      const u = usage7d[p.id]
      return {
        id: p.id, name: p.display_name, createdAt: p.created_at, remote: !!p.remote, shadow: onboarding.step === 'shadow', onboarding: onboarding.step || null, via: onboarding.via || null, node: p.node_url,
        channels: ctx.people.identities(p.id).map(i => i.channel),
        sources: ctx.sources.forPerson(p.id).map(s => ({ id: s.source_id, enabled: !!s.enabled, lastPoll: s.last_poll_at, error: s.last_error })),
        friendsOut: db.get('select count(*) c from relationships where from_id = ?', p.id).c,
        friendsIn: db.get('select count(*) c from relationships where to_id = ?', p.id).c,
        wantMore: db.get('select count(*) c from relationships where from_id = ? and want_more = 1', p.id).c,
        home: !!ctx.people.home(p.id),
        observations: db.get('select count(*) c, max(at) last from observations where person_id = ?', p.id),
        nudges: db.get('select count(*) c, sum(case when response is not null then 1 else 0 end) answered from nudges where person_id = ?', p.id),
        decisions: counts(ctx.judge.reviewable(p.id, null, { limit: 100000 })),   // same filter as the manage page: relationship gates stay out
        invitesOpen: db.get('select count(*) c from invites where inviter_id = ? and used_by is null and expires_at > ?', p.id, new Date().toISOString()).c,
        usage7d: { calls: u?.calls || 0, tokens: (u?.input_tokens || 0) + (u?.output_tokens || 0) + (u?.cache_read_tokens || 0) + (u?.cache_write_tokens || 0), costUsd: u?.cost_usd || 0 },
      }
    })
    res.json({
      node: ctx.people.nodeUrl, llm: ctx.llm.enabled, now: new Date().toISOString(), people,
      totals: { people: people.length, local: people.filter(p => !p.remote && !p.shadow).length, remote: people.filter(p => p.remote).length, shadow: people.filter(p => p.shadow).length,
        opportunities: db.get('select count(*) c from opportunities').c, decisions: db.get('select count(*) c from decisions').c, nudges: db.get('select count(*) c from nudges').c, queries: db.get('select count(*) c from query_log').c },
      usage: ctx.llm.usageSummary(since30d),
      usagePersonDay7d: ctx.llm.usage({ since: since7d, groupBy: 'person-day' }),
      recentOpportunities: db.all('select kind, trigger_id, summary, status, created_at from opportunities order by created_at desc limit 15'),
    })
  })

  // Raw aggregation: /api/admin/usage?since=7d&groupBy=person-day
  app.get('/api/admin/usage', (req, res) => {
    if (!adminOk(ctx, req)) return res.status(401).json({ error: 'admin token required' })
    const since = parseSince(req.query.since), groupBy = req.query.groupBy || 'process'
    try {
      res.json({ since, groupBy, rows: ctx.llm.usage({ since, until: req.query.until || undefined, groupBy }) })
    } catch (e) { res.status(400).json({ error: e.message }) }
  })
}

const counts = rows => ({ c: rows.length, quiet: rows.filter(d => d.verdict === 'suppress').length, rated: rows.filter(d => d.rating != null).length })
