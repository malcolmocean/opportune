# opportune — design

> What am I already doing, that would be made better by adding other people at low
> marginal cost to them, or by joining their plans at low marginal cost to me?

Hackathon design doc, 2026-10-08. Optimizing for: multiple wins at N=1 and N=2,
a core that every later pattern plugs into, and a protocol that federates.

## 1. Pattern catalog

N = how many people need to be on the system for the pattern to pay off.
AI = irrelevant (deterministic), helpful (nicer with LLM), critical (doesn't work without).
Access = what data the system needs, and from whom (me / friend / both).

| # | Pattern | N | AI | Access needed |
|---|---|---|---|---|
| 1 | **Co-attendance from RSVP emails**: "X is also going to Y" | 1 | helpful (name matching) | my Gmail (Partiful/Luma/Eventbrite) + my calendar |
| 2 | **"X would like Y"**: event I RSVP'd matches a friend's taste | 1 | critical (taste inference) | my Gmail + my calendar; friend's past events if they're on |
| 3 | **Nearby alert via Google Maps sharing** (locationsharinglib) | 1 | irrelevant | my Google cookies; friends already sharing Maps location with me |
| 4 | **Out-of-towner is in town** for my party (plans or location) | 1–2 | helpful | my calendar/RSVPs + friend's location, calendar, or tweets |
| 5 | **Tweets as whereabouts**: "I'm in SF this week" | 1 | critical (extract plans from text) | community-archive feed for friends |
| 6 | **Weekly 3-for-3 interview**: tell me 3 things, get 3 things | 1 | critical | nothing beyond chat |
| 7 | **Routine coincidence**: "you go to GO Tuesdays, Eileen's home Tuesdays" | 1–2 | helpful (phrasing); detection is stats | weeks of my location + friend's location or porchlight history |
| 8 | **Porchlight**: declared drop-in windows / "home & open now" | 2 | irrelevant | friend's status + my location |
| 9 | **Agent-answered drop-in**: "Jess is a block away, ok?" → default-yes w/ veto | 2 | critical (judging interruptibility) | my location; friend's location, calendar, policy |
| 10 | **Both going to same event → carpool / sit together** | 2 | irrelevant | both calendars or RSVPs |
| 11 | **"Person I want more of is going to X Saturday"** | 2 | helpful | friend's calendar/RSVPs; my wantMore list |
| 12 | **Standing-slot finder**: "Mon/Tue couples dinner", "Eileen's free Thursdays" | 2 | helpful (NL intent); matching is calendar math | both calendars + my stated intent |
| 13 | **Friend nearby right now** (both on system) | 2 | helpful (worth a buzz?) | both locations |
| 14 | **Friend at a known third place near me** (coworking, playground) + how long | 2 | helpful | friend's location + calendar; named places |
| 15 | **Friend driving alone → call them** | 2 | helpful | friend's motion state (phone activity API) + calendar; my availability |
| 16 | **20-min phone call with *a* friend** | 3+ | critical (who, now) | several friends' availability |
| 17 | **Who's around tonight?** fan-out query | 2, good at 5 | critical (each agent judges its owner) | each friend's calendar + location + policy |
| 18 | **Spare ticket / "come to Dolores, vibes immaculate"** broadcast | 2, good at 5 | helpful (who to target) | my intent; friends' locations/availability |
| 19 | **Stated intent matching**: "want to see Odyssey this week" | 2+ | critical | intents from several people + calendars |
| 20 | **Message elevation**: friend texts "near your house, drop in?" → surfaced | 1 (me only) | critical | my chat (Beeper/Matrix) |
| 21 | **Plan inference from chat**: "I'll be in Oakland Sat" | 1 (me only) | critical | my chat |
| 22 | **Trusted-tier map / plans view**: just see where trusted friends are | 2 | irrelevant | friend's location + calendar, with grant |
| 23 | **Friend-of-friend nearby → intro** | ~20 | critical (is this intro good?) | locations + both friends' policies + intermediary's blessing |
| 24 | **Walk-route nudge**: "go into that cafe" | ~50 | critical | dense location coverage |
| 25 | **Conference co-presence** (BLE, 10 ft) | ~20 at one venue | helpful | native app with BLE |
| 26 | **Spotify → "Vulfpeck is coming, ping James"** | 2 | helpful | Spotify for both + event feeds |
| 27 | **Secretary negotiation**: hidden pairwise willingness-to-travel | 2 | critical | both willingness scalars + both locations/plans |
| 28 | **Agent-pollable endpoint**: your AI asks my AI, rate-limited | 2 | critical | whatever the owner's policy exposes |

Patterns 1–7 pay off for a single user with their own data. 8–15, 17, 22 pay off
at N=2. That's the game: ship 1–3 so you get wins alone, and each win mints an
invite ("Jess wants to see you more; join so it can find times").

## 2. v1 wins (confirmed)

**N=1, works tonight for Malcolm:**
- (1) co-attendance from Partiful/Luma emails
- (3) nearby alerts for friends already sharing Maps location
- (2) "X would like Y" as a bonus once 1 is parsing

**N=2, works as soon as one friend joins:**
- (8)+(9) porchlight + agent-answered drop-in, the Grocery Outlet fix
- (10)+(11) co-attendance between on-system friends, carpool nudge
- (17) who's around tonight
- (12) standing-slot finder

Everything else is an addon that plugs into the same core.

## 3. Core concepts

```
Node ──hosts──▶ Person ──has──▶ Source* ──writes──▶ Observation (append-only)
                   │                                      │
                   ├──has──▶ Relationship ──▶ Person       ▼
                   │         (tier, wantMore,        Trigger* ──▶ Opportunity
                   │          grants, note)                        │
                   ├──has──▶ Policy                                ▼
                   │                                           Judge (LLM)
                   └──has──▶ Agent ◀──Query (local or federated)   │
                                │                                  ▼
                                └──▶ Nudge ──▶ Channel* ──▶ human (yes/veto/snooze)
```

### Person
`{ id, nodeUrl, displayName, pubkey, tz, home: Place?, story, dropinNote }`. Identity is a keypair.
A person lives on exactly one node. Friends may be on other nodes.
- `story`: plain text the person writes about what they are generally up for and when ("free weeknights
  after 8, love a walk, hate phone calls, Saturday mornings are family"). Not private: friends can read it,
  and it goes into the Judge prompt for every participant, the answering agents (availability, freeform,
  dropin's `revealed`) and the person's own chat agent. Max 2000 chars.
- `dropinNote`: the standing note shown with the porchlight ("come round the back"). A status observation
  with its own `note` replaces it for that status only; a status without a note shows the default again.

### Observation (the log, from day 1)
Append-only, normalized. Every source writes these; every trigger reads them.

```
{ personId, sourceId, kind, at, until?, data, raw? }
kind ∈
  location   { lat, lng, acc, speed?, placeId? }
  event      { title, start, end, location?, attendees?: [{name, email?}], url?, provider }
  status     { porchlight: 'open'|'closed'|'ask', note?, until }
  intent     { text, window?, people?: [personId], kind?: 'host'|'attend'|'call'|'walk'|... }
  motion     { state: 'still'|'walking'|'driving'|'transit' }
  mention    { text, inferredPlace?, inferredWindow?, provider }   // tweets, chat
```

### Place
Named locations: declared ("home", "Grocery Outlet") or learned (dwell clustering
later). `{ id, ownerId?, name, lat, lng, radius, shared: bool }`.

### Relationship (directed)
```
{ from, to, tier: 'acquaintance'|'friend'|'trusted',
  wantMore: bool,            // the whole filter for v1
  travel: 0..3,              // how far out of my way for them; never shown to them
  note: text,                // freeform CRM-lite the agent reads
  grants: {                  // (a) what `to` may do with MY data; overrides tier default
    askAvailability, askDropin, autoYesDropin,
    askWhereabouts, seeLocationLive, seePlans
  },
  via: {                     // (b) what I extend to people `to` vouches for
    tier: 'acquaintance'|'friend', openToIntro: bool
  },
  vouch: bool }              // I'm willing to be a path from `to` to my friends
```
Tier sets defaults; grants override per person. Two separate ideas live on the edge:
(a) what the other person may do with my data, (b) what I'll extend to people they
vouch for. "Bob's friends are cooler" = a generous `via` on my Bob edge. Bob has to
set `vouch` on his side for the path to exist at all.

### Policy
Per person: tier defaults, quiet hours, max nudges/day, drop-in default windows,
rate limits for inbound queries (per asker, per hour), what the agent may reveal
unprompted vs only when asked.

### Source (plugin)
```
{ id, name, setup: SetupStep[],   // onboarding: 'url'|'token'|'oauth'|'install-app'|'paste'
  ingest?(person, payload) → Observation[],   // webhook/POST
  poll?(person, since) → Observation[],       // cron
  intervalMin? }
```
Native apps are just sources with `setup: install-app` that POST to
`/ingest/:sourceId` with a per-person source token. Payload shape is the plugin's
business; it normalizes to Observations.

### Trigger (plugin)
Deterministic. Runs on observation insert (`on: ['location']`) or cron.
Emits `Opportunity { kind, participants, evidence: Observation[], expiresAt, score? }`.
No LLM calls in triggers. v1 triggers: `nearby`, `coAttendance`, `porchlightProximity`,
`eventInterest` (emits candidates; the Judge does the taste reasoning).

**Drive-by isn't drop-in, but cars exist.** A fix is "in a vehicle" when its speed is >= 5 m/s or the
phone's motion state in force (within 10 min) is driving/transit (`core/motion.js`). `nearby` never fires
on such a fix, for either side. `porchlightProximity`, for A near F's home:
- A in a vehicle → nothing, unless A's private `travel` toward F is >= 2 (someone who would happily drive to
  F is plausibly doing exactly that) → fire now, evidence `arrivedBy: 'car'`, summary says "in a car".
- A out of the vehicle but in one within the last 10 min → fire once A has dwelt: 2 fixes over 3 minutes,
  inside the radius, none in a vehicle → evidence `arrivedBy: 'car'`, summary says "just parked".
- A on foot with no recent vehicle → fire on the first fix, as before.
The travel number never leaves A's node; only the fact of the car does. Evidence never carries coordinates.

### Judge
One LLM call per Opportunity, with: the opportunity, each participant's policy
and relationship (filtered: never pass A's `travel` into B's context), recent
nudges (dedupe), time/quiet hours. Returns `suppress | nudge(to, text, actions) |
ask(agentOf(B), query) then nudge`. This is where "worth a buzz?" lives.

### Query (the inter-agent primitive, local and federated)
```
POST /q   { from, to, kind, text, window?, context?, nonce, sig }
kind ∈ availability | dropin | plans | whereabouts | freeform
→ { answer: 'yes'|'likely'|'unlikely'|'no'|'unsupported', text?, confidence,
    reason?, revealed: {...}, suggest?: PluginRef }
```
`kind` is a **permission class**, not a parser hint: grants, rate limits, and the
audit log attach to it, and fan-outs (whosAround) aggregate the structured `answer`
without an LLM. `text` is the freeform ask the answering LLM actually reads.
`freeform` is allowed but gated at the most restrictive class the asker holds.
Some kinds answer deterministically with no LLM (porchlight status, trusted-tier plans).
Answered by `to`'s Agent with `to`'s observations + policy + relationship(to→from).
Rate-limited per (from,to,kind). Whether a human is pinged (veto flow) is `to`'s policy.
Locally this is a function call; across nodes it's the same shape over HTTPS.

### Agent
LLM with tools, two faces:
- **owner-facing** (chat): read own observations, record intent, set porchlight,
  edit relationships, run `whosAround(window)` (fan-out of `availability` queries),
  draft texts for off-system friends.
- **friend-facing** (answerer): answer a Query under policy. Must only reveal what
  `revealed` policy allows. Prompt includes the relationship note and grants.

### Nudge / Channel
`Nudge { to, text, actions: [{label, cb}], decisionId, expiresAt }`.
Channels are plugins: native push (FCM) and Telegram from day one, email fallback.
Every nudge records yes/veto/ignore → feeds trust graduation and dedupe.

### Decision + Review (day one, non-negotiable)
Every Judge output is a `Decision { personId, opportunityId, verdict:
'suppress'|'nudge'|'ask', reasoning, nudgeId?, rating?: 'good'|'bad', ratingNote? }`.
**Suppressions are logged too.** Review surfaces:
- every nudge carries a "shouldn't have bugged me" action
- the daily digest lists what it stayed quiet about ("I skipped 3 things: ...") with
  "should have told me" actions — this is also what builds trust, you see it working
- `/review` in Telegram and a Decisions tab in the app for the full log
Ratings feed back as per-person few-shot examples in the Judge prompt, per-friend
and per-kind thresholds, and trust graduation (autoYesDropin offers).

## 4. Federation

Spirit: run your own node, or sign up on Malcolm's. Same protocol either way.

- Each person has an Ed25519 keypair (node holds it; you can export).
- **Invite** = one-time code embedding `{ inviterId, inviterNode, inviterPubkey,
  wantMore, expires }`. Accepting it: joiner's node POSTs `/friend/accept` with
  joiner's pubkey, signed. Both store the edge. The code is dead after one use
  (Michael's point: a leaked card does nothing).
- Requests between nodes are signed (HTTP signature over body+nonce+timestamp).
  No DH needed for v1 since we only sign, not encrypt; TLS handles transport.
  Encryption of payloads is a later add if someone wants a node they don't trust.
- Endpoints: `/.well-known/opportune` (node info + **capabilities**: sources,
  triggers, query kinds it runs, each with a repo/ref pointer), `/friend/accept`,
  `/q` (query), `/nudge` (deliver a nudge to a person on this node, e.g. "A asked, I
  said likely, veto?"), `/observe` (optional push of granted observations, e.g.
  trusted-tier live location, instead of making them poll), `/suggest` (see below).
- **Self-transcendence.** A node that gets a `/q` it can't answer returns
  `unsupported` + `suggest: { plugin, repo, setup }`. The receiving node promotes it to
  the person as a nudge: "Jess's agent wanted your evening plans. Paste an ICS URL and
  it can answer." A node may also `/suggest` unprompted ("we support tweets, want it?").
  On a shared node the action is a setup step; on a self-hosted node it's a plugin
  install from the pointed-at repo. Plugins are self-describing (manifest = name,
  setup steps, kinds provided) so a node can render the offer without the code.
  The capability list also lets the Judge avoid asking a friend's node the impossible.
- **Push across nodes.** The native app is bound to one FCM project. Self-hosted nodes
  either run their own build, use a push relay operated by the app publisher
  (`POST /relay { token, payload }`), or UnifiedPush. Tonight: Malcolm's Firebase.
- Rate limits enforced by the answering node. Asymmetric capabilities between nodes
  are fine and expected; the protocol only promises "ask and get a policy-shaped answer".

Malcolm's secretary (aichatbutgoodtho) becomes either a Source (its Android app
POSTs location to opportune too) or a whole node answering `/q` for Malcolm with
richer context. Start with Source.

## 5. Onboarding (Telegram or app, same flow)

Target: under 3 minutes, no decisions you can't change later. The native app runs the
same steps as the bot; whichever you start in, the other is a setup step.

1. Open invite link → bot `/start <code>`. Edge to inviter created with inviter's
   `wantMore`. "Jess wants to see more of you. I can help with that."
2. "What should I call you? Where's home?" (share location once, or type address)
3. "Pick what to hook up. Each is one step." Inline buttons:
   - Calendar: paste ICS URL(s) (no OAuth)
   - Location: install Overland (iOS) / OwnTracks / our Android app, here's your URL+token
   - Events: Gmail app password (no GCP OAuth) or forward Partiful/Luma mails to an address
   - Tweets: your handle
   - Maps sharing: desktop grabber (Malcolm-tier for now)
4. "Who do you want to see more of?" → names → one invite link each.
5. "Drop-ins: open evenings? weekends? ask me each time?" → porchlight default.
6. "I'll stay quiet unless something's worth it. Say 'who's around' anytime."

Michael's trust-graduation: the first time the agent would auto-answer a dropin
it asks instead; after N yeses for that friend it offers `autoYesDropin`.

## 6. Pipeline, concretely

```
POST /ingest/:source  →  source.ingest  →  insert Observation(s)
                                               │
                              triggers subscribed to kind run synchronously
                                               │
                                        Opportunity rows
                                               │
                       judge worker (queue): dedupe, policy, LLM  →  Nudge rows
                                               │
                                     channel delivers; callbacks update Nudge
cron: */10 poll sources with poll()   ·   daily 09:00 digest   ·   weekly interview
      ·   routine-coincidence (daily, needs history)   ·   standing-slot finder (weekly)
```

Five triggers total (location change, calendar/RSVP change, inbound query, inbound
chat, cron). The LLM is only ever invoked downstream of one of these.

## 7. Stack

- Node 22, ES modules, no semicolons (house style). SQLite via better-sqlite3 for v1;
  schema is plain enough to move to Postgres.
- grammY for Telegram. @anthropic-ai/sdk for Judge/Agent.
- Plugins = directories under `sources/`, `triggers/`, `channels/`, `queries/`,
  each exporting a manifest. Discovered at boot. Addons built by subagents land here.
- `apps/android` from day one, lifted from the secretary (LocationService.kt,
  ApiClient.kt, FCMService.kt, NotificationActionReceiver.kt). It is three things:
  location source → `/ingest/location`, push channel with yes/veto notification
  actions, and a minimal UI (nudges, porchlight toggle, decisions review). iOS via
  TestFlight later; Overland covers iOS location meanwhile. Desktop grabber for Maps cookies.
- Gmail: app password + IMAP for v1. Own GCP project + OAuth as an addon later.
  No Pipedream: it adds a hosted dependency that doesn't federate.

## 8. Build order tonight

Core (serial, one agent):
1. schema + Person/Relationship/Policy/Observation/Place
2. plugin loader + Source interface + `/ingest/:source`
3. sources: `icsCalendar`, `locationPost` (OwnTracks/Overland/android compatible)
4. triggers: `nearby`, `coAttendance`
5. Judge + Decision log (incl. suppressions) + Nudge + Telegram channel with
   yes/veto/rate callbacks + daily digest with "should have told me"
6. Query `/q` local + `availability` kind + `whosAround` fan-out
7. Telegram onboarding flow + invites
8. federation shape: keypairs, signed `/q`, `/friend/accept`, `/.well-known` with
   capabilities, `unsupported`+`suggest` path (can be local-only but with the right
   signatures and shapes from day 1)
9. Android app: location POST + FCM channel + nudge/veto/rate (parallel with 5–8)

Addons (parallel, subagents, each a self-contained plugin dir + setup steps):
- `sources/gmailRsvp` (IMAP + Partiful/Luma/Eventbrite parsers → event observations w/ attendees)
- `sources/mapsSharing` (desktop cookie grabber + locationsharinglib poller)
- `sources/tweets` (community archive)
- `sources/beeper` / matrix (Malcolm-only)
- `triggers/porchlightProximity` + `queries/dropin` with veto flow
- `triggers/eventInterest`
- `triggers/standingSlot` (cron)
- `apps/android` UI polish (porchlight toggle, decisions tab) once core channel works
- `web/map` trusted-tier live map + plans view
