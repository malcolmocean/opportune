import Anthropic from '@anthropic-ai/sdk'
import { log } from './log.js'
const L = log('llm')

export function makeLlm(env) {
  const client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null
  const judgeModel = env.JUDGE_MODEL || 'claude-opus-5-5'
  const agentModel = env.AGENT_MODEL || 'claude-opus-5-5'
  return {
    enabled: !!client,
    // Plain completion. Returns text.
    async complete({ system, messages, model, maxTokens = 1024 }) {
      if (!client) { L.warn('no ANTHROPIC_API_KEY; returning stub'); return '' }
      const r = await client.messages.create({ model: model || judgeModel, max_tokens: maxTokens, system, messages })
      return r.content.filter(b => b.type === 'text').map(b => b.text).join('')
    },
    // Ask for JSON matching a loose shape; tolerant parse.
    async json({ system, messages, model, maxTokens = 1024 }) {
      const text = await this.complete({ system: system + '\n\nRespond with a single JSON object and nothing else.', messages, model, maxTokens })
      const m = text.match(/\{[\s\S]*\}/)
      try { return m ? JSON.parse(m[0]) : null } catch { L.warn('bad json from model:', text.slice(0, 200)); return null }
    },
    // Tool-use loop. tools: [{ name, description, input_schema, run(input) }]
    async agent({ system, messages, tools = [], model, maxTokens = 2048, maxTurns = 8 }) {
      if (!client) return { text: '(LLM not configured: set ANTHROPIC_API_KEY)', messages }
      const defs = tools.map(({ run, ...t }) => t)
      let msgs = [...messages]
      for (let i = 0; i < maxTurns; i++) {
        const r = await client.messages.create({ model: model || agentModel, max_tokens: maxTokens, system, messages: msgs, tools: defs.length ? defs : undefined })
        msgs.push({ role: 'assistant', content: r.content })
        if (r.stop_reason !== 'tool_use') {
          return { text: r.content.filter(b => b.type === 'text').map(b => b.text).join(''), messages: msgs }
        }
        const results = []
        for (const b of r.content.filter(b => b.type === 'tool_use')) {
          const tool = tools.find(t => t.name === b.name)
          let out
          try { out = await tool.run(b.input) } catch (e) { out = { error: e.message } }
          results.push({ type: 'tool_result', tool_use_id: b.id, content: typeof out === 'string' ? out : JSON.stringify(out) })
        }
        msgs.push({ role: 'user', content: results })
      }
      return { text: '(gave up after too many tool calls)', messages: msgs }
    },
  }
}
