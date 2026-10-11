import { uid, now, parseRow } from './db.js'
import { log } from './log.js'
const L = log('nudges')

export function makeNudges(db, ctx) {
  const N = {
    // Deliver through the person's channels in preference order: native push, telegram, anything else.
    // opts.from: the local person this nudge is on behalf of (signs the federation request when the target is remote)
    async send(personId, { text, actions = [], decisionId = null, expiresAt = null }, { from = null } = {}) {
      const person = ctx.people.get(personId)
      if (person?.remote) return ctx.federation.deliverNudge(person, { text, actions, decisionId, expiresAt }, { from })
      const row = { id: uid(), person_id: personId, decision_id: decisionId, text, actions, channel: null, external_id: null, expires_at: expiresAt, created_at: now() }
      db.insert('nudges', row)
      const ids = ctx.people.identities(personId)
      const order = ['fcm', 'telegram', 'email']
      for (const ch of order) {
        const plugin = ctx.plugins.channels[ch]
        const ident = ids.find(i => i.channel === ch)
        if (!plugin?.send || !ident) continue
        try {
          const r = await plugin.send(ctx, person, ident, { ...row, actions: ensureBad(actions) })
          db.run('update nudges set channel = ?, external_id = ? where id = ?', ch, r?.externalId || null, row.id)
          L.info(`→ ${person.display_name} via ${ch}: ${text.slice(0, 80)}`)
          return row
        } catch (e) { L.warn(`channel ${ch} failed:`, e.message) }
      }
      L.warn(`no channel delivered nudge to ${personId}`)
      return row
    },
    get(id) { return parseRow(db.get('select * from nudges where id = ?', id), ['actions']) },
    // Called by channels when the human taps an action.
    async respond(nudgeId, actionKey, note) {
      const n = N.get(nudgeId)
      if (!n) return null
      db.run('update nudges set response = ?, responded_at = ? where id = ?', actionKey, now(), nudgeId)
      if (n.decision_id) {
        if (actionKey === 'bad') ctx.judge.rate(n.decision_id, 'bad', note || 'should not have nudged')
        else if (actionKey === 'yes') ctx.judge.rate(n.decision_id, 'good', note)
      }
      ctx.events.emit('nudge:response', { nudge: n, actionKey })
      return n
    },
    recent(personId, limit = 20) { return db.all('select * from nudges where person_id = ? order by created_at desc limit ?', personId, limit).map(r => parseRow(r, ['actions'])) },
  }
  return N
}
const ensureBad = a => (a.some(x => x.key === 'bad') ? a : [...a, { key: 'bad', label: "Shouldn't have bugged me" }])
