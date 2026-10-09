import { uid, now } from './db.js'
import { log } from './log.js'
const L = log('query')

// The one inter-agent primitive. `kind` is a permission class; `text` is what the
// answering LLM reads. Local and federated share this shape.
export function makeQuery(db, ctx) {
  const Q = {
    kinds() { return Object.values(ctx.plugins.queries).sort((a, b) => a.sensitivity - b.sensitivity) },
    async ask({ from, to, kind = 'availability', text, window, context }) {
      const target = ctx.people.get(to)
      if (!target) return { answer: 'unsupported', reason: 'unknown person' }
      if (target.remote) return ctx.federation.ask(target, { from, kind, text, window, context })
      return Q.answerLocal({ from, to, kind, text, window, context })
    },
    // Answer on behalf of a local person. `from` may be local or remote (already authenticated by federation).
    async answerLocal({ from, to, kind, text, window, context }) {
      const plugin = ctx.plugins.queries[kind]
      const rel = ctx.people.rel(to, from)
      const log_ = (answer, reason) => db.insert('query_log', { id: uid(), from_id: from, to_id: to, kind, text: text || null, answer, reason: reason || null, created_at: now() })
      if (!rel) { log_('no', 'not a friend'); return { answer: 'no', reason: 'not a friend' } }
      if (!plugin) {
        log_('unsupported', 'no plugin')
        const suggest = suggestFor(kind)
        if (suggest) ctx.events.emit('federation:suggest', { from: ctx.people.get(from), to: ctx.people.get(to), suggest, kind, why: `${ctx.people.get(from)?.display_name}'s agent asked about ${kind}` })
        return { answer: 'unsupported', reason: `this node has no "${kind}" query`, suggest }
      }
      const grantKey = plugin.grant
      if (grantKey && !rel.effectiveGrants[grantKey]) { log_('no', `grant ${grantKey} not given`); return { answer: 'no', reason: 'not permitted', confidence: 1 } }
      const pol = ctx.people.policy(to)
      const perHour = pol.queryRate?.perHour ?? 6
      const n = db.get('select count(*) c from query_log where from_id = ? and to_id = ? and kind = ? and created_at > ?', from, to, kind, new Date(Date.now() - 3600e3).toISOString()).c
      if (n >= perHour) { log_('no', 'rate limited'); return { answer: 'no', reason: 'rate limited, try later', confidence: 1 } }
      const asker = ctx.people.get(from)
      try {
        const ans = await plugin.answer(ctx, { from: asker, to: ctx.people.get(to), relationship: rel, text, window, context })
        log_(ans.answer, ans.reason)
        ctx.events.emit('query:answered', { from, to, kind, ans })
        if (ans.answer === 'unsupported' && ans.suggest) ctx.events.emit('federation:suggest', { from: asker, to: ctx.people.get(to), suggest: ans.suggest, kind, why: `${asker?.display_name}'s agent asked about ${kind}` })
        return ans
      } catch (e) { L.error(`query ${kind} failed`, e); log_('unsupported', e.message); return { answer: 'unsupported', reason: e.message } }
    },
    // Fan out one question to many friends; aggregate structured answers.
    async fanout(from, { kind = 'availability', text, window, context, toIds }) {
      const ids = toIds || ctx.people.friendsOf(from).map(f => f.id)
      const results = await Promise.all(ids.map(async to => ({ to, name: ctx.people.get(to)?.display_name, ...(await Q.ask({ from, to, kind, text, window, context })) })))
      return results.sort((a, b) => rank(a.answer) - rank(b.answer))
    },
  }
  return Q
}
const rank = a => ({ yes: 0, likely: 1, unlikely: 2, no: 3, unsupported: 4 }[a] ?? 5)
const suggestFor = kind => ({ availability: { plugin: 'queries/availability', repo: 'https://github.com/malcolmocean/opportune', setup: 'add a calendar source' }, plans: { plugin: 'queries/plans', setup: 'add a calendar source' }, whereabouts: { plugin: 'queries/whereabouts', setup: 'add a location source' }, dropin: { plugin: 'queries/dropin', setup: 'set porchlight + add a location source' } }[kind])
