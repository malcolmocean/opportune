# Writing an opportune plugin

A plugin is a directory with an `index.js` whose default export is a manifest object.
The loader (`core/plugins.js`) picks up every `sources/*`, `triggers/*`, `channels/*`,
`queries/*` directory at boot. Drop a `.disabled` file in a dir to skip it. Plugins may
have their own `package.json` deps (add them to the root package.json for now).

House style: ES modules, 2 spaces, single quotes, **no semicolons**, `.js` on imports.

Every plugin function receives `ctx` first:

| ctx member | what |
|---|---|
| `ctx.db` | sqlite wrapper: `get/all/run/insert/kvGet/kvSet` (see `core/db.js`) |
| `ctx.people` | `addContacts(ownerId, [{name, emails, phones}])`, `contactName(ownerId, {email})`, `ownersWithContact('email', v)`, `get(id)`, `all()`, `friendsOf(id)` (outgoing edges), `connections(id)` (either direction, with `.outgoing`/`.incoming`), `home(id)`, `rel(from,to)` (has `.effectiveGrants`), `setRel`, `identities(id)`, `bind`, `places(id)`, `addPlace`, `invite`, `policy(id)`, `nodeUrl` |
| `ctx.observations` | `ingest(personId, sourceId, obs[])`, `latest(personId, kind, {within, activeOnly})`, `recent(personId, {kinds, since, limit})`, `eventsIn(personId, startIso, endIso)` |
| `ctx.query` | `ask({from,to,kind,text,window})`, `fanout(from, {...})` |
| `ctx.nudges` | `send(personId, {text, actions, decisionId})`, `respond(nudgeId, actionKey)` |
| `ctx.judge` | `rate(decisionId, 'good'|'bad', note)` |
| `ctx.llm` | `complete({system,messages})`, `json({...})`, `agent({system,messages,tools})`; `ctx.llm.enabled` |
| `ctx.sources` | `forPerson(id)`, `connect(personId, sourceId, config)`, `ingestUrl(sourceConfig)` |
| `ctx.geo` | `distanceM(a,b)`, `fmtDistance`, `minutesAgo` |
| `ctx.events` | EventEmitter: `nudge:response`, `query:answered`, `federation:suggest`, `identity:bound` {personId, channel, externalId}, `contacts:added` |
| `ctx.plugins` | all loaded manifests by kind and id |
| `ctx.log(name)` | logger |

## Observation (what sources produce, what triggers consume)

```js
{ kind, at, until?, data, raw?, dedupeKey? }
kind: 'location' { lat, lng, acc?, speed?, placeId?, placeName? }
      'event'    { title, start?, end?, location?, attendees?: [{name, email}], url?, provider, busy? }
      'status'   { porchlight: 'open'|'closed'|'ask', note? }   // `until` matters
      'intent'   { text, kind?, window?, people? }
      'motion'   { state: 'still'|'walking'|'driving'|'transit' }
      'mention'  { text, inferredPlace?, inferredWindow?, provider }   // tweets, chat
```
Core adds `id, person_id, source_id, created_at`. If `dedupeKey` is set, re-ingesting the
same key updates in place and only fires triggers if `data` changed. **Use dedupeKey for
anything polled** (events: `uid@start`; tweets: tweet id).

## Source

```js
export default {
  id: 'gmailRsvp', name: 'Event emails (Gmail)', description: '...', repo: 'https://...',
  kinds: ['event'],
  intervalMin: 20,                        // for poll()
  setup: [                                // rendered by onboarding, stored in config
    { key: 'email', type: 'text', label: 'Gmail address' },
    { key: 'appPassword', type: 'secret', label: 'App password (myaccount.google.com/apppasswords)' },
    { key: 'app', type: 'choice', label: '...', choices: [...], instructions: { choice: 'text' } },
  ],
  async init?(ctx) {},                                        // once at boot
  async poll?(ctx, person, config, lastPollIso) → Observation[],
  async ingest?(ctx, person, config, body, req) → Observation[],   // POST /ingest/:id/:token
}
```
Setup `type`: `text | secret | url | choice | install-app`. For `install-app`, onboarding
shows `ctx.sources.ingestUrl(sourceConfig)` for the person to paste into the app.

## Trigger

```js
export default {
  id: 'porchlightProximity', name: '...',
  on: ['location', 'status'],              // fire synchronously on these observation kinds
  intervalMin: 60,                         // and/or
  run?(ctx, { observation, person }) → Opportunity[],
  runCron?(ctx) → Opportunity[],
}
```
**No LLM calls in triggers.** They are cheap deterministic detectors. Emit:
```js
{ kind, participants: [personId...], primary?: personId /* who to tell; null = each */,
  summary: 'one plain sentence with names, place, time',   // what the Judge reads
  evidence: [...],  dedupeKey?: 'stable string per real-world occurrence',  expiresAt?: iso }
```
The Judge (`core/judge.js`) gates (quiet hours, daily cap, wantMore filter), then one
LLM call decides suppress / nudge / ask. Every verdict is logged for review.

## Query

```js
export default {
  id: 'dropin', kind: 'dropin', sensitivity: 2, grant: 'askDropin',
  description: '...',
  async answer(ctx, { from, to, relationship, text, window, context }) →
    { answer: 'yes'|'likely'|'unlikely'|'no'|'unsupported', confidence, reason?, revealed?: {}, suggest?: { plugin, repo, setup } }
}
```
`kind` is a permission class. Core already checked `relationship.effectiveGrants[grant]`
and rate limits before calling you. Reveal only what the tier allows. `relationship` is
to→from (the answerer's view of the asker); it carries `note` and `effectiveGrants`.
Return `unsupported` + `suggest` when the person lacks the data; federation turns that
into a "want to add this?" nudge on their side.

## Channel

```js
export default {
  id: 'fcm', name: '...', setup: [...],
  async start(ctx) {},                                   // boot: start bot, load creds
  async send(ctx, person, identity, nudge) → { externalId },   // nudge.actions: [{key,label}]
  deepLink?(ctx, inviteCode) → url,                      // for /i/:code landing page
}
```
When the human taps an action, call `ctx.nudges.respond(nudge.id, actionKey)`. Action
keys `yes`/`no`/`bad` have built-in meaning (bad = rate decision bad). `wish:<decisionId>`
means "should have told me" (rate good → the suppression was wrong). Identities: find the
person with `ctx.people.identify('fcm', token)`; bind with `ctx.people.bind(personId, 'fcm', token)`.

## Testing locally

```
cp .env.example .env   # ANTHROPIC_API_KEY optional; without it Judge passes everything through
pnpm dev
node scripts/seed.js   # two people, places, a relationship, sample events
curl -X POST localhost:3400/ingest/locationPost/<token> -H 'content-type: application/json' -d '{"lat":37.76,"lng":-122.43}'
```
Unit tests: `node --test tests/`. Build a context against an in-memory db with
`buildContext(process.env, { dbPath: ':memory:' })`.
