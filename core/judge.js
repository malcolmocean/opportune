import { uid, now } from './db.js'
import { localHour } from './geo.js'
import { log } from './log.js'
const L = log('judge')

// One LLM call per opportunity. Deterministic gates first (quiet hours, daily cap,
// mutual filter), then the model decides suppress | nudge | ask. Every verdict,
// including suppress, is a Decision row so it can be reviewed and rated.
export function makeJudge(db, ctx) {
  const J = {
    async consider(opp) {
      const targets = opp.primary_id ? [opp.primary_id] : opp.participants
      for (const personId of targets) {
        const person = ctx.people.get(personId)
        if (!person || person.remote) continue
        const gate = J.gate(person, opp)
        if (gate) { J.record(personId, opp, 'suppress', `gate: ${gate}`); continue }
        const verdict = await J.decide(person, opp)
        const other = opp.participants.find(p => p !== personId)   // the nudge is "from" the other participant, for federation signing
        if (verdict.verdict === 'ask' && !other) {   // single-participant opportunity (e.g. contact on a guest list): nobody to ask, so just nudge
          verdict.verdict = 'nudge'
          verdict.text = verdict.text || verdict.ask?.text || opp.summary
          verdict.actions = verdict.actions?.length ? verdict.actions : defaultActions(opp)
          verdict.reasoning = `${verdict.reasoning || ''} (nobody to ask; nudged instead)`.trim()
        }
        const d = J.record(personId, opp, verdict.verdict, verdict.reasoning)
        if (verdict.verdict === 'nudge') {
          await ctx.nudges.send(personId, { text: verdict.text, actions: verdict.actions || [], decisionId: d.id, expiresAt: opp.expires_at }, { from: other })
        } else if (verdict.verdict === 'ask' && verdict.ask) {
          // ask the other participant's agent first, then nudge with the answer
          const ans = await ctx.query.ask({ from: personId, to: other, kind: verdict.ask.kind || 'availability', text: verdict.ask.text, context: opp.summary })
          const follow = await J.decide(person, opp, { askedKind: verdict.ask.kind, answer: ans })
          const d2 = J.record(personId, opp, follow.verdict, `after asking ${J.nameOf(other)} (${ans.answer}): ${follow.reasoning}`)
          if (follow.verdict === 'nudge') await ctx.nudges.send(personId, { text: follow.text, actions: follow.actions || [], decisionId: d2.id, expiresAt: opp.expires_at }, { from: other })
        }
      }
    },
    nameOf(id) { return ctx.people.get(id)?.display_name || 'someone' },
    gate(person, opp) {
      const pol = ctx.people.policy(person.id)
      const hour = localHour(person.tz)
      const { start, end } = pol.quietHours || {}
      if (start != null && (start > end ? (hour >= start || hour < end) : (hour >= start && hour < end))) return 'quiet hours'
      // the cap counts Judge nudges only (decision_id set); digests, veto nudges and query replies don't eat into it
      const today = db.get(`select count(*) c from nudges where person_id = ? and decision_id is not null and created_at > ?`, person.id, new Date(Date.now() - 864e5).toISOString()).c
      if (today >= (pol.maxNudgesPerDay ?? 6)) return 'daily nudge cap'
      // wantMore filter: at least one side of each pair must want more of the other
      if (opp.kind === 'contactJoined') return null   // the whole point is that there's no relationship yet
      for (const other of opp.participants.filter(p => p !== person.id)) {
        const a = ctx.people.rel(person.id, other), b = ctx.people.rel(other, person.id)
        if (!a && !b) return `no relationship with ${J.nameOf(other)}`
        if (!(a?.want_more || b?.want_more)) return `neither side marked wantMore for ${J.nameOf(other)}`
      }
      return null
    },
    async decide(person, opp, extra = {}) {
      if (!ctx.llm.enabled) {
        // JUDGE_STUB=ask makes the stub ask the other participant's agent first (kind from JUDGE_STUB_KIND, default dropin), for tests
        if (ctx.env.JUDGE_STUB === 'ask' && !extra.answer) return { verdict: 'ask', reasoning: 'stub: ask first', ask: { kind: ctx.env.JUDGE_STUB_KIND || 'dropin', text: opp.summary } }
        if (extra.answer && ['no', 'unlikely'].includes(extra.answer.answer)) return { verdict: 'suppress', reasoning: `stub: other side said ${extra.answer.answer}` }
        return { verdict: 'nudge', reasoning: 'llm disabled, passing through', text: extra.answer ? `${opp.summary} (${extra.answer.reason})` : opp.summary, actions: defaultActions(opp) }
      }
      const others = opp.participants.filter(p => p !== person.id).map(id => {
        const p = ctx.people.get(id), r = ctx.people.rel(person.id, id)
        return { id, name: p?.display_name, tier: r?.tier, wantMore: !!r?.want_more, note: r?.note, theyWantMore: !!ctx.people.rel(id, person.id)?.want_more, story: p?.story || null }
      })
      const recent = db.all(`select n.text, n.response, n.created_at from nudges n where n.person_id = ? order by created_at desc limit 8`, person.id)
      const ratings = db.all(`select d.verdict, d.reasoning, d.rating, d.rating_note, o.summary from decisions d left join opportunities o on o.id = d.opportunity_id where d.person_id = ? and d.rating is not null order by d.rated_at desc limit 12`, person.id)
      const myNow = ctx.observations.recent(person.id, { limit: 6 })
      const system = `You are the judgement layer of "opportune", a system that helps friends spend time together at low marginal cost.
You decide, for ONE person, whether a detected opportunity is worth a nudge right now.
The person's time and attention are precious: a bad nudge costs trust, a missed great one costs a hangout. Err toward quiet for low-value or ambiguous, but do not be timid about genuinely good, time-sensitive ones.
Never reveal one participant's private settings (travel willingness, notes) to another. The nudge text goes to the person named below only.
Write nudge text in a warm, brief, slightly playful voice. One or two sentences. Include the concrete fact (who/where/when). Suggest the cheapest action.
Verdicts: "suppress" (log only), "nudge" (send text now), "ask" (first ask the other participant's agent a question of kind availability|dropin|plans, then decide). When otherParticipants is empty there is nobody to ask: choose suppress or nudge.
Each participant's "story" is plain text they wrote about what they are generally up for and when (free weeknights, hates calls, Saturday mornings are family). It is not private; weigh it for both the person and the others.
Evidence may carry arrivedBy: "car" on a location: that person is in or just out of a car near the place, so say so and expect a shorter, more deliberate visit than a passer-by on foot.
Past ratings from this person on your earlier calls are the strongest signal of what they want. A rating is about the verdict, not the event: "bad" on a suppress means "I should have been nudged"; "bad" on a nudge means "you should have stayed quiet"; "good" means the call was right.`
      const user = {
        person: { id: person.id, name: person.display_name, tz: person.tz, policy: ctx.people.policy(person.id), story: person.story || null },
        opportunity: { kind: opp.kind, summary: opp.summary, evidence: opp.evidence, expiresAt: opp.expires_at, trigger: opp.trigger_id },
        otherParticipants: others,
        personsRecentObservations: myNow.map(o => ({ kind: o.kind, at: o.at, data: o.data })),
        recentNudgesSent: recent,
        pastRatings: ratings,
        ...extra,
        now: now(),
        output: { verdict: 'suppress|nudge|ask', reasoning: 'one sentence', text: 'nudge text if nudge', actions: [{ key: 'yes', label: 'On it' }, { key: 'no', label: 'Not now' }], ask: { kind: 'availability', text: 'question for the other agent' } },
      }
      const out = await ctx.llm.json({ system, messages: [{ role: 'user', content: JSON.stringify(user, null, 1) }] }, { personId: person.id, process: 'judge' })
      if (!out?.verdict) return { verdict: 'suppress', reasoning: 'model returned nothing parseable' }
      if (out.verdict === 'nudge' && !out.actions?.length) out.actions = defaultActions(opp)
      return out
    },
    record(personId, opp, verdict, reasoning) {
      const row = { id: uid(), person_id: personId, opportunity_id: opp.id, verdict, reasoning, created_at: now() }
      db.insert('decisions', row)
      L.info(`${verdict} for ${personId}: ${reasoning?.slice(0, 100)}`)
      return row
    },
    rate(decisionId, rating, note) {
      db.run('update decisions set rating = ?, rating_note = ?, rated_at = ? where id = ?', rating, note || null, now(), decisionId)
    },
    // Decisions this person may review (digest, manage page, admin). Relationship gates are excluded: they
    // would reveal a friend's presence/place to someone that friend never opted in to sharing with.
    reviewable(personId, sinceIso = null, { limit = 50, verdict = null } = {}) {
      const conds = ['d.person_id = ?', `d.reasoning not like 'gate: no relationship%'`, `d.reasoning not like 'gate: neither side%'`], p = [personId]
      if (sinceIso) { conds.push('d.created_at > ?'); p.push(sinceIso) }
      if (verdict) { conds.push('d.verdict = ?'); p.push(verdict) }
      return db.all(`select d.*, o.summary, o.kind, o.trigger_id, o.expires_at from decisions d left join opportunities o on o.id = d.opportunity_id where ${conds.join(' and ')} order by d.created_at desc limit ?`, ...p, limit)
    },
    // for the daily digest: what we stayed quiet about
    suppressedSince(personId, sinceIso) { return J.reviewable(personId, sinceIso, { verdict: 'suppress', limit: 10 }) },
  }
  return J
}

const defaultActions = () => [{ key: 'yes', label: 'On it' }, { key: 'no', label: 'Not now' }, { key: 'bad', label: "Shouldn't have bugged me" }]
