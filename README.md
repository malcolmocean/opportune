# opportune

> What am I already doing, that would be made better by adding other people at low
> marginal cost to them, or by joining their plans at low marginal cost to me?

A small, federatable system that notices when hanging out with your people would be
cheap (same event, a block from their place and they're home, both free Thursday) and
nudges you. Only people who opt in to each other. Nothing public. See `DESIGN.md`.

## Run a node (5 minutes)

```
pnpm install
cp .env.example .env
```
Fill in `.env`:
- `TELEGRAM_BOT_TOKEN`: talk to @BotFather in Telegram, `/newbot`, paste the token.
- `ANTHROPIC_API_KEY`: without it the Judge passes every opportunity through (fine for dev).
- `NODE_URL`: the public URL of this node. Invite links and phone location posting need it.
  Quick options: `pnpm tunnel` (cloudflared, prints a trycloudflare.com URL),
  `ngrok http 3400`, or `tailscale funnel 3400`. Set NODE_URL to whatever that prints.
- `FIREBASE_SERVICE_ACCOUNT_JSON` (optional): for Android push. See `apps/android/README.md`.

```
pnpm dev          # server + telegram bot + cron
pnpm seed         # two fake people and a party, for poking at it
pnpm test
```

Then open your bot in Telegram, `/start`. Onboarding is six messages. `/invite Eileen`
makes a one-time link that tells Eileen you want to see more of her.

## What's in the box

| dir | what |
|---|---|
| `core/` | observations log, triggers → opportunities → Judge → nudges, inter-agent query, federation, owner agent |
| `sources/` | where data comes from: ICS calendar, phone location, Gmail RSVP emails, Google Maps sharing, tweets, Matrix |
| `triggers/` | deterministic detectors: nearby, co-attendance, porchlight proximity, event interest, standing slot, in-town, contact joined |
| `queries/` | what a friend's agent may ask yours: availability, dropin, plans, whereabouts |
| `channels/` | telegram, fcm (Android push) |
| `web/` | magic-link management page: friends, grants, sources, decision review, trusted-tier map |
| `apps/android` | location source + push + porchlight toggle |
| `docs/PLUGINS.md` | how to write any of the above |

## Federation

Every node serves `/.well-known/opportune` (capabilities), `/friend/accept`, `/q`,
`/nudge`, `/suggest`, `/observe`. Requests are signed with the sender's ed25519 key.
Run your own node and accept a friend's invite link from it; your agents talk over HTTPS
with the same shapes they use locally. A node that can't answer a question says so and
suggests the plugin, and your node offers it to you.
