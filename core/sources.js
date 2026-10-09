import { uid, now, parseRow } from './db.js'
import { randomBytes } from 'node:crypto'
import { log } from './log.js'
const L = log('sources')

export function makeSources(db, ctx) {
  const S = {
    forPerson(personId) { return db.all('select * from source_configs where person_id = ?', personId).map(r => parseRow(r, ['config'])) },
    byToken(token) { return parseRow(db.get('select * from source_configs where token = ? and enabled = 1', token), ['config']) },
    connect(personId, sourceId, config = {}) {
      const ex = db.get('select id from source_configs where person_id = ? and source_id = ?', personId, sourceId)
      if (ex) { db.run('update source_configs set config = ?, enabled = 1 where id = ?', JSON.stringify(config), ex.id); return S.get(ex.id) }
      const row = { id: uid(), person_id: personId, source_id: sourceId, token: randomBytes(12).toString('base64url'), config, enabled: 1, created_at: now() }
      db.insert('source_configs', row)
      return row
    },
    get(id) { return parseRow(db.get('select * from source_configs where id = ?', id), ['config']) },
    ingestUrl(sc) { return `${ctx.people.nodeUrl}/ingest/${sc.source_id}/${sc.token}` },
    // Called by POST /ingest/:source/:token
    async ingest(sourceId, token, payload, req) {
      const sc = S.byToken(token)
      if (!sc || sc.source_id !== sourceId) throw Object.assign(new Error('bad token'), { status: 401 })
      const plugin = ctx.plugins.sources[sourceId]
      if (!plugin?.ingest) throw Object.assign(new Error('source has no ingest'), { status: 404 })
      const person = ctx.people.get(sc.person_id)
      const obs = await plugin.ingest(ctx, person, sc.config, payload, req)
      return ctx.observations.ingest(person.id, sourceId, obs)
    },
    // Cron: poll every enabled config whose plugin has poll() and whose interval elapsed.
    async pollDue() {
      for (const sc of db.all('select * from source_configs where enabled = 1').map(r => parseRow(r, ['config']))) {
        const plugin = ctx.plugins.sources[sc.source_id]
        if (!plugin?.poll) continue
        const interval = (plugin.intervalMin || 15) * 60e3
        if (sc.last_poll_at && Date.now() - new Date(sc.last_poll_at).getTime() < interval) continue
        const person = ctx.people.get(sc.person_id)
        try {
          const obs = await plugin.poll(ctx, person, sc.config, sc.last_poll_at)
          await ctx.observations.ingest(person.id, sc.source_id, obs)
          db.run('update source_configs set last_poll_at = ?, last_error = null where id = ?', now(), sc.id)
        } catch (e) {
          L.warn(`poll ${sc.source_id} for ${person?.display_name}:`, e.message)
          db.run('update source_configs set last_poll_at = ?, last_error = ? where id = ?', now(), e.message, sc.id)
        }
      }
    },
  }
  return S
}
