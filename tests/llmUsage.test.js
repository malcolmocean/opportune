import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { buildContext } from '../core/context.js'
import { __recordUsage, costUsd, priceFor, PRICES } from '../core/llm.js'
import { mountAdmin, parseSince } from '../core/admin.js'

const ADMIN = 'test-admin-token'
let ctx, server, base, jess, eileen
const day = n => new Date(Date.now() - n * 864e5).toISOString()
const get = async (path, token = ADMIN) => {
  const r = await fetch(`${base}${path}`, { headers: token ? { 'x-admin-token': token } : {} })
  return { status: r.status, body: await r.json() }
}

before(async () => {
  process.env.ADMIN_TOKEN = ADMIN
  ctx = await buildContext({ ...process.env, ANTHROPIC_API_KEY: '', TELEGRAM_BOT_TOKEN: '', ADMIN_TOKEN: ADMIN }, { dbPath: ':memory:' })
  const app = express()
  app.use(express.json())
  mountAdmin(app, ctx)
  await new Promise(r => { server = app.listen(0, r) })
  base = `http://127.0.0.1:${server.address().port}`
  jess = ctx.people.create({ displayName: 'Jess' })
  eileen = ctx.people.create({ displayName: 'Eileen' })
  for (const p of [jess, eileen]) ctx.people.update(p.id, { onboarding: { step: 'done' }, policy: { quietHours: { start: 99, end: 99 } } })

  // Jess: 2 judge calls today, 1 agent-chat yesterday. Eileen: 1 source call 3 days ago. One system call 40 days ago (outside 30d).
  __recordUsage(ctx.db, { personId: jess.id, process: 'judge', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 100, duration_ms: 800 })
  __recordUsage(ctx.db, { personId: jess.id, process: 'judge', model: 'claude-opus-5-5', input_tokens: 2000, output_tokens: 200, cache_read_tokens: 500, duration_ms: 900 })
  __recordUsage(ctx.db, { personId: jess.id, process: 'agent-chat', model: 'claude-sonnet-5-5', input_tokens: 10_000, output_tokens: 1000, at: day(1) })
  __recordUsage(ctx.db, { personId: eileen.id, process: 'source:matrix', model: 'claude-haiku-5-5', input_tokens: 100_000, output_tokens: 2000, at: day(3) })
  __recordUsage(ctx.db, { personId: null, process: 'judge', model: 'claude-opus-5-5', input_tokens: 999_999, output_tokens: 1, at: day(40) })
})
after(() => server.close())

test('price table and cost: known models priced, unknown model → null', () => {
  assert.equal(priceFor('claude-opus-5-5'), PRICES['claude-opus-5-5'])
  assert.equal(priceFor('claude-opus-5-5-20260401'), PRICES['claude-opus-5-5'], 'prefix match')
  assert.equal(priceFor('gpt-oss'), null)
  assert.equal(costUsd('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 24)
  assert.equal(costUsd('claude-haiku-5-5', { input_tokens: 1_000_000 }), 0.1)
  assert.equal(costUsd('mystery-model', { input_tokens: 1_000_000 }), null)
})

test('__recordUsage inserts a row with computed cost; unpriced model keeps cost_usd null', () => {
  const r = __recordUsage(ctx.db, { personId: eileen.id, process: 'query:availability', model: 'claude-opus-5-5', input_tokens: 500_000, output_tokens: 50_000, at: day(10) })
  const row = ctx.db.get('select * from llm_usage where id = ?', r.id)
  assert.equal(row.person_id, eileen.id)
  assert.equal(row.process, 'query:availability')
  assert.ok(Math.abs(row.cost_usd - 3) < 1e-9, '0.5M in @ $4 + 50k out @ $20 = $3')
  const u = __recordUsage(ctx.db, { personId: eileen.id, process: 'query:availability', model: 'local-llama', input_tokens: 10, output_tokens: 10, at: day(10) })
  assert.equal(ctx.db.get('select cost_usd from llm_usage where id = ?', u.id).cost_usd, null)
  ctx.db.run('delete from llm_usage where id in (?, ?)', r.id, u.id)
})

test('usage() aggregates by person, process, day, person-day, process-day', () => {
  const byPerson = ctx.llm.usage({ since: day(30), groupBy: 'person' })
  const j = byPerson.find(r => r.person_id === jess.id), e = byPerson.find(r => r.person_id === eileen.id)
  assert.equal(j.name, 'Jess')
  assert.equal(j.calls, 3)
  assert.equal(j.input_tokens, 13_000)
  assert.equal(j.output_tokens, 1300)
  assert.equal(j.cache_read_tokens, 500)
  // judge: (3000*4 + 300*20 + 500*0.2)/1e6 = 0.0181; agent: (10000*2 + 1000*10)/1e6 = 0.03
  assert.ok(Math.abs(j.cost_usd - 0.0481) < 1e-9, `jess cost ${j.cost_usd}`)
  assert.equal(e.calls, 1)
  assert.ok(Math.abs(e.cost_usd - 0.011) < 1e-9)
  assert.equal(byPerson.length, 2, 'the 40-day-old row is outside the window')

  const byProcess = Object.fromEntries(ctx.llm.usage({ since: day(30), groupBy: 'process' }).map(r => [r.process, r]))
  assert.deepEqual(Object.keys(byProcess).sort(), ['agent-chat', 'judge', 'source:matrix'])
  assert.equal(byProcess.judge.calls, 2)
  assert.equal(byProcess.judge.duration_ms, 1700)

  const byDay = ctx.llm.usage({ since: day(30), groupBy: 'day' })
  assert.equal(byDay.length, 3)
  assert.equal(byDay.at(-1).day, day(0).slice(0, 10))
  assert.equal(byDay.at(-1).calls, 2)

  const pd = ctx.llm.usage({ since: day(30), groupBy: 'person-day' })
  assert.equal(pd.length, 3)
  assert.ok(pd.every(r => r.person_id && /^\d{4}-\d{2}-\d{2}$/.test(r.day)))
  const prd = ctx.llm.usage({ since: day(30), groupBy: 'process-day' })
  assert.equal(prd.length, 3)

  // since/until window and the 40-day row
  assert.equal(ctx.llm.usage({ since: day(60), groupBy: 'process' }).find(r => r.process === 'judge').calls, 3)
  assert.equal(ctx.llm.usage({ since: day(60), until: day(35), groupBy: 'process' }).length, 1)
  assert.throws(() => ctx.llm.usage({ groupBy: 'model' }), /unknown groupBy/)
})

test('usageSummary returns total plus the three breakdowns', () => {
  const s = ctx.llm.usageSummary(day(30))
  assert.equal(s.total.calls, 4)
  assert.equal(s.total.input_tokens, 113_000)
  assert.equal(s.total.unpriced_calls, 0)
  assert.ok(Math.abs(s.total.cost_usd - 0.0591) < 1e-9)
  assert.equal(s.byPerson.length, 2)
  assert.equal(s.byProcess.length, 3)
  assert.equal(s.byDay.length, 3)
  const empty = ctx.llm.usageSummary(new Date(Date.now() + 864e5).toISOString())
  assert.equal(empty.total.calls, 0)
  assert.equal(empty.total.cost_usd, 0)
})

test('admin overview carries usage, 7d person-day rows and per-person usage7d; token required', async () => {
  assert.equal((await get('/api/admin/overview', null)).status, 401)
  assert.equal((await get('/api/admin/overview', 'wrong')).status, 401)
  const { status, body } = await get('/api/admin/overview')
  assert.equal(status, 200)
  assert.equal(body.usage.total.calls, 4)
  assert.equal(body.usage.byProcess.find(r => r.process === 'judge').calls, 2)
  assert.equal(body.usagePersonDay7d.length, 3)
  const j = body.people.find(p => p.id === jess.id), e = body.people.find(p => p.id === eileen.id)
  assert.equal(j.usage7d.calls, 3)
  assert.equal(j.usage7d.tokens, 13_000 + 1300 + 500)
  assert.ok(Math.abs(j.usage7d.costUsd - 0.0481) < 1e-9)
  assert.equal(e.usage7d.calls, 1)
  // ?token= also works
  const r = await fetch(`${base}/api/admin/overview?token=${ADMIN}`)
  assert.equal(r.status, 200)
})

test('GET /api/admin/usage returns the raw aggregation with since/groupBy', async () => {
  let { status, body } = await get('/api/admin/usage?since=2d&groupBy=person')
  assert.equal(status, 200)
  assert.equal(body.groupBy, 'person')
  assert.equal(body.rows.length, 1, 'only Jess has calls in the last 2 days')
  assert.equal(body.rows[0].person_id, jess.id)
  assert.equal(body.rows[0].calls, 3)
  ;({ body } = await get('/api/admin/usage'))
  assert.equal(body.groupBy, 'process')
  assert.equal(body.rows.length, 3)
  ;({ body } = await get(`/api/admin/usage?since=${encodeURIComponent(day(60))}&groupBy=day`))
  assert.equal(body.rows.length, 4)
  assert.equal((await get('/api/admin/usage?groupBy=nope')).status, 400)
  assert.equal((await get('/api/admin/usage', null)).status, 401)
  assert.equal(parseSince('bogus').slice(0, 10), day(30).slice(0, 10))
  assert.equal(parseSince('12h').slice(0, 13), day(0.5).slice(0, 13))
})

test('judge passes meta { personId, process: "judge" } to ctx.llm.json', async () => {
  ctx.people.setRel(jess.id, eileen.id, { wantMore: true })
  ctx.people.setRel(eileen.id, jess.id, { wantMore: true })
  const calls = []
  const real = ctx.llm
  ctx.llm = {
    ...real, enabled: true,
    async json(args, meta) { calls.push({ args, meta }); return { verdict: 'suppress', reasoning: 'stub' } },
  }
  try {
    await ctx.opportunities.add('test', { kind: 'nearby', participants: [jess.id, eileen.id], primary: jess.id, summary: 'Jess and Eileen are 40m apart', evidence: [] })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].meta, { personId: jess.id, process: 'judge' })
    assert.match(calls[0].args.system, /judgement layer/)
  } finally { ctx.llm = real }
})

test('availability query passes meta with the answering person', async () => {
  const calls = []
  const real = ctx.llm
  ctx.llm = { ...real, enabled: true, async json(args, meta) { calls.push(meta); return { answer: 'likely', confidence: 0.7, reason: 'free-ish' } } }
  try {
    ctx.sources.connect(eileen.id, 'icsCalendar', { urls: ['https://a.test/x.ics'] })
    const ans = await ctx.query.answerLocal({ from: jess.id, to: eileen.id, kind: 'availability', text: 'free tonight?' })
    assert.equal(ans.answer, 'likely')
    assert.deepEqual(calls, [{ personId: eileen.id, process: 'query:availability' }])
  } finally { ctx.llm = real }
})

test('makeLlm records a row per SDK call, including one per agent turn', async () => {
  const { makeLlm } = await import('../core/llm.js')
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const llm = makeLlm({ ANTHROPIC_API_KEY: 'sk-test', JUDGE_MODEL: 'claude-opus-5-5', AGENT_MODEL: 'claude-sonnet-5-5' }, ctx.db)
  // No network: patch the SDK's Messages resource. First agent turn asks for a tool, every other call ends the turn.
  const MessagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: 'sk-test' }).messages)
  const realCreate = MessagesProto.create
  let n = 0
  MessagesProto.create = async params => {
    n++
    if (params.tools && n === 2) return { model: params.model, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'ping', input: {} }], usage: { input_tokens: 300, output_tokens: 30 } }
    return { model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 } }
  }
  const before = ctx.db.get('select count(*) c from llm_usage').c
  try {
    const out = await llm.json({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] }, { personId: jess.id, process: 'judge' })
    assert.deepEqual(out, { ok: true })
    const { text } = await llm.agent({ system: 'sys', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'ping', description: 'p', input_schema: { type: 'object', properties: {} }, run: () => 'pong' }] }, { personId: eileen.id, process: 'agent-chat' })
    assert.equal(text, '{"ok":true}')
  } finally { MessagesProto.create = realCreate }
  assert.equal(n, 3)
  assert.equal(ctx.db.get('select count(*) c from llm_usage').c, before + 3, 'one json call + two agent turns')
  const rows = ctx.db.all('select * from llm_usage where cache_write_tokens = 5 or input_tokens = 300 order by created_at')
  const judge = rows.find(r => r.process === 'judge')
  assert.equal(judge.person_id, jess.id)
  assert.equal(judge.model, 'claude-opus-5-5')
  assert.equal(judge.cache_read_tokens, 50)
  assert.ok(judge.duration_ms >= 0)
  assert.ok(Math.abs(judge.cost_usd - (100 * 4 + 10 * 20 + 50 * 0.2 + 5 * 5) / 1e6) < 1e-12)
  const agentRows = rows.filter(r => r.process === 'agent-chat')
  assert.equal(agentRows.length, 2)
  assert.ok(agentRows.every(r => r.person_id === eileen.id && r.model === 'claude-sonnet-5-5'))
  assert.deepEqual(agentRows.map(r => r.input_tokens).sort(), [100, 300])
})
