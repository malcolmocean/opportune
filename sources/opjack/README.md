# sources/opjack — your own chats, via opjack

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

It does the same job as `sources/matrix`, for people whose chats come through
[opjack](https://client.opjack.com): a hosted, bridge-first chat client that holds one Matrix
session per user, bridges WhatsApp, Signal, Telegram and friends into it, and exposes a small
REST API. One read-only token covers every network. Compared to talking to Matrix directly:
no `/sync` filter dance, no sync token, and no E2EE problem (opjack reads the rooms as you),
so it polls more often (every 3 minutes). Plain `fetch`, no SDK.

## Setup steps (what onboarding asks for)

| key | type | value |
|---|---|---|
| `url` | url, optional | opjack server. Blank → `OPJACK_URL` from the node's env → `https://client.opjack.com`. A bare host is fine. |
| `token` | secret, optional | A **read-only** opjack token (see below). Blank → `OPJACK_TOKEN` from the node's env. That env token is the node owner's own; leave it blank only if you *are* the node owner. |
| `networks` | text, optional | Comma-separated networks to watch (`whatsapp,signal,telegram`). Default: all. Compared case-insensitively against each chat's `network`. |

Polls every 3 minutes. The first poll only looks at the last hour (or, if core already has a
`last_poll_at` for this source, from there); after that it is strictly incremental from the
newest message timestamp it has seen.

## Minting a read-only token

opjack tokens carry scopes; this source only needs `read`. Never paste your meta/admin token.

**Account page.** Sign in at <https://client.opjack.com/account>, under *Tokens* add one named
`opportune` with only the **read** scope, copy the secret (it is shown once).

**API**, with your meta token from signup:

```sh
curl -X POST https://client.opjack.com/v1/tokens \
  -H "Authorization: Bearer <meta token>" -H "Content-Type: application/json" \
  -d '{"name":"opportune","scopes":["read"]}'
```

`GET /v1/info` with the new token shows its scopes. Revoke it from the same account page (or
`DELETE /v1/tokens/{id}`) when you stop; a revoked token makes this source fail with
`bad_token`, visible in `source_configs.last_error` and the sources screen.

## What it reads

`GET /v1/activity?since=<cursor>&limit=200`, following `hasMore` with `since=newestTimestamp`
(at most 10 pages per poll). The response groups messages by chat; each group's `chat` carries
`type`, `network`, `isEncrypted`, `title`, `participants.{items,total}`; each message carries
`id`, `senderID`, `senderName`, `isSender`, `type`, `text`, `timestamp`, `sortKey`, `isDeleted`.
Kept:

- chats that are DM-ish: `type` `single` (opjack's name for a DM; `dm` also accepted), or any
  chat with ≤3 participants (you, them, and the bridge puppet opjack counts in). Never your
  `self` chat or a `bridge-mgmt` room. Then the `networks` filter.
- messages with `type: 'text'` that are not deleted. Images, voice notes, stickers, files,
  locations and bridge `notice`s are skipped. Your own messages are kept (with `isFromMe`) so
  your own plans can be inferred, but are never judged urgent.
- encrypted chats are skipped and counted; the count is logged as a warning.

## What gets stored

Per message, one `mention` observation on **you** (never on the friend), deduped by opjack
message `id`:

```js
{ kind: 'mention', at, until?, dedupeKey: '<message id>',   // until = end of YOUR inferred window
  data: { text,            // clipped to 500 chars, never longer
          provider: 'opjack', network, sender, chat, isFromMe,
          inferredPlace?, inferredWindow?,            // LLM on, and the plan is yours
          contactPlan?: { who, place, window },       // LLM on, and the plan is theirs
          urgent?, summary? } }                       // LLM on, never for your own messages
```

Plus, for urgent ones only, one opportunity `{ kind: 'messageElevation', participants: [you],
primary: you, dedupeKey: 'elev:<message id>', expiresAt: +45min }` whose summary is
`"<sender> just messaged (<network>): "<first 80 chars>" — this looks like a right-now
coordination ask. <one-line summary>"` and whose evidence is `[{ chat, sender, text, at,
network }]`. No raw API JSON is kept. In the `kv` table: `opjack:<personId>:since`, the newest
message timestamp seen (the next poll's `since`).

With `ANTHROPIC_API_KEY` set, each poll makes **one** LLM call for the whole batch of new
messages (all pages). Without it, messages are stored as plain mentions and nothing is elevated.

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
  payloads are dropped, group chats are excluded by default, and the sender is recorded by
  display name only. The Judge prompt sees the elevation summary, which includes the clipped
  message; if that is still too much for you, restrict `networks`.
- The token sits in `source_configs.config` in your node's sqlite file, like every other
  source secret. Mint it with the `read` scope only, so even a leaked token cannot send as you,
  and revoke it when you stop. When `token` is blank the node's `OPJACK_TOKEN` is used: that
  is a convenience for the node owner on their own node, not something to leave blank on a
  node you share.
- Nothing is sent to opjack except the polls themselves: no read receipts, no presence, no
  writes (a `read` token could not anyway).

## Limitations

- `since` is strictly greater-than on the message timestamp, and paging uses the last page's
  `newestTimestamp`: two messages in the same millisecond straddling a page boundary could lose
  the second. Within a page, messages opjack recovered late (after a sliding-sync truncation or
  a restart) still have their original timestamps, so if they are recovered *after* the cursor
  has passed them they are not seen. `dedupeKey` makes re-ingesting anything harmless, so a
  manual reset of `opjack:<personId>:since` in `kv` backfills safely.
- Edits and deletions after a message was polled are not picked up (opjack updates the row in
  place without moving its timestamp). The mention keeps the text as first seen.
- At most 2000 messages (10 pages) per poll; the rest arrive on the next poll three minutes
  later.
- Encrypted chats (`isEncrypted`) are unreadable: opjack does no E2EE in v1, and the server only
  sees "(encrypted message)". They are counted and warned about, never stored. Bridged chats
  are normally unencrypted on opjack, so in practice this bites only for native Matrix rooms.
- DM detection trusts opjack's `type` plus participant count. A 3-person human group with no
  bridge puppet is indistinguishable from a bridged DM by count alone, but opjack types it
  `group` and it would only be included if `participants.total ≤ 3`, which for bridged chats
  means you + one person + the puppet.
- Urgency and plan extraction depend on the LLM. Without a key you still get the searchable
  `mention` log, just no elevation.
- Only `GET /v1/activity` is used. The WebSocket (`/v1/ws`) and saved subscriptions would give
  sub-second elevation instead of a 3 minute worst case; that is a later step once core has a
  long-lived source hook (today sources are poll or push-ingest only).
