// The Android shell injects window.opportuneNative (docs/APP-BRIDGE.md). Everything here is
// feature-detected: in a plain browser `isNative` is false and each call degrades sensibly.

const native = typeof window !== 'undefined' && window.opportuneNative ? window.opportuneNative : null
// The shell announces itself by the injected object and by a UA suffix (" opportune-android/<version>").
export const isNative = !!native || / opportune-android\//.test(navigator.userAgent || '')

const call = (name, ...args) => { try { return native?.[name]?.(...args) } catch { return undefined } }
const json = (name) => { try { const s = native?.[name]?.(); return s ? JSON.parse(s) : null } catch { return null } }

export const bridge = {
  nodeUrl: () => call('getNodeUrl') || '',
  ingestUrl: () => call('getIngestUrl') || '',
  setIngestUrl: url => call('setIngestUrl', url),
  permissions: () => (native ? json('getPermissions') : null),
  requestLocation: () => call('requestLocation'),
  requestNotifications: () => call('requestNotifications'),
  // contacts: `permissions().contacts` means OS permission granted AND the share switch on. requestContacts()
  // grants + switches on + syncs; stopContacts() switches off.
  requestContacts: () => call('requestContacts'),
  stopContacts: () => call('stopContacts'),
  // { model, manufacturer, androidVersion, sdk, appVersion, versionCode } in the shell
  deviceInfo: () => (native ? json('getDeviceInfo') || {} : { platform: 'web', model: (navigator.userAgent || '').slice(0, 120) }),
  openExternal(url) {
    if (native?.openExternal) { try { native.openExternal(url); return } catch {} }
    window.open(url, '_blank', 'noopener')
  },
}

// ---- shell → web callbacks. We own window.onNative* and fan out to subscribers. ----
// onNativePermissions also fires once after every page load (initial state) and whenever a prompt is answered.
// onNativeResume fires on foreground and when a nudge was answered from a notification while the app is open.
const subs = { permissions: new Set(), resume: new Set(), nudge: new Set() }
const fan = set => payload => { for (const fn of set) { try { fn(payload) } catch (e) { console.error(e) } } }
window.onNativePermissions = fan(subs.permissions)
window.onNativeResume = fan(subs.resume)
window.onNativeNudge = fan(subs.nudge)
export const onPermissions = fn => subs.permissions.add(fn)
export const onResume = fn => subs.resume.add(fn)
export const onNudge = fn => subs.nudge.add(fn)

// One location fix. Native: getCurrentLocation() (runs the permission chain first if needed) answers through
// onNativeLocation with { lat, lng, acc|null, at } or { error }. Browser: geolocation API. Inside the shell we
// never fall back to navigator.geolocation: the WebView may deny it until the OS permission is granted.
let pending = []
window.onNativeLocation = loc => {
  const ps = pending; pending = []
  const err = loc?.error || loc?.lat == null ? new Error(loc?.error || 'no location fix') : null
  for (const p of ps) err ? p.reject(err) : p.resolve(loc)
}
export function currentLocation({ timeoutMs = 60000 } = {}) {
  if (native?.getCurrentLocation) {
    return new Promise((resolve, reject) => {
      const p = { resolve: loc => { clearTimeout(t); resolve(loc) }, reject: e => { clearTimeout(t); reject(e) } }
      const t = setTimeout(() => { pending = pending.filter(x => x !== p); reject(new Error('no location fix yet. Is location allowed for the app?')) }, timeoutMs)
      pending.push(p)
      try { native.getCurrentLocation() } catch (e) { clearTimeout(t); pending = pending.filter(x => x !== p); reject(e) }
    })
  }
  if (isNative) return Promise.reject(new Error('the app could not get a location'))
  if (!navigator.geolocation) return Promise.reject(new Error('this browser has no location'))
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, at: new Date(pos.timestamp).toISOString() }),
    err => reject(new Error(err.code === 1 ? 'location was denied. Allow it in the browser and try again.' : err.message || 'could not get a location')),
    { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60e3 }))
}

// Browser-side read of the geolocation permission, shaped like the native one (only `location` is knowable).
export async function browserPermissions() {
  let location = null
  try { location = (await navigator.permissions?.query({ name: 'geolocation' }))?.state === 'granted' } catch {}
  return { location, notifications: null, backgroundLocation: false, activity: null, contacts: null }
}
