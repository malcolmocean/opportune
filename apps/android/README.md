# opportune Android app

A thin shell around the web app. Everything a person sees is `GET /app` on their node (served from
`web/app.html`), loaded in a full-screen WebView. The shell adds only what a browser can't do:

1. **Background location.** `LocationService` (foreground service) posts `[{lat, lng, acc, speed, at, battery, motion}]`
   batches to the ingest URL on 100 m / 5 min displacement, plus a 15-minute heartbeat.
   `motion` (still / walking / driving) comes from Activity Recognition when that permission is granted.
2. **Push.** `FCMService` turns FCM data messages from `channels/fcm` into heads-up notifications with up to three
   action buttons. Buttons POST `{ nudgeResponse }` natively (`NotificationActionReceiver`) without opening the app;
   tapping the body opens the shell at `#nudges`. If the app is in the foreground the nudge is also handed to the
   page via `window.onNativeNudge`.
3. **Contacts.** Opt-in via the bridge; `ContactsSync` posts `{ contacts: [...] }` in batches of 200 once, then daily.
4. **The token.** The ingest URL `http(s)://<node>/ingest/opportuneApp/<token>` lives in SharedPreferences (`Prefs`)
   and is the one credential for every POST. The web app gets it as `?token=` on the URL.

The contract between the page and the shell is **`docs/APP-BRIDGE.md`**. Read that first.

Package: `club.opportune.app`. minSdk 26, target/compile 34. Kotlin, AGP 8.2, Gradle 8.2.

## How the shell works

`MainActivity` is the only screen.

- Loads `${nodeUrl}/app`, appending `?token=<token>` when Prefs has an ingest URL and `#nudges` when launched from a
  notification tap. `nodeUrl` is the explicit override from the fallback screen, else the base of the ingest URL, else
  `https://opportune.club` (`Prefs.DEFAULT_NODE_URL`).
- JavaScript and DOM storage on; `navigator.geolocation` is granted to the node origin (when the app itself has
  location permission). Dark `#090b22` background while loading; edge-to-edge with the system-bar and keyboard insets
  applied as padding, so the page never deals with safe areas. Back navigates WebView history, then exits.
- Links off the node origin (`t.me`, other http(s), `tg:`, `mailto:`…) open in the system handler.
- User agent gets ` opportune-android/<versionName>` appended.
- Injects `window.opportuneNative` (`MainActivity.Bridge`) with every method in the bridge doc, plus one extra:
  `stopContacts()` turns the daily contacts sync off again (the OS permission stays granted).
- Calls back into the page: `onNativePermissions` after every permission result and after each page load,
  `onNativeLocation` for `getCurrentLocation()`, `onNativeNudge` when a push arrives while resumed, `onNativeResume`
  in `onResume` and after a nudge was answered from a notification button while the app was open.
- If the main frame fails to load (network error, or HTTP ≥ 500) a native fallback shows the error with **Retry** and a
  **Change node** field; a valid URL typed there becomes the node override.

Details worth knowing on the web side:

- `setIngestUrl(url)` is a no-op (logged) if the URL isn't `…/ingest/<source>/<token>`. On success it persists, starts
  `LocationService` (only if location is already granted; call `requestLocation()` next) and registers the FCM token.
- `signOut()` (`Session.signOut`) is the inverse: clears the ingest URL, the FCM-registered-token memory, the contacts
  switch and sync markers, the post markers and cached nudges (the node override stays); stops `LocationService`
  (which drops its queued points and its location / activity-recognition registrations); cancels all notifications;
  deletes the FCM token so the node can't push to this phone any more. Then emits `onNativePermissions` (`contacts`
  reads false). The OS permissions stay granted. The shell does not touch the WebView's localStorage: the web app
  clears its own.
- `requestLocation()` runs the chain fine/coarse → background (with a rationale dialog) → activity recognition, then
  starts the service and emits `onNativePermissions`. A hard denial shows a dialog pointing at Settings.
- `requestNotifications()` prompts on Android 13+; if notifications are blocked in settings it opens the app's
  notification settings page instead.
- `requestContacts()` prompts for READ_CONTACTS; on grant it flips `shareContacts` on and syncs right away, then daily
  from the location heartbeat / app resume. `getPermissions().contacts` is `permission granted && shareContacts on`.
- `getCurrentLocation()` → `onNativeLocation({ lat, lng, acc, at })` with `at` an ISO-8601 string (same as the location
  posts). If no permission yet, it runs the permission chain first and delivers afterwards. On failure it calls
  `onNativeLocation({ error: "<reason>" })` with no `lat`/`lng`.
- `getDeviceInfo()` returns `{ model, manufacturer, androidVersion, sdk, appVersion, versionCode }`.
- `getPermissions()` on Android < 10 reports `backgroundLocation = location` and `activity = true` (those runtime
  permissions don't exist there).

## What Malcolm has to do (once)

### 1. Firebase project + Android app

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project** (any name, e.g. `opportune`).
   Analytics off is fine.
2. In the project: **Add app** → Android. Package name **`club.opportune.app`**. Nickname optional.
   No SHA-1 needed (we don't use Google Sign-In).
3. **Download `google-services.json`** and put it at **`apps/android/app/google-services.json`**.
   (It's gitignored. Without it the app still builds and does location, but push stays off.)

### 2. Service account for the server

1. Firebase console → Project settings (gear) → **Service accounts** → **Generate new private key**.
2. Put the whole JSON file, stringified on one line, into the server env as
   `FIREBASE_SERVICE_ACCOUNT_JSON`. Easiest:
   ```sh
   # in the opportune repo
   printf 'FIREBASE_SERVICE_ACCOUNT_JSON=%s\n' "$(node -e 'process.stdout.write(JSON.stringify(require("/path/to/downloaded-key.json")))')" >> .env
   ```
   Restart the node; the log should say `[fcm] firebase project <id> ready`. If the var is unset the fcm
   channel logs a warning and nudges fall through to Telegram.

### 3. Build and install

Needs a JDK 17 and the Android SDK (platform 34). On this Mac both exist
(`/opt/homebrew/opt/openjdk@17`, `~/Library/Android/sdk`); `local.properties` points at the SDK.

```sh
cd apps/android
JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew :app:assembleDebug
# phone over USB or wireless debugging (adb connect <ip>:<port> first for wireless):
~/Library/Android/sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or open `apps/android` in Android Studio and press Run. Debug builds have WebView remote debugging on
(`chrome://inspect` on a laptop with the phone attached).

### 4. On the phone

1. Open the app. It loads `https://opportune.club/app`, which shows the web onboarding (invite code or the 6-char
   claim code from Telegram `/sources`). Onboarding calls `setIngestUrl` and then asks for permissions through the
   bridge; pick **Allow all the time** for background location.
2. The "opportune is on" notification means the location service is running.
3. Self-hosted node: if the app can't reach opportune.club (or you want a LAN node) the fallback screen has a
   **Change node** field; e.g. `http://192.168.1.10:3400`. Cleartext HTTP is allowed for this.
4. Test push from the node:
   ```sh
   curl -X POST http://localhost:3400/api/dev/opportunity -H 'content-type: application/json' \
     -d '{"kind":"test","participants":["<personId>"],"summary":"Eileen is home and open, a block away."}'
   ```

## Payloads the shell sends

| When | Body |
|---|---|
| location updates, heartbeat | `[{ lat, lng, acc?, speed?, at, battery?, motion? }, …]` |
| app start / `setIngestUrl` / token rotation | `{ fcmToken, device: { model, manufacturer, android, app } }` |
| notification action button | `{ nudgeResponse: { nudgeId, key } }` |
| contacts granted, then daily | `{ contacts: [{ name, emails: [], phones: [] }] }` in batches of 200 |

Porchlight, status, home and in-app nudge responses are posted by the web app itself.

Push payload it expects (data message): `{ nudgeId, text, actions: '[{"key","label"}]' }`.

## Notes

- A reboot or app update restarts the location service (`BootReceiver`) if the ingest URL is set. Nothing starts
  the service without one: `start()`, `BootReceiver` and `onStartCommand` (a `START_STICKY` revival) all check.
- A location post answered with 401 (token revoked) or 404 (source removed) drops the batch and runs the same
  sign-out as the bridge, service included, so a dead token never keeps the service alive. Anything else (no network,
  5xx) keeps the batch queued for the next try. The web app sees the same 401 on its next request and signs out too;
  if the shell was wrong (a transient 404 while the node was being redeployed) the web app re-calls `setIngestUrl`
  on its next open, since its session is still good.
- Pushes that arrive after sign-out are ignored (`FCMService` checks for an ingest URL).
- Self-hosted nodes need their own Firebase project and their own build of this app (the app is bound to
  one FCM project via `google-services.json`), or a push relay; see DESIGN.md §4.
- Files: `MainActivity` (WebView + bridge + fallback), `Prefs`, `Session` (sign-out), `ApiClient`, `LocationService`,
  `ActivityReceiver`, `FCMService`, `NotificationActionReceiver`, `ContactsSync`, `BootReceiver`.
