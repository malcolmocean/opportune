# The app is a web app. The Android app is a shell.

Everything a person sees lives at `GET /app` on their node (served from `web/app.html`),
so it works in a phone browser, on a laptop, and inside the Android shell. The shell adds
only what the browser can't do: background location, push notifications with action
buttons, contacts, and keeping the token.

## URLs the web app uses

| route | auth | purpose |
|---|---|---|
| `GET /app` | none | the web app shell; reads `?token=` or localStorage, else shows onboarding |
| `POST /app/register {inviteCode?, displayName?, device?}` | none | new person; returns `{ personId, ingestUrl, manageUrl, telegramLink, inviter }` |
| `POST /app/claim {code}` | none | existing Telegram person typed the 6-char code from `/sources`; same return shape |
| `GET /api/app/state?token=` | token | me + my porchlight (with `remainingMin`, `strength`) + friends' porchlights + recent nudges |
| `POST /ingest/opportuneApp/<token>` | token in URL | `[locations]`, `{ fcmToken, device }`, `{ nudgeResponse: {nudgeId, key} }`, `{ status: { porchlight, hours?, until?, note? } }`, `{ home: {lat, lng} }`, `{ contacts: [...] }` |
| `GET /api/manage/*` | token | friends/grants/sources/review/map (see web/routes.js); the same token works |

The **token** is the tail of `ingestUrl` (`/ingest/opportuneApp/<token>`). It is the one
credential; the web app keeps it in localStorage and the shell keeps it in SharedPreferences.

## Bridge: `window.opportuneNative` (present only inside the shell)

Injected by the Android WebView via `addJavascriptInterface`. All methods synchronous unless noted.

```js
opportuneNative.getNodeUrl()            → string            // e.g. https://opportune.club
opportuneNative.getIngestUrl()          → string | ''       // '' until onboarding sets it
opportuneNative.setIngestUrl(url)       → void              // web calls this right after register/claim; shell starts services
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

In a plain browser there is no background location. The web app still does everything else,
and the Settings tab says: install the Android app, or use Overland (iOS) / OwnTracks pointed
at the locationPost URL from `/sources`.
