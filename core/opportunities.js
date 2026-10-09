import { uid, now, parseRow } from './db.js'
import { log } from './log.js'
const L = log('opps')

export function makeOpportunities(db, ctx) {
  const queue = []
  let draining = false
  const Op = {
    async add(triggerId, o) {
      const row = {
        id: uid(), trigger_id: triggerId, kind: o.kind, participants: o.participants, primary_id: o.primary === undefined ? o.participants[0] : o.primary,
        summary: o.summary, evidence: o.evidence || [], dedupe_key: o.dedupeKey || null,
        expires_at: o.expiresAt || new Date(Date.now() + 3 * 3600e3).toISOString(), status: 'pending', created_at: now(),
      }
      if (row.dedupe_key && db.get('select 1 from opportunities where dedupe_key = ?', row.dedupe_key)) return null
      db.insert('opportunities', row)
      L.info(`+ ${row.kind} [${triggerId}] ${row.summary.slice(0, 80)}`)
      queue.push(row.id)
      Op.drain()
      return row
    },
    get(id) { return parseRow(db.get('select * from opportunities where id = ?', id), ['participants', 'evidence']) },
    async drain() {
      if (draining) return
      draining = true
      try {
        while (queue.length) {
          const id = queue.shift()
          const opp = Op.get(id)
          if (!opp || opp.status !== 'pending') continue
          if (opp.expires_at < now()) { db.run(`update opportunities set status='expired' where id=?`, id); continue }
          try { await ctx.judge.consider(opp) } catch (e) { L.error('judge failed', e) }
          db.run(`update opportunities set status='judged' where id=?`, id)
        }
      } finally { draining = false }
    },
    pendingFor(personId) {
      return db.all(`select * from opportunities where status = 'pending' and participants like ?`, `%${personId}%`).map(r => parseRow(r, ['participants', 'evidence']))
    },
  }
  return Op
}
