import { Bot, InlineKeyboard } from 'grammy'

// Telegram: onboarding, nudges with action buttons, and chat with your agent.
let bot, me
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
      if (!p) {
        p = ctx.people.create({ displayName: [c.from.first_name, c.from.last_name].filter(Boolean).join(' ') })
        ctx.people.bind(p.id, 'telegram', c.from.id, { username: c.from.username })
        const inv = code && ctx.people.peekInvite(code)
        const inviter = inv && ctx.people.get(inv.inviter_id)
        ctx.people.update(p.id, { onboarding: { step: 'name', pendingInvite: inv ? code : null } })
        await c.reply(inviter
          ? `Hi. ${inviter.display_name} wants to see more of you, and asked me to help make that cheap.\n\nI'm opportune: I notice when hanging out would be easy (same event, a block away, both free Thursday) and nudge you. Only people who opt in to each other. Nothing public.\n\nWhat should I call you? (${p.display_name}?)`
          : `Hi. I'm opportune: I notice when hanging out with your people would be cheap, and nudge you.\n\nWhat should I call you? (${p.display_name}?)`)
        return
      }
      if (code) {
        const inviter = ctx.people.acceptInvite(code, p.id)
        return c.reply(inviter ? `Linked you with ${inviter.display_name}.` : 'That invite is used up or expired.')
      }
      await c.reply(`Hey ${p.display_name}. Say "who's around tonight?", "I'm home and open", or /help.`)
    })

    bot.command('help', c => c.reply(`Just talk to me. Or:\n/whosaround — who's plausibly free\n/porchlight — open/closed/ask for drop-ins\n/invite Name — one-time link for someone you want more of\n/friends — your people\n/sources — connect calendar, location, …\n/review — rate my recent calls\n/me — what I know about you right now`))

    bot.command('whosaround', async c => { const p = whoami(c); if (!p) return; await c.replyWithChatAction('typing'); c.reply(await ctx.agent.chat(p.id, `Who's around ${c.match || 'this evening'}? Give me a shortlist.`)) })
    bot.command('me', async c => { const p = whoami(c); if (!p) return; const obs = ctx.observations.recent(p.id, { limit: 8 }); c.reply(obs.length ? obs.map(o => `${o.kind} ${o.at.slice(0, 16)} ${JSON.stringify(o.data).slice(0, 120)}`).join('\n') : 'Nothing yet. /sources to connect something.') })
    bot.command('friends', async c => {
      const p = whoami(c); if (!p) return
      const fs = ctx.people.friendsOf(p.id)
      c.reply(fs.length ? fs.map(f => `${f.want_more ? '★' : '·'} ${f.display_name} (${f.tier}${f.remote ? ', remote' : ''})${f.note ? ` — ${f.note}` : ''}`).join('\n') + '\n\n★ = you want more of them. Tell me to change any of this.' : 'No one yet. /invite Name to make a link.')
    })
    bot.command('invite', async c => {
      const p = whoami(c); if (!p) return
      const name = c.match?.trim()
      if (!name) return c.reply('Who? e.g. /invite Eileen')
      const { url } = ctx.people.invite(p.id, { inviteeName: name })
      c.reply(`One-time link for ${name}:\n${url}\n\nIt says you want to see more of them. Send it however you like.`)
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
      for (const r of rows) {
        await c.reply(`${r.verdict === 'suppress' ? '🤫' : '🔔'} ${r.summary}\n_${r.reasoning}_${r.rating ? `\n(rated ${r.rating})` : ''}`, { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('👍 good call', `rate:${r.id}:good`).text('👎 bad call', `rate:${r.id}:bad`) })
      }
    })

    bot.on('message:location', async c => {
      const p = whoami(c); if (!p) return
      const { latitude: lat, longitude: lng } = c.message.location
      if (p.onboarding?.step === 'home') {
        ctx.people.addPlace(p.id, { name: 'home', lat, lng, radiusM: 120 })
        await ctx.observations.ingest(p.id, 'manual', [{ kind: 'location', data: { lat, lng, placeName: 'home' } }])
        return advance(ctx, c, p, 'sources')
      }
      await ctx.observations.ingest(p.id, 'manual', [{ kind: 'location', data: { lat, lng } }])
      c.reply('Got it.')
    })

    bot.on('message:contact', async c => {
      const p = whoami(c); if (!p) return
      if (c.message.contact.user_id === c.from.id) {
        ctx.people.bind(p.id, 'phone', c.message.contact.phone_number)
        await c.reply('Got it.', { reply_markup: { remove_keyboard: true } })
        if (p.onboarding?.step === 'phone') return advance(ctx, c, p, 'home')
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
      const [t, a, b] = d.split(':')
      if (t === 'n') {                      // nudge action
        const n = await ctx.nudges.respond(a, b === 'wish' ? `wish:${d.split(':')[3]}` : b)
        if (b === 'bad') return c.reply('Noted. Fewer of those.')
        if (b === 'yes') return c.reply('Go get it.')
        if (b === 'wish') { ctx.judge.rate(d.split(':')[3], 'good', 'person wished they had been told'); return c.reply("Noted. I'll speak up about that kind of thing.") }
        return
      }
      if (t === 'wish') { ctx.judge.rate(a, 'good', 'person wished they had been told'); return c.reply("Noted. I'll speak up about that kind of thing.") }
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
    for (const a of nudge.actions || []) kb.text(a.label, a.key.startsWith('wish:') ? `wish:${a.key.slice(5)}` : `n:${nudge.id}:${a.key}`)
    const m = await bot.api.sendMessage(identity.external_id, nudge.text, { reply_markup: (nudge.actions || []).length ? kb : undefined })
    return { externalId: String(m.message_id) }
  },
}

// ---------- onboarding ----------
async function advance(ctx, c, p, step) {
  ctx.people.update(p.id, { onboarding: { ...(ctx.people.get(p.id).onboarding || {}), step } })
  if (step === 'phone') return c.reply(`Share your phone number? Only used so friends who have you in their contacts get told you're here. Or say "skip".`, { reply_markup: { keyboard: [[{ text: 'Share my number', request_contact: true }]], one_time_keyboard: true, resize_keyboard: true } })
  if (step === 'home') return c.reply(`Where's home? Share a location (📎 → Location), or say "skip".`)
  if (step === 'sources') return sourcesMenu(ctx, c, ctx.people.get(p.id), true)
  if (step === 'wantmore') return c.reply(`Who do you want to see more of? Names, comma-separated. I'll make a one-time invite link for each. Or "skip".`)
  if (step === 'porchlight') return c.reply(`Drop-ins at your place: when are they generally welcome?`, { reply_markup: new InlineKeyboard().text('Weekday evenings', 'ob:pl:evenings').text('Weekends', 'ob:pl:weekends').row().text('Ask me each time', 'ob:pl:ask').text('Not really', 'ob:pl:closed') })
  if (step === 'done') {
    ctx.people.update(p.id, { onboarding: { step: 'done' } })
    return c.reply(`That's it. I'll stay quiet unless something's worth it, and each morning I'll show you what I kept quiet about so you can correct me.\n\nTry: "who's around tonight?" or "I'm home and open till 9".`)
  }
}
async function onboard(ctx, c, p, text) {
  const ob = p.onboarding
  if (ob.step === 'name') {
    if (text && !/^(yes|yep|sure|ok|that's fine|y)$/i.test(text)) ctx.people.update(p.id, { displayName: text.replace(/[^\w\s'.-]/g, '').slice(0, 40) })
    if (ob.pendingInvite) { const inviter = ctx.people.acceptInvite(ob.pendingInvite, p.id); if (inviter) await c.reply(`Linked with ${inviter.display_name}.`) }
    return advance(ctx, c, p, 'phone')
  }
  if (ob.step === 'phone') { if (/skip/i.test(text)) return advance(ctx, c, p, 'home'); return c.reply('Tap the button to share, or say "skip".') }
  if (ob.step === 'home') { if (/skip/i.test(text)) return advance(ctx, c, p, 'sources'); return c.reply('Share a location (📎 → Location) or say "skip".') }
  if (ob.step === 'sources') { if (/skip|done|next/i.test(text)) return advance(ctx, c, p, 'wantmore'); if (ob.sourceSetup) return sourceStep(ctx, c, p, text); return c.reply('Pick one above, or "done".') }
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
async function onboardChoice(ctx, c, p, a, b) {
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
  await c.reply(onboarding ? `Hook up what you like. Each is one step; you can add more later with /sources. Say "done" when finished.` : 'Sources:', { reply_markup: kb })
}
async function beginSource(ctx, c, p, sourceId) {
  const s = ctx.plugins.sources[sourceId]
  if (!s) return
  ctx.people.update(p.id, { onboarding: { ...(p.onboarding || {}), sourceSetup: { sourceId, idx: 0, config: {} } } })
  if (!s.setup?.length) return sourceStep(ctx, c, ctx.people.get(p.id), null)
  await c.reply(`*${s.name}*\n${s.description}`, { parse_mode: 'Markdown' })
  return askSetupStep(ctx, c, ctx.people.get(p.id))
}
async function askSetupStep(ctx, c, p) {
  const ss = p.onboarding.sourceSetup, s = ctx.plugins.sources[ss.sourceId], step = s.setup[ss.idx]
  if (step.type === 'choice') {
    const kb = new InlineKeyboard(); for (const ch of step.choices) kb.text(ch, `srcc:${encodeURIComponent(ch)}`).row()
    return c.reply(step.label, { reply_markup: kb })
  }
  return c.reply(step.label)
}
async function sourceStep(ctx, c, p, text) {
  const ss = p.onboarding.sourceSetup, s = ctx.plugins.sources[ss.sourceId]
  const step = s.setup?.[ss.idx]
  if (step) {
    if (step.type === 'choice' && !step.choices.includes(text)) return c.reply('Tap one of the options.')
    ss.config[step.key] = step.parse ? step.parse(text) : text
    ss.idx++
    if (ss.idx < s.setup.length) { ctx.people.update(p.id, { onboarding: { ...p.onboarding, sourceSetup: ss } }); return askSetupStep(ctx, c, ctx.people.get(p.id)) }
  }
  const sc = ctx.sources.connect(p.id, s.id, ss.config)
  ctx.people.update(p.id, { onboarding: { ...p.onboarding, sourceSetup: null } })
  let msg = `${s.name} connected.`
  if (s.ingest) {
    const instr = s.setup?.find(x => x.type === 'choice')?.instructions?.[ss.config.app] || ''
    msg += `\n\n${instr}\n\nYour URL:\n${ctx.sources.ingestUrl(sc)}`
  }
  if (s.poll) { try { await ctx.sources.pollDue(); const n = ctx.observations.recent(p.id, { limit: 200 }).filter(o => o.source_id === s.id).length; msg += ` Found ${n} items so far.` } catch (e) { msg += ` (First fetch failed: ${e.message})` } }
  await c.reply(msg)
  if (p.onboarding.step === 'sources') return c.reply('Add another, or say "done".')
}
