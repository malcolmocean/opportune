import { EventEmitter } from 'node:events'
import { openDb } from './db.js'
import { loadPlugins } from './plugins.js'
import { makePeople } from './people.js'
import { makeObservations } from './observations.js'
import { makeOpportunities } from './opportunities.js'
import { makeJudge } from './judge.js'
import { makeNudges } from './nudges.js'
import { makeQuery } from './query.js'
import { makeFederation } from './federation.js'
import { makeAgent } from './agent.js'
import { makeSources } from './sources.js'
import { makeDigest } from './cron.js'
import { makeLlm } from './llm.js'
import { log } from './log.js'
import * as geo from './geo.js'

// Everything a plugin gets: ctx.db, ctx.people, ctx.observations, ctx.query, ctx.llm, ctx.nudges, ctx.geo, ctx.log(...)
export async function buildContext(env = process.env, { dbPath } = {}) {
  const db = openDb(dbPath)
  const ctx = { db, env, events: new EventEmitter(), log, geo }
  ctx.plugins = await loadPlugins()
  ctx.llm = makeLlm(env)
  ctx.people = makePeople(db, env, ctx.events)
  ctx.observations = makeObservations(db, ctx)
  ctx.opportunities = makeOpportunities(db, ctx)
  ctx.judge = makeJudge(db, ctx)
  ctx.nudges = makeNudges(db, ctx)
  ctx.query = makeQuery(db, ctx)
  ctx.federation = makeFederation(db, ctx)
  ctx.agent = makeAgent(db, ctx)
  ctx.sources = makeSources(db, ctx)
  ctx.digest = makeDigest(db, ctx)
  for (const p of [...Object.values(ctx.plugins.sources), ...Object.values(ctx.plugins.triggers), ...Object.values(ctx.plugins.queries)]) {
    if (p.init) await p.init(ctx)
  }
  return ctx
}
