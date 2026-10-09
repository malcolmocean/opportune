# sources/mapsSharing — Google Maps location sharing

Pattern 3 from DESIGN.md, the N=1 win: friends who **already** share their Google Maps
location with you show up in opportune with live location, and they install nothing.
Every 5 minutes this source reads the same data Google Maps shows you, through your own
Google account, using [locationsharinglib](https://github.com/costastf/locationsharinglib).

## What it does

1. Writes your stored cookies to a `0600` temp file, runs `fetch.py` (Python), deletes the file.
2. For each contact Google returns:
   - finds an existing friend of yours whose `display_name` equals the contact's full name
     (case-insensitive; falls back to their Google nickname), or
   - creates a **shadow person**: `onboarding = { step: 'shadow', via: 'mapsSharing', ownerId }`
     and a one-way relationship you → them (`tier: 'friend', wantMore: false`).
   - remembers Google id → person id in `kv`, so renames on either side don't create duplicates.
3. Ingests a `location` observation **under the contact's person id** (source `mapsSharing`):
   `{ lat, lng, acc, placeId, placeName, address, battery, charging }`. `placeName` matches
   the contact's own places first, then yours (attributed, e.g. `"Malcolm's home"`, so the
   `nearby` trigger's "both at home" check isn't fooled).
4. Returns your own fix (Google exposes the authenticated account's location too) so core
   ingests it for you like any other source.

Dedupe: a contact is skipped when the fix timestamp equals their latest stored location's
`at`; every observation also carries `dedupeKey: loc@<timestamp>` so a repeat never fires
triggers twice.

Because `nearby` runs when a location is inserted and looks at `friendsOf(thatPerson)`,
a shadow moving next to you is noticed the next time **your** location arrives (your own
Maps fix every 5 minutes, or your phone app). Shadows have no edge back to you, so their
movement alone doesn't fire it. Nothing is nudged until you flip `wantMore` on your edge
to them (the Judge's gate requires one side to want more).

## Setup (two steps in onboarding)

| key | type | what |
|---|---|---|
| `email` | text | the Google account your friends share with |
| `cookies` | secret | Netscape `cookies.txt` for `google.com`, pasted as text |

### Getting the cookies

1. On a desktop browser, log into the Google account that receives the shares. Open
   https://www.google.com/maps and confirm you can see shared people.
2. Install a cookies.txt exporter. Chrome/Edge: **Get cookies.txt LOCALLY**. Firefox:
   **cookies.txt**. Export cookies for the current site (google.com) in Netscape format.
3. Open the file and paste its contents into the bot/app when asked. The source keeps only
   the `google.com` lines, strips `#HttpOnly_` prefixes, and requires `__Secure-1PSID` or
   `__Secure-3PSID` to be present.
4. If the paste is too long for your chat client (Telegram caps messages at 4096 chars),
   paste just the lines for `SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, `__Secure-1PSID`,
   `__Secure-3PSID`, `__Secure-1PAPISID`, `__Secure-3PAPISID`, `NID`.
5. Do **not** log out of that browser session afterwards; logging out invalidates the
   cookies server-side. A dedicated browser profile that you leave logged in works best.

The first poll runs right after setup and reports how many items it found; an auth problem
shows up as `invalid_cookies` in that reply and in `source_configs.last_error`.

## Python requirements

The poller shells out to `fetch.py`, which needs `locationsharinglib` (pulls `requests`,
`pytz`, `cachetools`, `coloredlogs`). Python 3.9+. Pick one:

```sh
# a) venv next to the plugin (found automatically)
sh sources/mapsSharing/setup.sh

# b) user-site install for whatever `python3` is on PATH
pip install --user locationsharinglib

# c) point at any interpreter that has the lib
MAPS_SHARING_PYTHON=/path/to/python
```

Resolution order: `MAPS_SHARING_PYTHON` → `sources/mapsSharing/.venv/bin/python` → `python3`.
`.venv/` is git-ignored. No new npm dependencies.

Exit codes of `fetch.py`: 0 ok, 2 cookies rejected or file unreadable (`invalid_cookies`),
3 lib missing (`missing_dependency`), 4 unparseable or network error (`invalid_data`,
`fetch_failed`). The error becomes the poll error, which core stores on the source config.

## Privacy framing

- The cookies are a full login to your Google account. They live in your node's SQLite
  (`source_configs.config`), are written to a temp file only for the ~2s a poll takes, and
  never leave the node. Treat the database file accordingly.
- Everything this source learns about your friends stays on **your** node, exactly as it
  already sits in your Google Maps app. It is not federated, not pushed to their nodes, and
  not shown to anyone else; it only feeds your own triggers and your own agent.
- Shadow people have no channel, no identity, no agent policy of their own and no edge
  back to you, so they cannot be nudged, queried about anything but what you already see,
  or messaged. They exist so the detectors have someone to compare you against. If a shadow
  later joins for real, the Telegram/app onboarding creates a separate person; merge is a
  TODO (today: rename either to match and the kv mapping keeps pointing at the shadow).
- Because shadows are in `people.all()`, the daily digest may try to send to them and log
  `no channel delivered`. Harmless, but noisy; a `remote`/`shadow` filter in core would be
  the fix.

## Known fragility

- **Google invalidates cookies.** Logging out, changing your password, a security checkup,
  or just time (weeks to months) kills the session. Symptom: `invalid_cookies` on every poll.
  Fix: re-export and paste again. Cookies from a browser you keep using tend to last longer
  because Google refreshes them; the exported copy does not get refreshed though.
- The endpoint is undocumented (`/maps/rpc/locationsharing/read`) and the parser indexes into
  a positional JSON blob. When Google reshuffles it, polls fail with `invalid_data` until
  `locationsharinglib` ships a fix (`pip install -U locationsharinglib` in the venv).
- Contacts whose location is currently unavailable (phone off, sharing paused) are dropped
  by the lib, so their last known fix just stops updating.
- Name matching is by display name. If a friend is "Jess" here and "Jessica Chen" in Google
  with nickname "Jess", the nickname fallback catches it; "J. Chen" won't, and you'll get a
  shadow. Rename the shadow or the friend to match, or edit the kv key
  `mapsSharing:<ownerId>:<googleId>` to point at the right person id.
- Timestamps are Google's device-reported fix time (ms), so stale phones produce stale
  `at` values; the `nearby` trigger's 40-minute freshness window handles that.

## Testing

```
node --test tests/mapsSharing.test.js
```

Tests run against an in-memory db with the Python bridge stubbed (`manifest.fetch`), plus a
real `fetchShared` round trip through a stand-in script to cover the temp-file handling and
error mapping. Nothing in the tests touches Google.

To smoke-test the Python side alone:

```
sources/mapsSharing/.venv/bin/python sources/mapsSharing/fetch.py --cookies ~/Downloads/google.com_cookies.txt --email you@gmail.com | jq .
```
