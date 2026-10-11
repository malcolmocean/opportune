import { uid, now, parseRow } from './db.js'
import { log } from './log.js'

const L = log('obs')

// Insert observations from a source, then fire triggers subscribed to their kinds.
export function makeObservations(db, ctx) {
  const O = {
    insert(personId, sourceId, obs) {
      const row = {
        id: uid(), person_id: personId, source_id: sourceId, kind: obs.kind, at: obs.at || now(), until: obs.until || null,
        data: obs.data, raw: obs.raw ?? null, dedupe_key: obs.dedupeKey || null, created_at: now(),
      }
      if (row.dedupe_key) {
        const ex = db.get('select id, data from observations where person_id = ? and source_id = ? and dedupe_key = ?', personId, sourceId, row.dedupe_key)
        if (ex) {
          if (ex.data === JSON.stringify(obs.data)) return null   // unchanged, nothing to fire
          db.run('update observations set data = ?, at = ?, until = ?, raw = ? where id = ?', JSON.stringify(obs.data), row.at, row.until, JSON.stringify(row.raw), ex.id)
          row.id = ex.id
          return { ...row, updated: true }
        }
      }
      db.insert('observations', row)
      return row
    },
    async ingest(personId, sourceId, list) {
      const inserted = []
      for (const o of list || []) { const r = O.insert(personId, sourceId, o); if (r) inserted.push(r) }
      if (inserted.length) L.info(`${sourceId}: ${inserted.length} new obs for ${personId}`)
      for (const row of inserted) await O.fire(row)
      return inserted
    },
    async fire(row) {
      const person = ctx.people.get(row.person_id)
      for (const t of Object.values(ctx.plugins.triggers)) {
        if (!t.on?.includes(row.kind)) continue
        try {
          const opps = await t.run(ctx, { observation: row, person })
          for (const o of opps || []) await ctx.opportunities.add(t.id, o)
        } catch (e) { L.error(`trigger ${t.id} failed:`, e) }
      }
    },
    // activeOnly: only rows whose `until` is null or in the future (statuses, events). rowid breaks same-ms ties.
    latest(personId, kind, { within, activeOnly } = {}) {
      const conds = ['person_id = ?', 'kind = ?'], p = [personId, kind]
      if (within) { conds.push('at > ?'); p.push(new Date(Date.now() - within).toISOString()) }
      if (activeOnly) { conds.push('(until is null or until > ?)'); p.push(now()) }
      return parseRow(db.get(`select * from observations where ${conds.join(' and ')} order by at desc, rowid desc limit 1`, ...p), ['data', 'raw'])
    },
    recent(personId, { kinds, since, until, limit = 50 } = {}) {
      const conds = ['person_id = ?'], p = [personId]
      if (kinds?.length) { conds.push(`kind in (${kinds.map(() => '?').join(',')})`); p.push(...kinds) }
      if (since) { conds.push('(until >= ? or at >= ?)'); p.push(since, since) }
      if (until) { conds.push('at <= ?'); p.push(until) }
      return db.all(`select * from observations where ${conds.join(' and ')} order by at desc, rowid desc limit ?`, ...p, limit).map(r => parseRow(r, ['data', 'raw']))   // rowid breaks same-ms ties (a motion + its fix)
    },
    // events overlapping a window, for availability/plans
    eventsIn(personId, startIso, endIso) {
      return db.all(`select * from observations where person_id = ? and kind = 'event' and at < ? and coalesce(until, at) > ? order by at`, personId, endIso, startIso).map(r => parseRow(r, ['data', 'raw']))
    },
    // all events across people with an attendee name/email match, for co-attendance
    eventsMatching({ title, start, url }) {
      return db.all(`select * from observations where kind = 'event' and (json_extract(data,'$.url') = ? or (json_extract(data,'$.title') = ? and substr(at,1,10) = ?))`, url || '', title || '', (start || '').slice(0, 10)).map(r => parseRow(r, ['data', 'raw']))
    },
  }
  return O
}
