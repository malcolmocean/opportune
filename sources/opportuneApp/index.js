import { handleAppPayload } from '../../channels/fcm/index.js'

// The opportune Android app. One URL does everything: it POSTs locations (same shapes as locationPost),
// its FCM token, nudge responses, porchlight status, and (opt-in) contacts. See channels/fcm for the handler.
// Profile text is handled here: { story: 'free weeknights after 8...' } (max 2000 chars; friends can read it) and
// { defaultNote: 'come round the back' } (standing drop-in note; a status note replaces it one time). '' clears either.
export default {
  id: 'opportuneApp',
  name: 'opportune Android app',
  description: 'Our Android app: background location, native push nudges with yes/veto buttons, porchlight toggle. One URL to paste.',
  repo: 'https://github.com/malcolmocean/opportune/tree/main/apps/android',
  kinds: ['location', 'motion', 'status'],
  setup: [
    { key: 'installed', type: 'install-app', label: 'Install the opportune Android app, open it, choose "I already use the Telegram bot", and type this code.' },
  ],
  ingest(ctx, person, config, body) {
    if (body && !Array.isArray(body) && (typeof body.story === 'string' || typeof body.defaultNote === 'string')) {
      ctx.people.setProfile(person.id, { story: body.story, dropinNote: body.defaultNote })
    }
    return handleAppPayload(ctx, person, body, config)
  },
}
