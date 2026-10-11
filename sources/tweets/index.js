import { inferBatch } from './infer.js'

// Tweets as whereabouts, via the Community Archive (community-archive.org): an open archive of
// consenting users' tweets behind a public, read-only Supabase REST API. No Twitter API needed.
// The anon key below is the one the archive publishes in its docs (intentionally public, read-only).
// Override with TWEETS_ARCHIVE_URL / TWEETS_ARCHIVE_KEY if it rotates.
const DEFAULT_URL = 'https://fabxmporizzqflnftavs.supabase.co'
const DEFAULT_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhYnhtcG9yaXp6cWZsbmZ0YXZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjIyNDQ5MTIsImV4cCI6MjAzNzgyMDkxMn0.UIEJiUNkLsW28tBHmG-RQDW-I5JNlJLt62CSk9D_qG8'
const PAGE = 200
const MAX = 1000
const FIRST_RUN_MS = 7 * 864e5
const OVERLAP_MS = 24 * 3600e3   // the archive backfills with original created_at; re-scan a day (dedupeKey makes it free)

export const normalizeHandle = v => String(v || '').trim().replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, '').replace(/[/?].*$/, '').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15)

export default {
  id: 'tweets',
  name: 'Tweets (Community Archive)',
  description: 'Reads your public tweets from the Community Archive and spots the ones that say where you are or will be ("in SF this week", "landing in NYC Thursday").',
  repo: 'https://github.com/malcolmocean/opportune/tree/main/sources/tweets',
  kinds: ['mention'],
  intervalMin: 60,
  setup: [
    { key: 'handle', type: 'text', label: 'Your X/Twitter handle. Your tweets need to be in the Community Archive (upload yours at community-archive.org).', parse: normalizeHandle },
  ],
  async poll(ctx, person, config, lastPollIso) {
    const handle = normalizeHandle(config.handle)
    if (!handle) return []
    const env = ctx.env || process.env
    const since = sinceIso(lastPollIso)
    const rows = await fetchTweets(env, handle, since)
    const fresh = rows
      .filter(t => t.tweet_id && t.full_text && !/^RT @/i.test(t.full_text))
      .filter(t => !ctx.db.get('select 1 from observations where person_id = ? and source_id = ? and dedupe_key = ?', person.id, 'tweets', String(t.tweet_id)))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    if (!fresh.length) return []
    const inferred = await inferBatch(ctx, fresh.map(t => ({ id: String(t.tweet_id), text: t.full_text, createdAt: t.created_at })), { tz: person.tz, personId: person.id })
    return fresh.map(t => {
      const id = String(t.tweet_id), inf = inferred[id] || {}
      const user = t.username || handle
      return {
        kind: 'mention', at: new Date(t.created_at).toISOString(), until: inf.window?.end || null, dedupeKey: id,
        data: {
          text: t.full_text, provider: 'twitter', url: `https://x.com/${user}/status/${id}`, handle: user,
          inReplyTo: t.reply_to_username || null,
          inferredPlace: inf.place || null, inferredWindow: inf.window || null, inferredKind: inf.kind || null,
        },
      }
    })
  },
}

const sinceIso = last => new Date(last ? new Date(last).getTime() - OVERLAP_MS : Date.now() - FIRST_RUN_MS).toISOString()

async function fetchTweets(env, handle, sinceIso) {
  const base = (env.TWEETS_ARCHIVE_URL || DEFAULT_URL).replace(/\/+$/, '').replace(/\/rest\/v1$/, '')
  const key = env.TWEETS_ARCHIVE_KEY || DEFAULT_KEY
  const out = []
  for (let offset = 0; offset < MAX; offset += PAGE) {
    const q = new URLSearchParams({
      select: 'tweet_id,username,created_at,full_text,reply_to_tweet_id,reply_to_username,quoted_tweet_id',
      username: `ilike.${handle}`, created_at: `gte.${sinceIso}`, order: 'created_at.desc', limit: String(PAGE), offset: String(offset),
    })
    const r = await fetch(`${base}/rest/v1/enriched_tweets?${q}`, { headers: { apikey: key, authorization: `Bearer ${key}`, accept: 'application/json' } })
    if (!r.ok) throw new Error(`community archive ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const page = await r.json()
    if (!Array.isArray(page)) throw new Error('community archive: unexpected response shape')
    out.push(...page)
    if (page.length < PAGE) break
  }
  return out
}
