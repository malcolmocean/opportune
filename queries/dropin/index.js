// "Jess is a block away, ok if she drops by?" Answered deterministically for `to` from porchlight,
// presence and calendar. In the 'ask' state we answer 'likely' and give `to` a veto nudge; a veto
// closes the porchlight for two hours so the next ask says no. No LLM. Never reveals location
// beyond home / not home.
import { porchlight, presence } from './porchlight.js'

const SOURCE_ID = 'dropin'
const VETO_WINDOW_MS = 40 * 60e3
const VETO_CLOSE_MS = 2 * 3600e3
const pendingKey = (toId, fromId) => `dropin:pending:${toId}:${fromId}`
const nudgeKey = nudgeId => `dropin:nudge:${nudgeId}`

export default {
  id: 'dropin', kind: 'dropin', sensitivity: 2, grant: 'askDropin',
  description: 'Is now ok for this friend to drop by? Porchlight + home/not-home + calendar; default-yes with a veto nudge to the host.',

  init(ctx) {
    ctx.events.on('nudge:response', ({ nudge, actionKey }) => onResponse(ctx, nudge, actionKey).catch(e => ctx.log('dropin').error('veto handler failed', e)))
  },

  async answer(ctx, { from, to, relationship, text, context }) {
    const light = porchlight(ctx, to)
    const who = from?.display_name || 'A friend'
    const base = { confidence: 0.9, revealed: { porchlight: light.state } }

    if (light.state === 'closed') return { ...base, answer: 'no', reason: 'not a good time', confidence: 1 }

    const p = presence(ctx, to.id)
    base.revealed.presence = p.isHome ? 'home' : 'not home'
    if (!p.loc && !p.home && !ctx.sources.forPerson(to.id).length) {
      return { answer: 'unsupported', confidence: 0.2, reason: 'no home or location set', revealed: {}, suggest: { plugin: 'queries/dropin', setup: 'set porchlight + add a location source' } }
    }
    if (!p.isHome) return { ...base, answer: 'unlikely', reason: 'not home right now', confidence: 0.8 }

    const nowIso = new Date().toISOString()
    const events = ctx.observations.eventsIn(to.id, nowIso, nowIso).filter(e => e.data?.busy !== false)
    if (events.length) return { ...base, answer: 'unlikely', reason: busyReason(relationship, events[0]), confidence: 0.7 }

    if (light.state === 'open') return { ...base, answer: 'yes', reason: 'porchlight is open', confidence: 1 }

    // 'ask'
    if (relationship.effectiveGrants.autoYesDropin) return { ...base, answer: 'likely', reason: 'probably fine', confidence: 0.8 }

    // One veto nudge per (to, from) per window. If they already said yes, upgrade; if still pending, don't re-nudge.
    const fromId = from?.id || 'unknown'
    const pending = ctx.db.kvGet(pendingKey(to.id, fromId))
    if (pending && pending.until > nowIso) {
      const n = ctx.nudges.get(pending.nudgeId)
      if (n?.response === 'yes') return { ...base, answer: 'yes', reason: `${to.display_name} said come by`, confidence: 1 }
      if (!n?.response) return { ...base, answer: 'likely', reason: 'probably fine, checking', confidence: 0.6 }
    }
    const until = new Date(Date.now() + VETO_WINDOW_MS).toISOString()
    const nudge = await ctx.nudges.send(to.id, {
      text: `${who} is a block away and might drop by in the next little while. I said it's probably fine.`,
      actions: [{ key: 'yes', label: 'Yes come by' }, { key: 'veto', label: 'Not now' }],
      expiresAt: until,
    })
    if (nudge?.id) {
      ctx.db.kvSet(nudgeKey(nudge.id), { from: fromId, to: to.id, until })
      ctx.db.kvSet(pendingKey(to.id, fromId), { nudgeId: nudge.id, until })
    }
    return { ...base, answer: 'likely', reason: 'probably fine, checking', confidence: 0.6 }
  },
}

// Tier-safe phrasing for "has something on". Only trusted hears the title.
function busyReason(rel, ev) {
  if (rel?.tier === 'trusted' && ev.data?.title) return `has "${ev.data.title}" on right now`
  if (rel?.tier === 'friend') return 'has something on right now'
  return 'not a good time'
}

// The host tapped an action on our veto nudge.
async function onResponse(ctx, nudge, actionKey) {
  const rec = ctx.db.kvGet(nudgeKey(nudge.id))
  if (!rec) return
  const nowIso = new Date().toISOString()
  const to = ctx.people.get(rec.to), from = ctx.people.get(rec.from)
  if (actionKey === 'veto') {
    if (rec.until < nowIso) return    // window passed; nothing to close
    await ctx.observations.ingest(rec.to, SOURCE_ID, [{
      kind: 'status', at: nowIso, until: new Date(Date.now() + VETO_CLOSE_MS).toISOString(),
      data: { porchlight: 'closed', note: `vetoed a drop-in from ${from?.display_name || rec.from}` },
    }])
    if (from) await ctx.nudges.send(rec.from, { text: `${to?.display_name || 'They'}'s not up for it right now, another time.`, actions: [] })
  } else if (actionKey === 'yes' && from) {
    await ctx.nudges.send(rec.from, { text: `${to?.display_name || 'They'} says come on by.`, actions: [] })
  }
}
