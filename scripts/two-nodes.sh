#!/usr/bin/env bash
# Run two opportune nodes side by side to poke at federation by hand.
#
#   scripts/two-nodes.sh            # start node A (:3401) and node B (:3402), keep them up
#   scripts/two-nodes.sh --demo     # also: Alice on A invites Bob on B, Bob accepts over
#                                   # HTTP, Alice asks Bob's node "free tonight?", A nudges Bob
#   scripts/two-nodes.sh --reset    # wipe data/two-nodes/ first
#
# Each node gets its own sqlite file under data/two-nodes/. The LLM and Telegram are left
# OFF (no .env is loaded) so the demo is deterministic; export ANTHROPIC_API_KEY yourself
# if you want the Judge/answerer to think. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."

A_PORT=${A_PORT:-3401}; B_PORT=${B_PORT:-3402}
A_URL="http://127.0.0.1:$A_PORT"; B_URL="http://127.0.0.1:$B_PORT"
DATA=data/two-nodes
DEMO=0
for arg in "$@"; do
  case "$arg" in
    --demo) DEMO=1 ;;
    --reset) rm -rf "$DATA" ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done
mkdir -p "$DATA"

start() {  # name url port
  env -i PATH="$PATH" HOME="$HOME" NODE_NO_WARNINGS=1 NODE_URL="$2" PORT="$3" DB_PATH="$DATA/$1.db" \
    ${ANTHROPIC_API_KEY:+ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"} \
    node server.js 2>&1 | sed -u "s/^/[$1] /" &
}
start a "$A_URL" "$A_PORT"
start b "$B_URL" "$B_PORT"
trap 'echo; echo "stopping both nodes"; pkill -P $$ 2>/dev/null || true; wait 2>/dev/null || true' EXIT INT TERM

wait_up() {
  for _ in $(seq 1 100); do curl -fsS "$1/api/health" >/dev/null 2>&1 && return 0; sleep 0.1; done
  echo "node at $1 never came up" >&2; exit 1
}
wait_up "$A_URL"; wait_up "$B_URL"
echo
echo "node A  $A_URL   db $DATA/a.db"
echo "node B  $B_URL   db $DATA/b.db"
echo "capabilities: curl $A_URL/.well-known/opportune | jq .capabilities.queries"
echo

if [ "$DEMO" = 1 ]; then
  # Drive both nodes' contexts from one process (same sqlite files, WAL); the cross-node
  # calls still go over HTTP to the servers above and are signed/verified.
  A_URL="$A_URL" B_URL="$B_URL" DATA="$DATA" NODE_NO_WARNINGS=1 node --input-type=module <<'EOF'
import { buildContext } from './core/context.js'
const { A_URL, B_URL, DATA } = process.env
const A = await buildContext({ NODE_URL: A_URL }, { dbPath: `${DATA}/a.db` })
const B = await buildContext({ NODE_URL: B_URL }, { dbPath: `${DATA}/b.db` })
const find = (ctx, name) => ctx.people.all().find(p => p.display_name === name) || ctx.people.create({ displayName: name })
const alice = find(A, 'Alice'), bob = find(B, 'Bob')
const say = (label, v) => console.log(`\n== ${label}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)

if (!A.people.rel(alice.id, bob.id)) {
  const inv = A.people.invite(alice.id, { inviteeName: 'Bob', wantMore: true })
  say('Alice (A) makes a one-time invite', inv.url)
  const acc = await B.federation.acceptRemoteInvite(bob, inv.url)
  say('Bob (B) accepts it: B now knows the inviter', { id: acc.inviter.id, name: acc.inviter.display_name, remote: acc.inviter.remote, node: acc.inviter.node_url, pubkey: acc.inviter.pubkey.slice(0, 16) + '…' })
  say('reusing the code', await fetch(`${A_URL}/friend/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: inv.code, joiner: { id: 'x', displayName: 'Mallory', pubkey: bob.pubkey, nodeUrl: B_URL } }) }).then(r => r.json()))
} else say('already linked', `${alice.display_name}@A ↔ ${bob.display_name}@B`)

say('A asks B: availability, before Bob has any data', await A.query.ask({ from: alice.id, to: bob.id, kind: 'availability', text: 'free tonight?' }))
const start = new Date(Date.now() + 3600e3), end = new Date(Date.now() + 3 * 3600e3)
await B.observations.ingest(bob.id, 'manual', [{ kind: 'event', at: start.toISOString(), until: end.toISOString(), dedupeKey: 'two-nodes-demo', data: { title: 'Dinner with Sam', provider: 'manual', busy: true } }])
say('B gives Bob a dinner tonight; A asks again', await A.query.ask({ from: alice.id, to: bob.id, kind: 'availability', text: 'free tonight?' }))
say('A asks a kind Bob\'s node has no plugin for', await A.query.ask({ from: alice.id, to: bob.id, kind: 'nonexistent', text: '?' }))
const body = JSON.stringify({ to: bob.id, kind: 'availability', text: 'free tonight?' })
const h = A.federation.signHeaders(alice, 'POST', '/q', body)
const once = await fetch(`${B_URL}/q`, { method: 'POST', headers: h, body })
const twice = await fetch(`${B_URL}/q`, { method: 'POST', headers: h, body })
say('same signed request twice', { first: once.status, second: twice.status, secondBody: await twice.json() })
const n = await A.nudges.send(bob.id, { text: 'Alice asked if you were free; I said unlikely. Veto?', actions: [{ key: 'no', label: 'Veto' }] })
say('A nudges Bob through B\'s /nudge; row on B', { posted: n, onB: B.nudges.get(n.id) })
console.log('\nnodes still running; Ctrl-C to stop\n')
EOF
fi

wait
