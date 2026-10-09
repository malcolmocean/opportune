import { createPublicKey, createPrivateKey, sign, verify, createHash, randomBytes } from 'node:crypto'
import { capabilities } from './plugins.js'
import { log } from './log.js'
const L = log('fed')

// Signed requests between nodes. Each person has an ed25519 keypair; a request is
// signed by the person it's "from". Transport privacy is TLS's job; we only sign.
const canon = ({ method, path, ts, nonce, body }) => `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${createHash('sha256').update(body || '').digest('hex')}`

export function makeFederation(db, ctx) {
  const F = {
    wellKnown() {
      return { node: ctx.people.nodeUrl, protocol: 'opportune/0.1', capabilities: capabilities(ctx.plugins), repo: 'https://github.com/malcolmocean/opportune' }
    },
    signHeaders(person, method, path, body) {
      const ts = String(Date.now()), nonce = randomBytes(8).toString('hex')
      const key = createPrivateKey({ key: Buffer.from(person.privkey, 'base64'), format: 'der', type: 'pkcs8' })
      const sig = sign(null, Buffer.from(canon({ method, path, ts, nonce, body })), key).toString('base64')
      return { 'content-type': 'application/json', 'x-opportune-from': person.id, 'x-opportune-node': ctx.people.nodeUrl, 'x-opportune-ts': ts, 'x-opportune-nonce': nonce, 'x-opportune-sig': sig }
    },
    // Express middleware: verifies the signature against the stored pubkey of the sender.
    verify(req, res, next) {
      const from = req.get('x-opportune-from'), ts = req.get('x-opportune-ts'), nonce = req.get('x-opportune-nonce'), sig = req.get('x-opportune-sig')
      if (!from || !ts || !nonce || !sig) return res.status(401).json({ error: 'unsigned' })
      if (Math.abs(Date.now() - Number(ts)) > 5 * 60e3) return res.status(401).json({ error: 'stale' })
      const seen = db.kvGet(`nonce:${nonce}`); if (seen) return res.status(401).json({ error: 'replay' })
      db.kvSet(`nonce:${nonce}`, ts)
      const person = ctx.people.get(from)
      if (!person?.pubkey) return res.status(401).json({ error: 'unknown sender' })
      const key = createPublicKey({ key: Buffer.from(person.pubkey, 'base64'), format: 'der', type: 'spki' })
      const ok = verify(null, Buffer.from(canon({ method: req.method, path: req.path, ts, nonce, body: req.rawBody })), key, Buffer.from(sig, 'base64'))
      if (!ok) return res.status(401).json({ error: 'bad signature' })
      req.fromPerson = person
      next()
    },
    async post(fromPerson, nodeUrl, path, payload) {
      const body = JSON.stringify(payload)
      const r = await fetch(nodeUrl + path, { method: 'POST', headers: F.signHeaders(fromPerson, 'POST', path, body), body })
      if (!r.ok) throw new Error(`${nodeUrl}${path} → ${r.status}`)
      return r.json()
    },
    async ask(remotePerson, { from, kind, text, window, context }) {
      const me = ctx.people.get(from)
      try {
        const ans = await F.post(me, remotePerson.node_url, '/q', { to: remotePerson.id, kind, text, window, context })
        if (ans.answer === 'unsupported' && ans.suggest) ctx.events.emit('federation:suggest', { from: remotePerson, to: me, suggest: ans.suggest, kind })
        return ans
      } catch (e) { L.warn('remote ask failed', e.message); return { answer: 'unsupported', reason: e.message } }
    },
    async deliverNudge(remotePerson, nudge) {
      // Nudge to someone on another node: their node renders it through their channels.
      const me = ctx.people.all().find(p => !p.remote)   // node identity for signing; fine for v1
      return F.post(me, remotePerson.node_url, '/nudge', { to: remotePerson.id, ...nudge })
    },
    // Accepting an invite across nodes: joiner's node calls inviter's node.
    async acceptRemoteInvite(joiner, inviteUrl) {
      const u = new URL(inviteUrl), code = u.pathname.split('/').pop(), nodeUrl = u.origin
      const info = await fetch(`${nodeUrl}/.well-known/opportune`).then(r => r.json())
      const body = JSON.stringify({ code, joiner: { id: joiner.id, displayName: joiner.display_name, pubkey: joiner.pubkey, nodeUrl: ctx.people.nodeUrl } })
      const r = await fetch(`${nodeUrl}/friend/accept`, { method: 'POST', headers: F.signHeaders(joiner, 'POST', '/friend/accept', body), body }).then(r => r.json())
      if (r.error) throw new Error(r.error)
      // store inviter as a remote person
      if (!ctx.people.get(r.inviter.id)) ctx.people.create({ id: r.inviter.id, displayName: r.inviter.displayName, remote: true, nodeUrl, pubkey: r.inviter.pubkey })
      ctx.people.setRel(joiner.id, r.inviter.id, { tier: r.tier, wantMore: false })
      ctx.people.setRel(r.inviter.id, joiner.id, { tier: r.tier, wantMore: !!r.wantMore })
      return { inviter: ctx.people.get(r.inviter.id), capabilities: info.capabilities }
    },
    // Inviter's node side of the above.
    acceptIncoming({ code, joiner }) {
      const inv = ctx.people.peekInvite(code)
      if (!inv) return { error: 'invalid or used invite' }
      if (!ctx.people.get(joiner.id)) ctx.people.create({ id: joiner.id, displayName: joiner.displayName, remote: true, nodeUrl: joiner.nodeUrl, pubkey: joiner.pubkey })
      const inviter = ctx.people.acceptInvite(code, joiner.id)
      return { inviter: { id: inviter.id, displayName: inviter.display_name, pubkey: inviter.pubkey }, tier: inv.tier, wantMore: !!inv.want_more }
    },
  }
  return F
}
