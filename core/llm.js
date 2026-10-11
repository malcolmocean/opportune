import Anthropic from '@anthropic-ai/sdk'
import { uid, now } from './db.js'
import { log } from './log.js'
const L = log('llm')

// USD per million tokens, keyed by model id prefix (longest prefix wins). These are editable
// estimates of first-party list prices as of Oct 2026; cache writes are priced at 1.25x input,
// cache reads at roughly 0.1x. A model with no matching prefix records cost_usd = null.
export const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
}

export function priceFor(model) {
  let best = null
  for (const k of Object.keys(PRICES)) if (model?.startsWith(k) && (!best || k.length > best.length)) best = k
  return best ? PRICES[best] : null
}

// cost in USD for one call, or null if the model is unpriced
export function costUsd(model, { input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0 } = {}) {
  const p = priceFor(model)
  if (!p) return null
  return (input_tokens * p.input + output_tokens * p.output + cache_read_tokens * p.cacheRead + cache_write_tokens * p.cacheWrite) / 1e6
}

// Insert one llm_usage row. Exported so tests (and anything that calls the SDK outside makeLlm) can record directly.
export function __recordUsage(db, row) {
  const at = row.at || now()
  const r = {
    id: row.id || uid(), person_id: row.personId ?? row.person_id ?? null, process: row.process || 'unknown', model: row.model || 'unknown',
    input_tokens: row.input_tokens | 0, output_tokens: row.output_tokens | 0, cache_read_tokens: row.cache_read_tokens | 0, cache_write_tokens: row.cache_write_tokens | 0,
    duration_ms: row.duration_ms ?? null, at, created_at: now(),
  }
  r.cost_usd = row.cost_usd !== undefined ? row.cost_usd : costUsd(r.model, r)
  db.insert('llm_usage', r)
  return r
}

const SUMS = `count(*) calls, sum(input_tokens) input_tokens, sum(output_tokens) output_tokens, sum(cache_read_tokens) cache_read_tokens, sum(cache_write_tokens) cache_write_tokens,
  sum(cost_usd) cost_usd, sum(cost_usd is null) unpriced_calls, sum(duration_ms) duration_ms`
const GROUPS = {
  person: { cols: 'u.person_id, p.display_name name', by: 'u.person_id', order: 'cost_usd desc, calls desc' },
  process: { cols: 'u.process', by: 'u.process', order: 'cost_usd desc, calls desc' },
  day: { cols: 'substr(u.at, 1, 10) day', by: 'substr(u.at, 1, 10)', order: 'day' },
  'person-day': { cols: 'u.person_id, p.display_name name, substr(u.at, 1, 10) day', by: 'u.person_id, substr(u.at, 1, 10)', order: 'day, cost_usd desc' },
  'process-day': { cols: 'u.process, substr(u.at, 1, 10) day', by: 'u.process, substr(u.at, 1, 10)', order: 'day, cost_usd desc' },
}
const isoAgo = ms => new Date(Date.now() - ms).toISOString()

// Aggregated spend. since/until are ISO strings (since defaults to 30 days ago).
export function usageQuery(db, { since, until, groupBy = 'process' } = {}) {
  const g = GROUPS[groupBy]
  if (!g) throw new Error(`unknown groupBy: ${groupBy}`)
  const where = ['u.at >= ?'], params = [since || isoAgo(30 * 864e5)]
  if (until) { where.push('u.at < ?'); params.push(until) }
  return db.all(`select ${g.cols}, ${SUMS} from llm_usage u left join people p on p.id = u.person_id where ${where.join(' and ')} group by ${g.by} order by ${g.order}`, ...params)
    .map(r => ({ ...r, cost_usd: r.cost_usd ?? 0 }))
}

export function usageTotal(db, { since, until } = {}) {
  const where = ['at >= ?'], params = [since || isoAgo(30 * 864e5)]
  if (until) { where.push('at < ?'); params.push(until) }
  const r = db.get(`select ${SUMS.replaceAll('u.', '')} from llm_usage where ${where.join(' and ')}`, ...params)
  for (const k of Object.keys(r)) r[k] = r[k] ?? 0
  return r
}

export function makeLlm(env, db = null) {
  const client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null
  const judgeModel = env.JUDGE_MODEL || 'claude-opus-5-5'
  const agentModel = env.AGENT_MODEL || 'claude-opus-5-5'

  // One SDK call, timed and recorded. meta: { personId, process }
  async function call(params, meta = {}) {
    const t0 = Date.now()
    const r = await client.messages.create(params)
    if (db) {
      try {
        const u = r.usage || {}
        __recordUsage(db, {
          personId: meta.personId || null, process: meta.process || 'unknown', model: r.model || params.model,
          input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_tokens: u.cache_read_input_tokens, cache_write_tokens: u.cache_creation_input_tokens,
          duration_ms: Date.now() - t0,
        })
      } catch (e) { L.warn('could not record usage:', e.message) }
    }
    return r
  }

  return {
    enabled: !!client,
    // Plain completion. Returns text.
    async complete({ system, messages, model, maxTokens = 1024 }, meta) {
      if (!client) { L.warn('no ANTHROPIC_API_KEY; returning stub'); return '' }
      const r = await call({ model: model || judgeModel, max_tokens: maxTokens, system, messages }, meta)
      return r.content.filter(b => b.type === 'text').map(b => b.text).join('')
    },
    // Ask for JSON matching a loose shape; tolerant parse.
    async json({ system, messages, model, maxTokens = 1024 }, meta) {
      const text = await this.complete({ system: system + '\n\nRespond with a single JSON object and nothing else.', messages, model, maxTokens }, meta)
      const m = text.match(/\{[\s\S]*\}/)
      try { return m ? JSON.parse(m[0]) : null } catch { L.warn('bad json from model:', text.slice(0, 200)); return null }
    },
    // Tool-use loop. tools: [{ name, description, input_schema, run(input) }]. One usage row per turn.
    async agent({ system, messages, tools = [], model, maxTokens = 2048, maxTurns = 8 }, meta) {
      if (!client) return { text: '(LLM not configured: set ANTHROPIC_API_KEY)', messages }
      const defs = tools.map(({ run, ...t }) => t)
      let msgs = [...messages]
      for (let i = 0; i < maxTurns; i++) {
        const r = await call({ model: model || agentModel, max_tokens: maxTokens, system, messages: msgs, tools: defs.length ? defs : undefined }, meta)
        msgs.push({ role: 'assistant', content: r.content })
        if (r.stop_reason !== 'tool_use') {
          return { text: r.content.filter(b => b.type === 'text').map(b => b.text).join(''), messages: msgs }
        }
        const results = []
        for (const b of r.content.filter(b => b.type === 'tool_use')) {
          const tool = tools.find(t => t.name === b.name)
          let out
          try { out = await tool.run(b.input) } catch (e) { out = { error: e.message } }
          results.push({ type: 'tool_result', tool_use_id: b.id, content: typeof out === 'string' ? out : JSON.stringify(out) })
        }
        msgs.push({ role: 'user', content: results })
      }
      return { text: '(gave up after too many tool calls)', messages: msgs }
    },
    // Spend reporting. usage({ since, until, groupBy: 'person'|'process'|'day'|'person-day'|'process-day' }) → aggregated rows.
    usage(opts) { return db ? usageQuery(db, opts) : [] },
    usageSummary(since) {
      if (!db) return { since, total: { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, unpriced_calls: 0, duration_ms: 0 }, byPerson: [], byProcess: [], byDay: [] }
      since = since || isoAgo(30 * 864e5)
      return { since, total: usageTotal(db, { since }), byPerson: usageQuery(db, { since, groupBy: 'person' }), byProcess: usageQuery(db, { since, groupBy: 'process' }), byDay: usageQuery(db, { since, groupBy: 'day' }) }
    },
  }
}
