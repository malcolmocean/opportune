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
- `RESEND_API_KEY` + `EMAIL_FROM` (optional): email sign-in, so nobody has to go through Telegram. See below.

```
pnpm dev          # server + telegram bot + cron
pnpm seed         # two fake people and a party, for poking at it
pnpm test
```

Then open `http://localhost:3400/app` (or your bot in Telegram, `/start`; onboarding is six
messages). People → "+ Invite" (or `/invite Eileen`) makes a one-time link that tells Eileen
you want to see more of her.

## Email sign-in (Resend)

People can sign in to `/app` with a one-time link instead of Telegram. Mail goes out through
[Resend](https://resend.com) over its HTTP API (no SDK):

1. In Resend, add your sending domain and put the DNS records it shows (SPF, DKIM) on that domain.
   Wait for it to say verified. Without a verified domain you can only send to your own address.
2. Make an API key (Sending access is enough) and set it as `RESEND_API_KEY` in `.env`.
3. Set `EMAIL_FROM` to an address on that domain, e.g. `opportune <hello@opportune.club>`.

Leave `RESEND_API_KEY` empty and the channel stays off: the sign-in routes answer 503 and
nothing else changes. With it set, `POST /app/email/request { email }` mails a 15-minute link to
any address already bound to a person (`POST /api/app/email { email }` from inside the app adds
and verifies one), and people with no push and no Telegram get their nudges as plain-text mail.

## Deploy to a VPS

```
doctl compute droplet create opportune --region sfo2 --size s-1vcpu-2gb --image ubuntu-24-04-x64 \
  --ssh-keys <your-key-id> --user-data-file deploy/cloud-init.sh --wait
# set NODE_URL=https://<ip>.sslip.io in .env (or your own domain pointed at the box), then:
deploy/deploy.sh <ip>              # rsync, pnpm install, systemd unit, Caddy with automatic HTTPS
ssh root@<ip> journalctl -u opportune -f
```
Caddy terminates TLS on `<ip>.sslip.io` so no domain is needed. Pass a hostname as the
second argument to deploy.sh to use your own domain. Only one process may poll the Telegram
bot token at a time, so stop `pnpm dev` locally before deploying.

## What's in the box

| dir | what |
|---|---|
| `core/` | observations log, triggers → opportunities → Judge → nudges, inter-agent query, federation, owner agent |
| `sources/` | where data comes from: ICS calendar, phone location, Gmail RSVP emails, Google Maps sharing, tweets, Matrix |
| `triggers/` | deterministic detectors: nearby, co-attendance, porchlight proximity, event interest, standing slot, in-town, contact joined |
| `queries/` | what a friend's agent may ask yours: availability, dropin, plans, whereabouts |
| `channels/` | telegram, fcm (Android push), email (magic-link sign-in via Resend) |
| `web/` | the app at `/app`: porchlight, nudges, people (tiers, grants, invites), sources, decision review, trusted-tier map, settings. `/manage` in Telegram gives a sign-in link |
| `apps/android` | location source + push + porchlight toggle |
| `docs/PLUGINS.md` | how to write any of the above |

## Federation

Every node serves `/.well-known/opportune` (capabilities), `/friend/accept`, `/q`,
`/nudge`, `/suggest`, `/observe`. Requests are signed with the sender's ed25519 key.
Run your own node and accept a friend's invite link from it; your agents talk over HTTPS
with the same shapes they use locally. A node that can't answer a question says so and
suggests the plugin, and your node offers it to you.
