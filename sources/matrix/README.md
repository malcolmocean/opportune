# sources/matrix — your own chats, via Matrix / Beeper

Owner-only source for two patterns in DESIGN.md §1:

- **20, message elevation.** A friend texts "I'm near your place, can I drop in?" on WhatsApp.
  Your phone buries it under forty other notifications. This source notices it is a right-now
  coordination ask and raises it as an `opportunity` so the Judge can nudge you while it still
  matters (45 minute TTL).
- **21, plan inference from chat.** "I'll be in Oakland Saturday" in a DM becomes a `mention`
  observation. When it is *your* plan it carries `inferredPlace` / `inferredWindow` in the same
  shape the tweets source produces, so the same downstream matching (e.g. `triggers/inTown`:
  tell the friend who lives there) can use it. When it is the *contact's* plan it goes under
  `contactPlan` instead, so nothing mistakes their trip for yours.

It works with any Matrix homeserver, but the point is **Beeper**: its bridges put WhatsApp,
iMessage, Signal, Telegram, Instagram, LinkedIn… into one Matrix account, so one access token
covers all your chats. Nothing is installed: it is plain `fetch` against the client-server
REST API (`/_matrix/client/v3/sync` with a filter and a stored `next_batch`).

## Setup steps (what onboarding asks for)

| key | type | value |
|---|---|---|
| `homeserver` | url | `https://matrix.beeper.com` for Beeper; your own server otherwise. A bare host is fine. |
| `accessToken` | secret | A Matrix access token for your account (starts with `syt_`). See below. |
| `rooms` | text, optional | Comma-separated room ids (`!abc:beeper.local, !def:beeper.local`) to watch **instead of** the default. Default is every room with ≤3 joined members (a DM, or a Beeper DM which also contains the bridge bot). Listed rooms are watched whatever their size, so this is how you opt a group chat in. |

Polls every 5 minutes. The first poll only looks at the last hour; after that it is strictly
incremental.

## Getting an access token

You want the `access_token` string for your account. Three routes, pick whichever works:

**Beeper desktop (Element-based builds).** Settings → Help & About → Advanced → *Access Token*
(click to reveal, copy). Menus move between versions; if you cannot find it, use one of the
other two routes.

**Beeper's login API** (this is the flow `bbctl`, Beeper's bridge manager, uses; it asks for
an email code):

```sh
# 1. start a login, 2. ask for a code by email, 3. trade the code for a Beeper JWT
REQ=$(curl -s -XPOST https://api.beeper.com/user/login -H 'authorization: Bearer BEEPER-PRIVATE-API-PLEASE-DONT-USE' -d '{}' | jq -r .request)
curl -s -XPOST https://api.beeper.com/user/login/email -H 'authorization: Bearer BEEPER-PRIVATE-API-PLEASE-DONT-USE' -d "{\"request\":\"$REQ\",\"email\":\"you@example.com\"}"
JWT=$(curl -s -XPOST https://api.beeper.com/user/login/response -H 'authorization: Bearer BEEPER-PRIVATE-API-PLEASE-DONT-USE' -d "{\"request\":\"$REQ\",\"response\":\"123456\"}" | jq -r .token)
# 4. turn the JWT into a Matrix access token
curl -s -XPOST https://matrix.beeper.com/_matrix/client/v3/login -d "{\"type\":\"org.matrix.login.jwt\",\"token\":\"$JWT\",\"initial_device_display_name\":\"opportune\"}"
```

The last call returns `{ "access_token": "syt_…", "user_id": "@you:beeper.com", … }`. If the
endpoints have moved, `bbctl login` (github.com/beeper/bridge-manager) does the same dance and
leaves the token in `~/.config/bbctl/config.json`.

**Any other homeserver** with password login:

```sh
curl -s -XPOST https://matrix.example.org/_matrix/client/v3/login \
  -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"you"},"password":"…","initial_device_display_name":"opportune"}'
```

Logging in this way creates a new *device/session*. To revoke the token later, remove that
session in your client's security settings (or `POST /_matrix/client/v3/logout` with the token).
Prefer this over copying your main client's token, which would log that client out when revoked.

## What gets stored

Per message, one `mention` observation on **you** (never on the friend), deduped by Matrix
`event_id` (edits update the original in place):

```js
{ kind: 'mention', at, until?, dedupeKey: '$event_id',   // until = end of YOUR inferred window
  data: { text,            // clipped to 500 chars, never longer
          provider: 'matrix', sender, room, isFromMe,
          inferredPlace?, inferredWindow?,            // LLM on, and the plan is yours
          contactPlan?: { who, place, window },       // LLM on, and the plan is theirs
          urgent?, summary? } }                       // LLM on, never for your own messages
```

Plus, for urgent ones only, one opportunity `{ kind: 'messageElevation', participants: [you],
dedupeKey: 'elev:$event_id', expiresAt: +45min }` with the clipped message as evidence. No raw
event JSON is kept. In the `kv` table: your own user id, the sync token, and a per-room cache of
member count and display names (so unchanged rooms do not need a round trip each poll).

With `ANTHROPIC_API_KEY` set, each poll makes **one** LLM call for the whole batch of new
messages. Without it, messages are stored as plain mentions and nothing is elevated.

## Privacy stance

- **Owner-only.** This is your data about your chats. The observations it writes belong to
  you, and no query plugin (`availability`, `plans`, `whereabouts`, `dropin`) reads `mention`
  observations, so **message text never crosses to a friend's node**, however trusted the
  tier. Consumers on your own node: the Judge (which may nudge *you* about an elevated
  message) and any trigger that reads `mention`s. Today that is `triggers/inTown`, which uses
  *your own* stated whereabouts to tell a friend who lives there that you are coming; a
  contact's plans are stored under `contactPlan`, which it does not read. `core/judge.js`
  only judges, and only nudges, people on this node, so even that stays local.
- The other people in your chats did not opt in to anything. That is why text is clipped, raw
  events are dropped, and the sender is recorded by display name only. The Judge prompt sees
  the elevation summary, which includes the clipped message; if that is still too much for
  you, restrict `rooms` to specific conversations.
- The access token sits in `source_configs.config` in your node's sqlite file, like every other
  source secret (ICS URLs, app passwords). It can read everything in your account. Run this on a
  node you control, and revoke the session when you stop.
- Polling uses `set_presence=offline`, so it never shows you online in Beeper.

## Limitations

- Timeline gaps: if more than 50 messages land in one room between polls, `/sync` marks the
  timeline `limited` and the older ones are skipped (logged as a warning). Backfilling via
  `/messages` is a small addition if it bites.
- Member counts come from the room summary, which Synapse only sends when it changes; the
  first time a room is seen without one, `/joined_members` is called once and cached. A room
  that grows from a DM to a group after that is still treated by its cached count until the
  summary shows up again.
- Only `m.text` bodies. Images, voice notes, reactions and `m.notice` bridge chatter are
  ignored; edits are followed, redactions are not.
- **Encryption, the big one.** This source has no E2EE (that is the price of "no SDK"): it
  reads the server's view, so it only sees messages that are plaintext to the server, and it
  logs a warning with the count of `m.room.encrypted` events it had to skip. Beeper encrypts
  bridged rooms between its bridges and your devices, so against `matrix.beeper.com` directly
  you will mostly see that warning. The standard fix for E2EE-unaware clients is
  [pantalaimon](https://github.com/matrix-org/pantalaimon): a small proxy that logs in as you,
  holds the keys, and serves a decrypted `/sync`. Run it next to your node, point `homeserver`
  at it (`http://127.0.0.1:8009`), and use the access token pantalaimon hands back from its
  `/login`. Until then this source is fully functional against any unencrypted room (self-hosted
  bridges with encryption off, plain Matrix DMs that never enabled E2EE).
- Urgency and plan extraction depend on the LLM. Without a key you still get the searchable
  `mention` log, just no elevation.
