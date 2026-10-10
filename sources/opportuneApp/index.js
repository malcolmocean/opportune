import { handleAppPayload } from '../../channels/fcm/index.js'

// The opportune Android app. One URL does everything: it POSTs locations (same shapes as locationPost),
// its FCM token, nudge responses, porchlight status, and (opt-in) contacts. See channels/fcm for the handler.
export default {
  id: 'opportuneApp',
  name: 'opportune Android app',
  description: 'Our Android app: background location, native push nudges with yes/veto buttons, porchlight toggle. One URL to paste.',
  repo: 'https://github.com/malcolmocean/opportune/tree/main/apps/android',
  kinds: ['location', 'motion', 'status'],
  setup: [
    { key: 'installed', type: 'install-app', label: 'Install the opportune Android app, open it, choose "I already use the Telegram bot", and type this code.' },
  ],
  ingest(ctx, person, config, body) { return handleAppPayload(ctx, person, body, config) },
}
