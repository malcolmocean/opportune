# opportune Android app

Native Android client for an opportune node. It is three things:

1. **Location source.** A foreground service posts `[{lat, lng, acc, speed, at, battery, motion}]`
   batches to your ingest URL on 100 m / 5 min displacement, plus a 15-minute heartbeat.
   `motion` (still / walking / driving) comes from Activity Recognition when that permission is granted.
2. **Push channel.** FCM data messages from `channels/fcm` become heads-up notifications with up to three
   action buttons (yes / no / "shouldn't have bugged me"). Tapping one POSTs `{ nudgeResponse }` back.
3. **Minimal UI.** Recent nudges, a Porchlight row (Open / Ask / Closed for 6 h), a Review button that opens
   the node's web management page, and an opt-in "Share contacts" switch.

Everything the app sends goes to **one URL**, the one the Telegram bot hands out for the
`opportune Android app` source: `http(s)://<node>/ingest/opportuneApp/<token>`. The token in it is the auth.
Server side: `sources/opportuneApp/index.js` dispatches on payload shape, `channels/fcm/index.js` sends.

Package: `com.malcolmocean.opportune`. minSdk 26, target/compile 34. Kotlin, AGP 8.2, Gradle 8.2.

## What Malcolm has to do (once)

### 1. Firebase project + Android app

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project** (any name, e.g. `opportune`).
   Analytics off is fine.
2. In the project: **Add app** → Android. Package name **`com.malcolmocean.opportune`**. Nickname optional.
   No SHA-1 needed (we don't use Google Sign-In).
3. **Download `google-services.json`** and put it at **`apps/android/app/google-services.json`**.
   (It's gitignored. Without it the app still builds and does location, but push stays off and the
   main screen says so.)

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
# phone in USB-debugging mode:
~/Library/Android/sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or open `apps/android` in Android Studio and press Run.

### 4. On the phone

1. In Telegram, `/sources` → **opportune Android app** → say `ok` → copy the URL it gives you.
2. Open the app, paste the URL, **Save**. Grant notifications, location, then pick **Allow all the time**
   for background location (and allow physical activity if asked).
3. The "opportune is on" notification means the location service is running. The status line shows the
   last successful post and whether push is registered.
4. Test push from the node: `node -e` or a Telegram chat that produces a nudge; or directly
   ```sh
   curl -X POST http://localhost:3400/api/dev/opportunity -H 'content-type: application/json' \
     -d '{"kind":"test","participants":["<personId>"],"summary":"Eileen is home and open, a block away."}'
   ```

## Payloads the app sends

| When | Body |
|---|---|
| location updates, heartbeat | `[{ lat, lng, acc?, speed?, at, battery?, motion? }, …]` |
| app start / token rotation | `{ fcmToken, device: { model, manufacturer, android, app } }` |
| notification button / list button | `{ nudgeResponse: { nudgeId, key } }` |
| porchlight buttons | `{ status: { porchlight: 'open' \| 'ask' \| 'closed' } }` |
| contacts switch on, then daily | `{ contacts: [{ name, emails: [], phones: [] }] }` in batches of 200 |

Push payload it expects (data message): `{ nudgeId, text, actions: '[{"key","label"}]' }`.

## Notes

- Cleartext HTTP is allowed (`usesCleartextTraffic`) so a LAN node like `http://192.168.1.10:3400` works.
- The review button opens `<base>/web/manage?token=<token>`; that page is served by `web/routes.js` on the node.
- A reboot or app update restarts the location service (`BootReceiver`) if the URL is set.
- Self-hosted nodes need their own Firebase project and their own build of this app (the app is bound to
  one FCM project via `google-services.json`), or a push relay; see DESIGN.md §4.
