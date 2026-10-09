import locationPost from '../../sources/locationPost/index.js'

// Native push via Firebase Cloud Messaging. The Android app (apps/android) registers its FCM token by
// POSTing { fcmToken } to its opportuneApp ingest URL; nudges go out as data messages and the app renders
// them as heads-up notifications with action buttons. Action taps come back as { nudgeResponse }.
let messaging = null
const PORCHLIGHT = new Set(['open', 'closed', 'ask'])
const PORCHLIGHT_HOURS = 6

export default {
  id: 'fcm', name: 'opportune Android app (push)', description: 'Nudges as native Android notifications with yes/veto buttons.',
  repo: 'https://github.com/malcolmocean/opportune/tree/main/channels/fcm',
  setup: [],

  async start(ctx) {
    const L = ctx.log('fcm')
    const raw = ctx.env.FIREBASE_SERVICE_ACCOUNT_JSON
    if (!raw) { L.warn('FIREBASE_SERVICE_ACCOUNT_JSON missing; fcm channel disabled (nudges fall through to telegram)'); return }
    let creds
    try { creds = JSON.parse(raw) } catch (e) { L.error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON:', e.message); return }
    const { initializeApp, cert, getApps } = await import('firebase-admin/app')
    const { getMessaging } = await import('firebase-admin/messaging')
    const app = getApps().find(a => a.name === 'opportune') || initializeApp({ credential: cert(creds) }, 'opportune')
    messaging = getMessaging(app)
    L.info(`firebase project ${creds.project_id} ready`)
  },

  // nudge: { id, text, actions: [{key,label}], ... }. identity.external_id is the device's FCM token.
  async send(ctx, person, identity, nudge) {
    if (!messaging) throw new Error('fcm not started')
    const actions = (nudge.actions || []).map(a => ({ key: a.key, label: a.label }))
    try {
      const id = await messaging.send({
        token: identity.external_id,
        data: { nudgeId: nudge.id, text: nudge.text, actions: JSON.stringify(actions), decisionId: nudge.decision_id || '', sentAt: new Date().toISOString() },
        android: { priority: 'high', ttl: ttlMs(nudge.expires_at) },
      })
      return { externalId: id }
    } catch (e) {
      // A dead token (app uninstalled, token rotated) will never work again: drop it so the next nudge goes via telegram.
      if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'].includes(e.code)) {
        ctx.db.run('delete from identities where channel = ? and external_id = ?', 'fcm', identity.external_id)
        ctx.log('fcm').warn(`dropped dead token for ${person.display_name} (${e.code})`)
      }
      throw e
    }
  },

  // test hook
  __setMessaging(m) { messaging = m },
}

// Everything the Android app POSTs to its ingest URL lands here (via sources/opportuneApp). Returns Observation[].
// Shapes: [{lat,lng,...}] | {lat,lng,...} | { fcmToken, device? } | { nudgeResponse: { nudgeId, key } }
//         | { status: { porchlight, note? } } | { contacts: [{ name, emails, phones }] }. Keys may be combined.
export async function handleAppPayload(ctx, person, body, config = {}) {
  if (!body) return []
  if (Array.isArray(body) || body.lat != null) return locationPost.ingest(ctx, person, config, body)
  const out = []
  if (typeof body.fcmToken === 'string' && body.fcmToken) {
    ctx.people.bind(person.id, 'fcm', body.fcmToken, { device: body.device || null, boundAt: new Date().toISOString() })
    ctx.log('fcm').info(`bound token for ${person.display_name}${body.device?.model ? ` (${body.device.model})` : ''}`)
  }
  if (body.nudgeResponse?.nudgeId && body.nudgeResponse.key) {
    const { nudgeId, key } = body.nudgeResponse
    if (key.startsWith('wish:')) ctx.judge.rate(key.slice(5), 'good', 'person wished they had been told')
    else await ctx.nudges.respond(nudgeId, key, body.nudgeResponse.note)
  }
  if (body.status && PORCHLIGHT.has(body.status.porchlight)) {
    out.push({ kind: 'status', at: body.status.at || new Date().toISOString(), until: new Date(Date.now() + PORCHLIGHT_HOURS * 3600e3).toISOString(), data: { porchlight: body.status.porchlight, note: body.status.note || null } })
  }
  if (Array.isArray(body.contacts)) {
    const n = ctx.people.addContacts(person.id, body.contacts)
    ctx.log('fcm').info(`${person.display_name}: ${body.contacts.length} contacts → ${n} new entries`)
  }
  if (Array.isArray(body.locations)) out.push(...locationPost.ingest(ctx, person, config, body.locations))
  return out
}

const ttlMs = iso => { if (!iso) return 6 * 3600e3; const d = new Date(iso).getTime() - Date.now(); return Math.max(60e3, Math.min(d, 24 * 3600e3)) }
