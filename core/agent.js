import { uid, now, parseRow } from './db.js'

// Owner-facing agent: the thing you chat with. Tools over your own data and your friends' agents.
export function makeAgent(db, ctx) {
  const history = (personId, limit = 20) => db.all('select role, content from chat_log where person_id = ? order by created_at desc limit ?', personId, limit).reverse().map(r => ({ role: r.role, content: JSON.parse(r.content) }))
  const remember = (personId, role, content) => db.insert('chat_log', { id: uid(), person_id: personId, role, content, created_at: now() })

  const A = {
    tools(person) {
      const me = person.id
      return [
        { name: 'my_recent_observations', description: 'What the system currently knows about me: recent location, calendar events, status, intents.', input_schema: { type: 'object', properties: { kinds: { type: 'array', items: { type: 'string' } }, hours: { type: 'number' } } },
          run: ({ kinds, hours = 48 }) => ctx.observations.recent(me, { kinds, since: new Date(Date.now() - hours * 3600e3).toISOString(), limit: 40 }).map(o => ({ kind: o.kind, at: o.at, until: o.until, data: o.data })) },
        { name: 'my_friends', description: 'List my friends on the system with tier, wantMore, note, and what sources they have.', input_schema: { type: 'object', properties: {} },
          run: () => ctx.people.friendsOf(me).map(f => ({ id: f.id, name: f.display_name, tier: f.tier, wantMore: !!f.want_more, note: f.note, remote: !!f.remote, theyWantMore: !!ctx.people.rel(f.id, me)?.want_more })) },
        { name: 'update_relationship', description: 'Change how I relate to a friend: wantMore, tier, note, travel (0-3, private), grants.', input_schema: { type: 'object', properties: { friendId: { type: 'string' }, wantMore: { type: 'boolean' }, tier: { type: 'string' }, note: { type: 'string' }, travel: { type: 'number' }, grants: { type: 'object' } }, required: ['friendId'] },
          run: ({ friendId, ...patch }) => ctx.people.setRel(me, friendId, patch) },
        { name: 'ask_friend_agent', description: 'Ask one friend\'s agent a question. kind is the permission class: availability, dropin, plans, whereabouts, freeform.', input_schema: { type: 'object', properties: { friendId: { type: 'string' }, kind: { type: 'string' }, text: { type: 'string' }, window: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } } } }, required: ['friendId', 'kind', 'text'] },
          run: ({ friendId, kind, text, window }) => ctx.query.ask({ from: me, to: friendId, kind, text, window }) },
        { name: 'whos_around', description: 'Fan out an availability question to all my friends (or a subset) and get a ranked shortlist.', input_schema: { type: 'object', properties: { text: { type: 'string' }, window: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } } }, friendIds: { type: 'array', items: { type: 'string' } } }, required: ['text'] },
          run: ({ text, window, friendIds }) => ctx.query.fanout(me, { kind: 'availability', text, window, toIds: friendIds }) },
        { name: 'set_status', description: 'Set my porchlight: open (drop-ins welcome), closed, or ask. Optional note and until (ISO).', input_schema: { type: 'object', properties: { porchlight: { type: 'string', enum: ['open', 'closed', 'ask'] }, note: { type: 'string' }, until: { type: 'string' } }, required: ['porchlight'] },
          run: ({ porchlight, note, until }) => ctx.observations.ingest(me, 'manual', [{ kind: 'status', data: { porchlight, note }, until: until || new Date(Date.now() + 4 * 3600e3).toISOString() }]) },
        { name: 'record_intent', description: 'Record something I want: an outing, a standing hangout, a call, a walk. The system will try to match it.', input_schema: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string' }, window: { type: 'object' }, people: { type: 'array', items: { type: 'string' } } }, required: ['text'] },
          run: ({ text, kind, window, people }) => ctx.observations.ingest(me, 'manual', [{ kind: 'intent', data: { text, kind, window, people } }]) },
        { name: 'make_invite', description: 'Create a one-time invite link for a person I want to see more of.', input_schema: { type: 'object', properties: { name: { type: 'string' }, wantMore: { type: 'boolean' } }, required: ['name'] },
          run: ({ name, wantMore = true }) => ctx.people.invite(me, { inviteeName: name, wantMore }) },
        { name: 'review_decisions', description: 'Show recent judgement calls (nudges sent and things kept quiet) so I can rate them.', input_schema: { type: 'object', properties: { hours: { type: 'number' } } },
          run: ({ hours = 48 }) => db.all(`select d.id, d.verdict, d.reasoning, d.rating, d.created_at, o.summary from decisions d left join opportunities o on o.id = d.opportunity_id where d.person_id = ? and d.created_at > ? order by d.created_at desc limit 30`, me, new Date(Date.now() - hours * 3600e3).toISOString()) },
        { name: 'rate_decision', description: 'Rate a past decision good or bad with an optional note. This trains future judgement.', input_schema: { type: 'object', properties: { decisionId: { type: 'string' }, rating: { type: 'string', enum: ['good', 'bad'] }, note: { type: 'string' } }, required: ['decisionId', 'rating'] },
          run: ({ decisionId, rating, note }) => { ctx.judge.rate(decisionId, rating, note); return { ok: true } } },
        { name: 'my_sources', description: 'Which data sources I have connected, and which are available to add.', input_schema: { type: 'object', properties: {} },
          run: () => ({ connected: ctx.sources.forPerson(me).map(s => ({ source: s.source_id, enabled: !!s.enabled, lastPoll: s.last_poll_at, lastError: s.last_error })), available: Object.values(ctx.plugins.sources).map(s => ({ id: s.id, name: s.name, description: s.description })) }) },
      ]
    },
    system(person) {
      return `You are ${person.display_name || 'your person'}'s agent in "opportune", which helps friends spend time together at low marginal cost: joining each other's existing plans, dropping in when nearby, carpooling to the same event.
Be brief and warm. Prefer doing (call a tool) over describing. When asked who's around, call whos_around and present a tight shortlist with one-line reasons; offer to draft a text for friends not on the system.
Respect the person's filter: only suggest people they've marked wantMore or who marked them, unless asked otherwise.
Never reveal a friend's private 'travel' number or notes about them. Today is ${now()}; the person's timezone is ${person.tz}.`
    },
    async chat(personId, text) {
      const person = ctx.people.get(personId)
      remember(personId, 'user', text)
      const { text: reply } = await ctx.llm.agent({ system: A.system(person), messages: history(personId), tools: A.tools(person) })
      remember(personId, 'assistant', reply)
      return reply
    },
  }
  return A
}
