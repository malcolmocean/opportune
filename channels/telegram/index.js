import { randomBytes } from 'node:crypto'
import { Bot, InlineKeyboard } from 'grammy'
import { manageUrl } from '../../web/routes.js'

// Telegram: onboarding, nudges with action buttons, and chat with your agent.
let bot, me

// ---------- pure helpers (exported for tests) ----------
export const CALLBACK_MAX_BYTES = 64          // Telegram's callback_data limit
const CB_KV_PREFIX = 'tgcb:'
const SKIP_WORDS = /^(skip|-|none)$/i
const WISH_NOTE = 'person wished they had been told'

// `t:a:rest...` — the tail may itself contain ':' (e.g. grant:autoYesDropin:<fromId>), so only split twice.
export function parseCallback(d) {
  const [t, a, ...rest] = String(d || '').split(':')
  return { t, a, b: rest.join(':') }
}

// callback_data for a nudge action. wish:<decisionId> keys become wish:<decisionId>:<nudgeId> so the
// handler can rate the decision AND record the response on the digest nudge. Anything over 64 bytes is
// parked in kv under a short id (n:<nudgeId>:k:<shortId>) and resolved on tap.
export function nudgeCallbackData(nudgeId, key, store) {
  const d = key.startsWith('wish:') ? `wish:${key.slice(5)}:${nudgeId}` : `n:${nudgeId}:${key}`
  if (Buffer.byteLength(d) <= CALLBACK_MAX_BYTES) return d
  const short = randomBytes(4).toString('base64url')
  store(CB_KV_PREFIX + short, key)
  return `n:${nudgeId}:k:${short}`
}
export function resolveNudgeAction(b, lookup) {
  if (!b.startsWith('k:')) return b
  return lookup(CB_KV_PREFIX + b.slice(2)) ?? null
}

export const escapeMdV2 = s => String(s ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, m => `\\${m}`)

// /review: plain text (no parse_mode, so free-form reasoning can't break the message), tier-appropriate buttons.
export function reviewMessage(r) {
  const suppress = r.verdict === 'suppress'
  const text = [`${suppress ? '🤫' : '🔔'} ${r.summary || '(no summary)'}`, r.reasoning ? `— ${r.reasoning}` : null, r.rating ? `(rated ${r.rating})` : null].filter(Boolean).join('\n')
  const buttons = suppress
    ? [{ label: '👍 right to stay quiet', data: `rate:${r.id}:good` }, { label: '👎 should have told me', data: `rate:${r.id}:bad` }]
    : [{ label: '👍 good call', data: `rate:${r.id}:good` }, { label: "👎 shouldn't have bugged me", data: `rate:${r.id}:bad` }]
  return { text, buttons }
}

// Prompt for a manifest setup step: mention the default, and that optional steps can be skipped.
export function setupPrompt(step) {
  let label = step.label
  if (step.default !== undefined && !label.includes(String(step.default))) label += ` (default: ${step.default})`
  if (step.optional) label += " (or 'skip')"
  return label
}
// Apply the person's answer to a setup step → { ok, value?, unset?, error? }. Never throws: a throwing parse() re-asks.
export function applySetupStep(step, text) {
  const raw = text == null ? '' : String(text).trim()
  if (step.type === 'install-app') return { ok: true, unset: true }
  if (step.type === 'choice') return step.choices.includes(raw) ? { ok: true, value: raw } : { ok: false, error: 'Tap one of the options.' }
  if (!raw || SKIP_WORDS.test(raw)) {
    if (step.optional) return { ok: true, unset: true }
    return { ok: false, error: `This one's needed. ${setupPrompt(step)}` }
  }
  try { return { ok: true, value: step.parse ? step.parse(raw) : raw } } catch (e) { return { ok: false, error: `That didn't work (${e.message}). ${setupPrompt(step)}` } }
}

export function acceptReply(inviter, capabilities) {
  const names = (capabilities?.sources || []).map(s => s.name || s.id).filter(Boolean)
  return `Linked with ${inviter.display_name}${inviter.node_url ? ` (on ${inviter.node_url})` : ''}.\nTheir node can share: ${names.length ? names.join(', ') : 'nothing listed yet'}.`
}

export const HELP_TEXT = [
  'Just talk to me. Or:',
  "/whosaround — who's plausibly free",
  '/porchlight — open/closed/ask for drop-ins',
  '/invite Name — one-time link for someone you want more of',
  '/accept <link> — accept an invite from a friend on another node',
  '/friends — your people',
  '/sources — connect calendar, location, …',
  '/home — share your home location for drop-ins',
  '/phone — share your number so friends\' contacts can find you',
  '/review — rate my recent calls',
  '/manage — settings page: friends, grants, sources, map',
  '/me — what I know about you right now',
].join('\n')

export default {
  id: 'telegram', name: 'Telegram', description: 'Chat with your agent and get nudges in Telegram.',
  setup: [],
  deepLink: (_ctx, code) => (me ? `https://t.me/${me.username}?start=${code}` : null),

  async start(ctx) {
    const token = ctx.env.TELEGRAM_BOT_TOKEN
    if (!token) { ctx.log('telegram').warn('TELEGRAM_BOT_TOKEN missing; channel disabled'); return }
    bot = new Bot(token)
    me = await bot.api.getMe()
    const L = ctx.log('telegram')
    const whoami = c => ctx.people.identify('telegram', c.from.id)

    bot.command('start', async c => {
      const code = c.match?.trim()
      let p = whoami(c)
      // app-first people arrive with link-<sourceToken>: bind this Telegram account to the person the app created
      if (code?.startsWith('link-')) {
        const sc = ctx.sources.byToken(code.slice(5))
        if (!sc) return c.reply('That link has expired. Open the app and tap "Link Telegram" again.')
        if (p && p.id !== sc.person_id) return c.reply(`This Telegram account is already set up as ${p.display_name}. Use the app's manage page to merge, or start fresh in the app.`)
        ctx.people.bind(sc.person_id, 'telegram', c.from.id, { username: c.from.username })
        p = ctx.people.get(sc.person_id)
        const step = p.onboarding?.step
        if (step && step !== 'done') { await c.reply('Linked. Let\'s pick up where you left off.'); return advance(ctx, c, p, step) }
        return c.reply(`Linked. Nudges can reach you here and in the app. Say "who's around tonight?" anytime.`)
      }
      if (!p) {
        p = ctx.people.create({ displayName: [c.from.first_name, c.from.last_name].filter(Boolean).join(' ') })
        ctx.people.bind(p.id, 'telegram', c.from.id, { username: c.from.username })
        const inv = code && ctx.people.peekInvite(code)
        const inviter = inv && ctx.people.get(inv.inviter_id)
        ctx.people.update(p.id, { onboarding: { step: 'name', pendingInvite: inv ? code : null } })
        let greeting = inviter
          ? `Hi. ${inviter.display_name} wants to see more of you, and asked me to help make that cheap.\n\nI'm opportune: I notice when hanging out would be easy (same event, a block away, both free Thursday) and nudge you. Only people who opt in to each other. Nothing public.`
          : `Hi. I'm opportune: I notice when hanging out with your people would be cheap, and nudge you.`
        if (code && !inv) greeting += `\n\nThat invite link has already been used or expired; carrying on without it.`
        return askName(c, ctx.people.get(p.id), greeting)
      }
      if (code) {
        const inviter = ctx.people.acceptInvite(code, p.id)
        return c.reply(inviter ? `Linked you with ${inviter.display_name}.` : 'That invite is used up or expired.')
      }
      await c.reply(`Hey ${p.display_name}. Say "who's around tonight?", "I'm home and open", or /help.`)
    })

    bot.command('help', c => c.reply(HELP_TEXT))
    bot.command('manage', c => { const p = whoami(c); if (!p) return; c.reply(`Your settings page (private link, don't forward it):\n${manageUrl(ctx, p.id)}`) })

    bot.command('whosaround', async c => { const p = whoami(c); if (!p) return; await c.replyWithChatAction('typing'); c.reply(await ctx.agent.chat(p.id, `Who's around ${c.match || 'this evening'}? Give me a shortlist.`)) })
    bot.command('me', async c => { const p = whoami(c); if (!p) return; const obs = ctx.observations.recent(p.id, { limit: 8 }); c.reply(obs.length ? obs.map(o => `${o.kind} ${o.at.slice(0, 16)} ${JSON.stringify(o.data).slice(0, 120)}`).join('\n') : 'Nothing yet. /sources to connect something.') })
    bot.command('friends', async c => {
      const p = whoami(c); if (!p) return
      const fs = ctx.people.friendsOf(p.id)
      c.reply(fs.length ? fs.map(f => `${f.want_more ? '★' : '·'} ${f.display_name} (${f.tier}${f.remote ? ', remote' : ''})${f.note ? ` — ${f.note}` : ''}`).join('\n') + `\n\n★ = you want more of them. Tell me to change any of this, or edit tiers and grants here (private link): ${manageUrl(ctx, p.id)}#people` : 'No one yet. /invite Name to make a link.')
    })
    bot.command('invite', async c => {
      const p = whoami(c); if (!p) return
      const name = c.match?.trim()
      if (!name) return c.reply('Who? e.g. /invite Eileen')
      const { url } = ctx.people.invite(p.id, { inviteeName: name })
      c.reply(`One-time link for ${name}:\n${url}\n\nIt says you want to see more of them. Send it however you like.`)
    })
    // a friend on another node sent an invite link
    bot.command('accept', async c => {
      const p = whoami(c); if (!p) return
      const url = c.match?.trim()
      if (!/^https?:\/\//i.test(url || '')) return c.reply('Paste the invite link, e.g. /accept https://their-node.example/i/abc123')
      await c.replyWithChatAction('typing')
      try {
        const { inviter, capabilities } = await ctx.federation.acceptRemoteInvite(p, url)
        return c.reply(acceptReply(inviter, capabilities))
      } catch (e) { L.warn('accept failed', e.message); return c.reply(`Couldn't accept that invite: ${e.message}`) }
    })
    bot.command('phone', async c => {
      const p = whoami(c); if (!p) return
      c.reply(`Share your number? Only used so friends who have you in their contacts get told you're here.`, { reply_markup: { keyboard: [[{ text: 'Share my number', request_contact: true }]], one_time_keyboard: true, resize_keyboard: true } })
    })
    bot.command('home', async c => {
      const p = whoami(c); if (!p) return
      c.reply(`Share your home location (📎 → Location) and I'll use it for drop-ins. If you skip this, I'll work it out from where your phone sleeps.`)
      ctx.people.update(p.id, { onboarding: { ...(p.onboarding || {}), awaitingHome: true } })
    })
    bot.command('porchlight', async c => {
      const p = whoami(c); if (!p) return
      c.reply('Drop-ins right now?', { reply_markup: new InlineKeyboard().text('Open', 'pl:open').text('Ask me', 'pl:ask').text('Closed', 'pl:closed') })
    })
    bot.command('sources', async c => {
      const p = whoami(c); if (!p) return
      await sourcesMenu(ctx, c, p)
    })
    bot.command('review', async c => {
      const p = whoami(c); if (!p) return
      const rows = ctx.db.all(`select d.id, d.verdict, d.reasoning, d.rating, o.summary from decisions d left join opportunities o on o.id = d.opportunity_id where d.person_id = ? order by d.created_at desc limit 6`, p.id)
      if (!rows.length) return c.reply('No judgement calls yet.')
      await c.reply(`Full history (private link): ${manageUrl(ctx, p.id)}#review`)
      for (const r of rows) {
        const { text, buttons } = reviewMessage(r)
        const kb = new InlineKeyboard(); for (const b of buttons) kb.text(b.label, b.data)
        await c.reply(text, { reply_markup: kb })
      }
    })

    bot.on('message:location', async c => {
      const p = whoami(c); if (!p) return
      const { latitude: lat, longitude: lng } = c.message.location
      if (p.onboarding?.awaitingHome) {
        ctx.people.addPlace(p.id, { name: 'home', lat, lng, radiusM: 120 })
        ctx.people.update(p.id, { onboarding: { ...p.onboarding, awaitingHome: false } })
        await ctx.observations.ingest(p.id, 'manual', [{ kind: 'location', data: { lat, lng, placeName: 'home' } }])
        return c.reply('Home set.')
      }
      await ctx.observations.ingest(p.id, 'manual', [{ kind: 'location', data: { lat, lng } }])
      c.reply('Got it.')
    })

    bot.on('message:contact', async c => {
      const p = whoami(c); if (!p) return
      if (c.message.contact.user_id === c.from.id) {
        ctx.people.bind(p.id, 'phone', c.message.contact.phone_number)
        await c.reply('Got it.', { reply_markup: { remove_keyboard: true } })
      }
    })

    bot.on('message:text', async c => {
      const p = whoami(c)
      if (!p) return c.reply('Say /start to begin.')
      if (p.onboarding?.step && p.onboarding.step !== 'done') return onboard(ctx, c, p, c.message.text.trim())
      if (p.onboarding?.sourceSetup) return sourceStep(ctx, c, p, c.message.text.trim())
      await c.replyWithChatAction('typing')
      try { c.reply(await ctx.agent.chat(p.id, c.message.text)) } catch (e) { L.error(e); c.reply(`Hm, I hit an error: ${e.message}`) }
    })

    bot.on('callback_query:data', async c => {
      const p = whoami(c); const d = c.callbackQuery.data
      await c.answerCallbackQuery()
      if (!p) return
      const { t, a, b } = parseCallback(d)
      // "should have told me" on a digest: the suppress decision was wrong → bad; and record it on the nudge
      const wished = async (decisionId, nudgeId) => {
        ctx.judge.rate(decisionId, 'bad', WISH_NOTE)
        if (nudgeId) await ctx.nudges.respond(nudgeId, `wish:${decisionId}`)
        return c.reply("Noted. I'll speak up about that kind of thing.")
      }
      if (t === 'n') {                      // nudge action: a = nudgeId, b = action key (maybe kv-parked)
        const key = resolveNudgeAction(b, k => ctx.db.kvGet(k))
        if (!key) return c.reply('That button has expired.')
        if (key.startsWith('wish:')) return wished(key.slice(5), a)
        await ctx.nudges.respond(a, key)
        if (key === 'bad') return c.reply('Noted. Fewer of those.')
        if (key === 'yes') return c.reply('Go get it.')
        return
      }
      if (t === 'wish') return wished(a, b)   // wish:<decisionId>:<nudgeId>
      if (t === 'rate') { ctx.judge.rate(a, b); return c.reply(b === 'good' ? 'Thanks.' : 'Noted, adjusting.') }
      if (t === 'pl') { await ctx.observations.ingest(p.id, 'manual', [{ kind: 'status', data: { porchlight: a }, until: new Date(Date.now() + 6 * 3600e3).toISOString() }]); return c.reply(`Porchlight: ${a} for the next 6h.`) }
      if (t === 'ob') return onboardChoice(ctx, c, p, a, b)
      if (t === 'src') return beginSource(ctx, c, p, a)
      if (t === 'srcc') return sourceStep(ctx, c, p, decodeURIComponent(a))
    })

    bot.catch(e => L.error('bot error', e.error?.message || e))
    bot.start({ onStart: () => L.info(`@${me.username} polling`) })
  },

  async send(ctx, person, identity, nudge) {
    if (!bot) throw new Error('telegram not started')
    const kb = new InlineKeyboard()
    for (const a of nudge.actions || []) kb.text(a.label, nudgeCallbackData(nudge.id, a.key, (k, v) => ctx.db.kvSet(k, v)))
    const m = await bot.api.sendMessage(identity.external_id, nudge.text, { reply_markup: (nudge.actions || []).length ? kb : undefined })
    return { externalId: String(m.message_id) }
  },
}

// ---------- onboarding ----------
function askName(c, p, intro) {
  const kb = new InlineKeyboard().text(`I'm ${p.display_name}`, 'ob:name:ok')
  return c.reply(`${intro ? `${intro}\n\n` : ''}Tap to confirm your name, or type a different one.`, { reply_markup: kb })
}
async function advance(ctx, c, p, step) {
  ctx.people.update(p.id, { onboarding: { ...(ctx.people.get(p.id).onboarding || {}), step } })
  if (step === 'name') return askName(c, ctx.people.get(p.id))
  if (step === 'sources') return sourcesMenu(ctx, c, ctx.people.get(p.id), true)
  if (step === 'wantmore') return c.reply(`Who do you want to see more of? Names, comma-separated. I'll make a one-time invite link for each. Or "skip".`)
  if (step === 'porchlight') return c.reply(`Drop-ins at your place: when are they generally welcome?`, { reply_markup: new InlineKeyboard().text('Weekday evenings', 'ob:pl:evenings').text('Weekends', 'ob:pl:weekends').row().text('Ask me each time', 'ob:pl:ask').text('Not really', 'ob:pl:closed') })
  if (step === 'done') {
    ctx.people.update(p.id, { onboarding: { step: 'done' } })
    return c.reply(`That's it. I'll stay quiet unless something's worth it, and each morning I'll show you what I kept quiet about so you can correct me.\n\nTry: "who's around tonight?" or "I'm home and open till 9".\n\nOptional, whenever: /home (or I'll infer it from where your phone sleeps), /phone (so friends' contacts can find you), /manage for tiers and grants (it gives you a private link; don't forward it).`)
  }
}
async function onboard(ctx, c, p, text) {
  const ob = p.onboarding
  if (ob.step === 'name') {
    if (text && !/^(yes|yep|sure|ok|that's fine|y)$/i.test(text)) ctx.people.update(p.id, { displayName: text.replace(/[^\w\s'.-]/g, '').slice(0, 40) })
    return finishName(ctx, c, ctx.people.get(p.id))
  }
  if (ob.step === 'sources') {
    // mid-setup, "skip" belongs to the setup step (optional steps); "done" abandons it
    if (ob.sourceSetup) {
      if (/^(done|next|cancel)$/i.test(text)) { ctx.people.update(p.id, { onboarding: { ...ob, sourceSetup: null } }); return advance(ctx, c, p, 'wantmore') }
      return sourceStep(ctx, c, p, text)
    }
    if (/^(skip|done|next)$/i.test(text)) return advance(ctx, c, p, 'wantmore')
    return c.reply('Pick one above, or "done".')
  }
  if (ob.step === 'wantmore') {
    if (!/^skip$/i.test(text)) {
      const names = text.split(/[,\n]/).map(s => s.trim()).filter(Boolean).slice(0, 10)
      const links = names.map(n => `${n}: ${ctx.people.invite(p.id, { inviteeName: n }).url}`)
      await c.reply(`One-time links (each says you want to see more of them):\n\n${links.join('\n')}`)
    }
    return advance(ctx, c, p, 'porchlight')
  }
  if (ob.step === 'porchlight') return c.reply('Tap one above.')
}
async function finishName(ctx, c, p) {
  const ob = p.onboarding || {}
  if (ob.pendingInvite) { const inviter = ctx.people.acceptInvite(ob.pendingInvite, p.id); if (inviter) await c.reply(`Linked with ${inviter.display_name}.`) }
  return advance(ctx, c, p, 'sources')
}
async function onboardChoice(ctx, c, p, a, b) {
  if (a === 'name' && b === 'ok') return finishName(ctx, c, p)
  if (a === 'pl') {
    const pol = ctx.people.policy(p.id)
    const map = { evenings: { dropinDefault: 'open', dropinWindows: [{ days: [1, 2, 3, 4, 5], start: 18, end: 22 }] }, weekends: { dropinDefault: 'open', dropinWindows: [{ days: [0, 6], start: 10, end: 20 }] }, ask: { dropinDefault: 'ask', dropinWindows: [] }, closed: { dropinDefault: 'closed', dropinWindows: [] } }
    ctx.people.update(p.id, { policy: { ...pol, ...map[b] } })
    return advance(ctx, c, p, 'done')
  }
}
// ---------- source setup (generic over plugin.setup) ----------
async function sourcesMenu(ctx, c, p, onboarding = false) {
  const have = new Set(ctx.sources.forPerson(p.id).map(s => s.source_id))
  const kb = new InlineKeyboard()
  for (const s of Object.values(ctx.plugins.sources)) kb.text(`${have.has(s.id) ? '✓ ' : ''}${s.name}`, `src:${s.id}`).row()
  await c.reply(onboarding ? `Hook up what you like (✓ = already connected). Each is one step; you can add more later with /sources. Say "done" when finished.` : 'Sources:', { reply_markup: kb })
}
async function beginSource(ctx, c, p, sourceId) {
  const s = ctx.plugins.sources[sourceId]
  if (!s) return
  ctx.people.update(p.id, { onboarding: { ...(p.onboarding || {}), sourceSetup: { sourceId, idx: 0, config: {} } } })
  if (!s.setup?.length || s.setup.every(x => x.type === 'install-app')) return sourceStep(ctx, c, ctx.people.get(p.id), null)
  await c.reply(`*${escapeMdV2(s.name)}*\n${escapeMdV2(s.description)}`, { parse_mode: 'MarkdownV2' })
  return askSetupStep(ctx, c, ctx.people.get(p.id))
}
async function askSetupStep(ctx, c, p) {
  const ss = p.onboarding.sourceSetup, s = ctx.plugins.sources[ss.sourceId], step = s.setup[ss.idx]
  if (step.type === 'choice') {
    const kb = new InlineKeyboard(); for (const ch of step.choices) kb.text(ch, `srcc:${encodeURIComponent(ch)}`).row()
    return c.reply(step.label, { reply_markup: kb })
  }
  return c.reply(setupPrompt(step))
}
async function sourceStep(ctx, c, p, text) {
  const ss = p.onboarding.sourceSetup, s = ctx.plugins.sources[ss.sourceId]
  if (text && /^cancel$/i.test(text)) { ctx.people.update(p.id, { onboarding: { ...p.onboarding, sourceSetup: null } }); return c.reply(`Ok, left ${s.name} alone.`) }
  const step = s.setup?.[ss.idx]
  if (step) {
    const r = applySetupStep(step, text)
    if (!r.ok) return c.reply(r.error)
    if (!r.unset) ss.config[step.key] = r.value
    ss.idx++
    if (ss.idx < s.setup.length) { ctx.people.update(p.id, { onboarding: { ...p.onboarding, sourceSetup: ss } }); return askSetupStep(ctx, c, ctx.people.get(p.id)) }
  }
  const sc = ctx.sources.connect(p.id, s.id, ss.config)
  ctx.people.update(p.id, { onboarding: { ...p.onboarding, sourceSetup: null } })
  let msg = `${s.name} connected.`
  const installStep = s.setup?.find(x => x.type === 'install-app')
  if (installStep) {
    msg += `\n\n${installStep.label}\n\nCode: ${ctx.sources.linkCode(sc)}   (15 min)\n\nOr paste this URL into it:\n${ctx.sources.ingestUrl(sc)}`
  } else if (s.ingest) {
    const instr = s.setup?.find(x => x.type === 'choice')?.instructions?.[ss.config.app] || ''
    msg += `\n\n${instr}\n\nYour URL:\n${ctx.sources.ingestUrl(sc)}`
  }
  if (s.poll) {
    // first fetch for just this config (not every due source on the node)
    try {
      const obs = await s.poll(ctx, p, sc.config, null)
      await ctx.observations.ingest(p.id, s.id, obs)
      ctx.db.run('update source_configs set last_poll_at = ?, last_error = null where id = ?', new Date().toISOString(), sc.id)
      const n = ctx.db.get('select count(*) c from observations where person_id = ? and source_id = ?', p.id, s.id)?.c ?? 0
      msg += ` Found ${n} items so far.`
    } catch (e) {
      ctx.db.run('update source_configs set last_poll_at = ?, last_error = ? where id = ?', new Date().toISOString(), e.message, sc.id)
      msg += ` (First fetch failed: ${e.message})`
    }
  }
  await c.reply(msg)
  if (p.onboarding.step === 'sources') return c.reply('Add another, or say "done".')
}
