# The app is a web app. The Android and iOS apps are shells.

Everything a person sees lives at `GET /app` on their node (served from `web/app.html`),
so it works in a phone browser, on a laptop, and inside the Android shell. The shell adds
only what the browser can't do: background location, push notifications with action
buttons, contacts, and keeping the token.

## URLs the web app uses

| route | auth | purpose |
|---|---|---|
| `GET /app` | none | the web app shell; reads `?token=` or localStorage, else shows onboarding. `?claim=CODE` claims a sign-in code first (email links land here). `#home #nudges #people #map #settings`, and the sub-screens `#review #sources #windows` |
| `GET /web/manage?token=` | none | legacy: 302 to `/app?token=` (the old management page is folded into the app) |
| `POST /app/register {inviteCode?, displayName?, device?}` | none | new person; returns `{ personId, ingestUrl, manageUrl, telegramLink, inviter }` (`manageUrl` is now an `/app?token=` link) |
| `POST /app/claim {code}` | none | existing person typed the 6-char code from `/sources` in Telegram, or arrived via `/app?claim=`; same return shape |
| `POST /app/email/request {email}` | none | onboarding "Sign in with email": emails a one-time `/app?claim=` link (server routes in server.js / channels/email) |
| `GET /api/app/state?token=` | token | me + my porchlight (with `remainingMin`, `strength`) + friends' porchlights + recent nudges |
| `POST /api/app/session {device?, tz?}` | token | ingest URL, `manageUrl`, Telegram/push state, `declinedSources`, `me.email` |
| `PATCH /api/app/me {declinedSources: [sourceId]}` | token | sources the person said "not for me" to (hidden, out of the progress denominator) |
| `POST /api/app/invites {name, wantMore?}` | token | one-time invite link for someone new → `{ name, wantMore, code, url }` (what Telegram's `/invite` does) |
| `POST /api/app/email {email}` | token | Settings → You → Email: sends a verification link, `{ ok: true }` |
| `POST /ingest/opportuneApp/<token>` | token in URL | `[locations]`, `{ fcmToken, device }`, `{ nudgeResponse: {nudgeId, key} }`, `{ status: { porchlight, hours?, until?, note? } }`, `{ home: {lat, lng} }`, `{ contacts: [...] }` |
| `GET /api/manage/*` | token | friends/grants/sources/review/policy/map (see web/routes.js); the same token works. `POST /api/manage/sources` keeps a stored secret when the form leaves it blank |

The **token** is the tail of `ingestUrl` (`/ingest/opportuneApp/<token>`). It is the one
credential; the web app keeps it in localStorage and the shell keeps it in SharedPreferences.
Each side forgets it on its own sign-out: the web app clears localStorage and calls
`signOut()`; the shell also forgets it by itself when the node answers a location post with
401 (token revoked) or 404 (source removed), so a dead token never keeps the location service
alive. Nothing runs or posts in the shell without an ingest URL.

## Bridge: `window.opportuneNative` (present only inside the shell)

Injected by the Android WebView via `addJavascriptInterface`, and by the iOS shell (`apps/ios`) as a document-start
script whose getters read a state snapshot the shell keeps current. All methods synchronous unless noted.
On iOS `opportuneNative.platform === 'ios'` and the UA ends in ` opportune-ios/<version>`; iOS has no push yet, so
nudges arrive as local notifications when the app polls (see apps/ios/README.md).

```js
opportuneNative.getNodeUrl()            → string            // e.g. https://opportune.club
opportuneNative.getIngestUrl()          → string | ''       // '' until onboarding sets it
opportuneNative.setIngestUrl(url)       → void              // web calls this right after register/claim; shell starts services
opportuneNative.signOut()               → void              // web calls this on sign-out; shell forgets the URL, stops location + push, drops queued points
opportuneNative.getPermissions()        → JSON string { notifications, location, backgroundLocation, activity, contacts } (booleans)
opportuneNative.requestLocation()       → void              // runs the permission chain; result arrives via onPermissions
opportuneNative.requestNotifications()  → void
opportuneNative.requestContacts()       → void              // when granted, shell syncs contacts itself and keeps doing so daily
opportuneNative.getCurrentLocation()    → void              // one fix; arrives via onLocation
opportuneNative.openExternal(url)       → void              // Telegram deep links, browser
opportuneNative.getDeviceInfo()         → JSON string { model, androidVersion, appVersion }
```

Shell → web callbacks (the shell calls these on `window` when present):

```js
window.onNativePermissions({ notifications, location, backgroundLocation, activity, contacts })
window.onNativeLocation({ lat, lng, acc, at })
window.onNativeNudge({ nudgeId, text, actions })   // a push arrived while the web app is open
window.onNativeResume()                           // app came to foreground: refresh state
```

The shell opens `GET /app?token=<token>#nudges` when a notification body is tapped; action
buttons on the notification POST `nudgeResponse` natively without opening the app.

## Web app behaviour without the bridge

In a plain browser there is no background location. The web app still does everything else.
The Sources screen (Settings → the progress card, also on Home until every source is connected
or declined) offers the Android app and, for iPhones, Overland / OwnTracks pointed at a
locationPost URL it makes for you. Inside the shell the locationPost source shows as "covered by
this app" and the opportuneApp source never shows its ingest URL.
